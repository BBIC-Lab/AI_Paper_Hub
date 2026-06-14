import importlib.util
import pathlib
import sys
import unittest
from unittest.mock import Mock, patch


def _load_module(module_name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(module_name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


class ExportSupabaseMetadataTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = pathlib.Path(__file__).resolve().parents[1]
        src_dir = root / "src"
        if str(src_dir) not in sys.path:
            sys.path.insert(0, str(src_dir))
        cls.mod = _load_module(
            "export_supabase_metadata_mod",
            src_dir / "maintain" / "export_supabase_metadata.py",
        )

    def _resp(self, rows, content_range="0-0/0"):
        resp = Mock()
        resp.status_code = 200
        resp.headers = {"Content-Range": content_range}
        resp.json.return_value = rows
        resp.text = ""
        return resp

    def _err(self, message, status=400):
        resp = Mock()
        resp.status_code = status
        resp.headers = {}
        resp.json.return_value = {"message": message}
        resp.text = message
        return resp

    def test_export_metadata_pages_without_embedding_columns(self):
        responses = [
            self._resp(
                [
                    {
                        "id": "p1",
                        "title": "One",
                        "embedding": [0.1],
                        "embedding_dim": 384,
                    },
                    {"id": "p2", "title": "Two"},
                ],
                "0-1/3",
            ),
            self._resp([{"id": "p3", "title": "Three"}], "2-2/3"),
        ]
        with patch.object(self.mod.requests, "get", side_effect=responses) as mock_get:
            rows, total = self.mod.export_metadata(
                url="https://example.supabase.co",
                api_key="key",
                table="arxiv_papers",
                page_size=2,
            )

        self.assertEqual(total, 3)
        self.assertEqual([row["id"] for row in rows], ["p1", "p2", "p3"])
        self.assertNotIn("embedding", rows[0])
        self.assertNotIn("embedding_dim", rows[0])
        first_params = mock_get.call_args_list[0].kwargs["params"]
        self.assertNotIn("embedding", first_params["select"])
        self.assertEqual(first_params["limit"], "2")

    def test_export_metadata_limit_stops_early(self):
        with patch.object(
            self.mod.requests,
            "get",
            return_value=self._resp([{"id": "p1"}, {"id": "p2"}], "0-1/10"),
        ) as mock_get:
            rows, total = self.mod.export_metadata(
                url="https://example.supabase.co",
                api_key="key",
                table="biorxiv_papers",
                page_size=1000,
                limit=2,
            )

        self.assertEqual(total, 10)
        self.assertEqual(len(rows), 2)
        self.assertEqual(mock_get.call_count, 1)

    def test_export_metadata_retries_without_missing_legacy_columns(self):
        responses = [
            self._err("column arxiv_papers.source_paper_id does not exist"),
            self._resp([{"id": "p1", "title": "One"}], "0-0/1"),
        ]
        with patch.object(self.mod.requests, "get", side_effect=responses) as mock_get:
            rows, total = self.mod.export_metadata(
                url="https://example.supabase.co",
                api_key="key",
                table="arxiv_papers",
                page_size=20,
            )

        self.assertEqual(total, 1)
        self.assertEqual(rows, [{"id": "p1", "title": "One"}])
        first_select = mock_get.call_args_list[0].kwargs["params"]["select"]
        second_select = mock_get.call_args_list[1].kwargs["params"]["select"]
        self.assertIn("source_paper_id", first_select)
        self.assertNotIn("source_paper_id", second_select)


if __name__ == "__main__":
    unittest.main()
