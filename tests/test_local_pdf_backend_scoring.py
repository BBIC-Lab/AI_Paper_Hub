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


if __name__ == "__main__":
    unittest.main()
