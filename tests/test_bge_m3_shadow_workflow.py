import pathlib
import unittest

import yaml


class BgeM3ShadowWorkflowTest(unittest.TestCase):
    def test_ab_workflow_points_to_shadow_tables_and_uploads_artifacts(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        path = root / ".github" / "workflows" / "daily-paper-reader-bge-m3-ab.yml"
        text = path.read_text(encoding="utf-8")
        workflow = yaml.safe_load(text) or {}
        job = workflow["jobs"]["ab"]
        env = job["env"]
        self.assertEqual(env["DPR_EMBED_MODEL"], "BAAI/bge-m3")
        self.assertEqual(env["DPR_ARXIV_PAPERS_TABLE"], "arxiv_papers_bge_m3")
        self.assertEqual(env["DPR_ARXIV_VECTOR_RPC_EXACT"], "match_arxiv_papers_bge_m3_exact")
        self.assertEqual(env["DPR_ENABLE_MULTI_SOURCE_RPC"], "false")
        self.assertEqual(env["DPR_ENABLE_BIORXIV_BACKEND"], "false")
        self.assertEqual(env["DPR_BIORXIV_ENABLED"], "false")
        self.assertNotIn("DPR_BIORXIV_PAPERS_TABLE", env)
        self.assertIn("python src/2.2.retrieval_papers_embedding.py", text)
        self.assertIn("actions/upload-artifact@v4", text)
        self.assertNotIn("git push", text)


if __name__ == "__main__":
    unittest.main()
