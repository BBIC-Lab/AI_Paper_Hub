import html
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path


class LocalPdfBackendScoringTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1]
        src_dir = root / "src"
        if str(src_dir) not in sys.path:
            sys.path.insert(0, str(src_dir))

        fitz_stub = types.ModuleType("fitz")
        fitz_stub.open = lambda *args, **kwargs: None
        sys.modules.setdefault("fitz", fitz_stub)

        paper_figures_stub = types.ModuleType("paper_figures")
        paper_figures_stub.ensure_paper_figures = lambda **kwargs: []
        paper_figures_stub.ensure_paper_figures_from_file = lambda **kwargs: []
        sys.modules.setdefault("paper_figures", paper_figures_stub)

        if "llm" not in sys.modules:
            llm_stub = types.ModuleType("llm")

            class DummyLLMClient:
                def __init__(self, *args, **kwargs):
                    self.kwargs = {}

            llm_stub.LLMClient = DummyLLMClient
            llm_stub.make_task_client = lambda *args, **kwargs: DummyLLMClient()
            sys.modules["llm"] = llm_stub

        spec = importlib.util.spec_from_file_location(
            "local_pdf_backend_mod",
            src_dir / "local_pdf_backend.py",
        )
        cls.mod = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(cls.mod)

    def test_apply_subscription_score_updates_paper_metadata(self):
        paper = {
            "id": "local-paper",
            "llm_score": "local",
            "canonical_evidence": "本地上传 PDF",
            "llm_tags": ["paper:本地PDF", "query:local-pdf"],
        }
        self.mod._apply_subscription_score(
            paper,
            {
                "score": 8.5,
                "canonical_evidence": "匹配当前订阅方向",
                "tldr_cn": "与订阅方向高度相关",
                "matched_query_tag": "query:neural-editing",
                "matched_query_text": "neural image editing",
            },
        )

        self.assertEqual(paper["llm_score"], 8.5)
        self.assertEqual(paper["score_label"], "订阅评分")
        self.assertEqual(paper["canonical_evidence"], "匹配当前订阅方向")
        self.assertEqual(paper["llm_tldr_cn"], "与订阅方向高度相关")
        self.assertIn("query:neural-editing", paper["llm_tags"])
        self.assertEqual(paper["matched_query_text"], "neural image editing")

    def test_sidebar_entry_writes_subscription_score_label(self):
        with tempfile.TemporaryDirectory() as tmp:
            sidebar = Path(tmp) / "_sidebar.md"
            sidebar.write_text("* Daily Papers\n", encoding="utf-8")

            self.mod._insert_local_sidebar_entry(
                str(sidebar),
                "local-pdf/20260527/demo-paper",
                "Demo Paper",
                "匹配当前订阅方向",
                score=8.5,
                score_label="订阅评分",
            )

            text = sidebar.read_text(encoding="utf-8")
            self.assertIn("data-sidebar-item=", text)
            encoded = text.split('data-sidebar-item="', 1)[1].split('"', 1)[0]
            payload = json.loads(html.unescape(encoded))
            self.assertEqual(payload["score"], "8.5 订阅评分")
            self.assertEqual(payload["evidence"], "匹配当前订阅方向")
            self.assertNotIn("reader_section", payload)


    def test_batch_manifest_loads_ordered_items_under_upload_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs = Path(tmp) / "docs"
            batch_dir = docs / "assets" / "local_pdfs" / "uploads" / "batch-1"
            batch_dir.mkdir(parents=True)
            pdf = batch_dir / "001-paper.pdf"
            pdf.write_bytes(b"%PDF-1.4")
            manifest = batch_dir / "manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "items": [
                            {
                                "client_id": "item-1",
                                "upload_path": str(pdf),
                                "original_filename": "paper.pdf",
                                "title_override": "Correct Title",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            _, items = self.mod._load_local_pdf_batch_manifest(
                manifest_path=str(manifest),
                docs_path=docs,
            )

            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]["client_id"], "item-1")
            self.assertEqual(items[0]["filename"], "paper.pdf")
            self.assertEqual(items[0]["title_override"], "Correct Title")
            self.assertEqual(items[0]["upload_path"], pdf.resolve())

    def test_batch_manifest_rejects_paths_outside_upload_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            docs = Path(tmp) / "docs"
            batch_dir = docs / "assets" / "local_pdfs" / "uploads" / "batch-1"
            batch_dir.mkdir(parents=True)
            outside = Path(tmp) / "outside.pdf"
            outside.write_bytes(b"%PDF-1.4")
            manifest = batch_dir / "manifest.json"
            manifest.write_text(
                json.dumps({"items": [{"upload_path": str(outside)}]}),
                encoding="utf-8",
            )

            with self.assertRaises(ValueError):
                self.mod._load_local_pdf_batch_manifest(
                    manifest_path=str(manifest),
                    docs_path=docs,
                )



if __name__ == "__main__":
    unittest.main()
