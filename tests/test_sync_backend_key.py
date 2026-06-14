import importlib.util
import pathlib
import sys
import unittest
from unittest.mock import patch


def _load_module(module_name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(module_name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


class SyncBackendKeyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = pathlib.Path(__file__).resolve().parents[1]
        src_dir = root / "src"
        if str(src_dir) not in sys.path:
            sys.path.insert(0, str(src_dir))
        cls.mod = _load_module("sync_supabase_mod", src_dir / "maintain" / "sync.py")

    def test_resolve_supabase_url_prefers_backend_key(self):
        cfg = {
            "source_backends": {
                "biorxiv": {
                    "url": "https://biorxiv.example.supabase.co",
                    "papers_table": "papers",
                }
            }
        }
        with patch.object(self.mod, "load_config", return_value=cfg):
            url = self.mod.resolve_supabase_url("", "biorxiv")
        self.assertEqual(url, "https://biorxiv.example.supabase.co")

    def test_resolve_papers_table_prefers_backend_key(self):
        cfg = {
            "source_backends": {
                "biorxiv": {
                    "url": "https://biorxiv.example.supabase.co",
                    "papers_table": "papers",
                }
            }
        }
        with patch.object(self.mod, "load_config", return_value=cfg):
            table = self.mod.resolve_papers_table("", "biorxiv")
        self.assertEqual(table, "papers")

    def test_resolve_default_raw_path_uses_biorxiv_prefix(self):
        path = self.mod.resolve_default_raw_path("20260318", "biorxiv")
        self.assertTrue(path.endswith("archive/20260318/raw/biorxiv_papers_20260318.json"))

    def test_normalize_paper_preserves_shadow_metadata_fields(self):
        row = self.mod.normalize_paper(
            {
                "id": "paper-1",
                "source_paper_id": "1234.56789",
                "doi": "10.1101/demo",
                "version": "v2",
                "title": "Demo",
                "abstract": "Abstract",
                "authors": ["A"],
                "source": "arxiv",
            }
        )
        self.assertEqual(row["source_paper_id"], "1234.56789")
        self.assertEqual(row["doi"], "10.1101/demo")
        self.assertEqual(row["version"], "v2")

    def test_build_embedding_text_can_truncate_long_text(self):
        row = {
            "title": "T" * 20,
            "abstract": "A" * 100,
        }
        text = self.mod.build_embedding_text(row, max_chars=40)
        self.assertLessEqual(len(text), 40)
        self.assertTrue(text.startswith("passage: Title: "))

    def test_iter_embedded_row_chunks_applies_text_max_chars(self):
        class DummyVector:
            def tolist(self):
                return [1.0, 0.0, 0.0]

        class DummyEmbeddings:
            def __init__(self, count):
                self.shape = (count, 3)
                self._items = [DummyVector() for _ in range(count)]

            def __len__(self):
                return len(self._items)

            def __getitem__(self, index):
                return self._items[index]

        class DummyModel:
            def __init__(self):
                self.seen_texts = []

            def encode(self, texts, **_kwargs):
                self.seen_texts.extend(texts)
                return DummyEmbeddings(len(texts))

        dummy = DummyModel()
        rows = [{"id": "p1", "title": "Title", "abstract": "A" * 200}]
        with patch.object(self.mod, "_load_embedding_model", return_value=dummy):
            chunks = list(
                self.mod.iter_embedded_row_chunks(
                    rows,
                    model_name="BAAI/bge-m3",
                    devices=["cpu"],
                    encode_batch_size=1,
                    stream_chunk_size=1,
                    max_length=0,
                    text_max_chars=64,
                    allow_remote=True,
                )
            )
        self.assertEqual(chunks[0][1], 3)
        self.assertEqual(len(dummy.seen_texts), 1)
        self.assertLessEqual(len(dummy.seen_texts[0]), 64)


if __name__ == "__main__":
    unittest.main()
