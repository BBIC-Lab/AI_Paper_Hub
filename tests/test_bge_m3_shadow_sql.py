import pathlib
import unittest


class BgeM3ShadowSqlTest(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(__file__).resolve().parents[1]
        self.schema_sql = (self.root / "sql" / "create_bge_m3_shadow_schema.sql").read_text(encoding="utf-8")
        self.index_sql = (self.root / "sql" / "create_bge_m3_shadow_hnsw_indexes.sql").read_text(encoding="utf-8")

    def test_schema_defines_1024_shadow_tables_and_rpcs(self):
        text = self.schema_sql
        self.assertIn("public.arxiv_papers_bge_m3", text)
        self.assertIn("public.biorxiv_papers_bge_m3", text)
        self.assertIn("embedding vector(1024)", text)
        self.assertIn("match_arxiv_papers_bge_m3_exact", text)
        self.assertIn("match_biorxiv_papers_bge_m3_exact", text)
        self.assertIn("match_multi_source_papers_bge_m3_exact", text)
        self.assertIn("multi_source_papers_bge_m3", text)

    def test_hnsw_indexes_are_separate_from_import_schema(self):
        self.assertNotIn("using hnsw", self.schema_sql.lower())
        self.assertIn("using hnsw", self.index_sql.lower())
        self.assertIn("arxiv_papers_bge_m3_embedding_hnsw_idx", self.index_sql)
        self.assertNotIn("biorxiv_papers_bge_m3_embedding_hnsw_idx", self.index_sql)


if __name__ == "__main__":
    unittest.main()
