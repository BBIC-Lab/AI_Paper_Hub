import pathlib
import sys
import unittest


class PipelineDiagnosticsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = pathlib.Path(__file__).resolve().parents[1]
        src_dir = root / "src"
        if str(src_dir) not in sys.path:
            sys.path.insert(0, str(src_dir))
        from core import diagnostics

        cls.diag = diagnostics

    def test_annotates_stage_ranks_from_scores_and_ranked_items(self):
        papers = [{"id": "p-1"}, {"id": "p-2"}]
        queries = [
            {
                "query_text": "time-series methods",
                "paper_tag": "ai4nd",
                "query_track": "inspiration",
                "sim_scores": {
                    "p-1": {"rank": 2, "score": 0.42},
                    "p-2": {"rank": 1, "score": 0.91},
                },
            },
            {
                "query_text": "bridge methods",
                "paper_tag": "ai4nd",
                "ranked": [
                    {"paper_id": "p-1", "rerank_rank": 1, "score": 0.8, "rerank_track": "bridge"}
                ],
            },
        ]

        self.diag.annotate_stage_ranks(papers, queries, "rerank")

        stage = papers[0]["diagnostics"]["stage_ranks"]["rerank"]
        self.assertEqual(stage["best_rank"], 1)
        self.assertEqual(stage["best_query"], "bridge methods")
        self.assertEqual(stage["hits"][0]["track"], "bridge")

    def test_merge_preserves_previous_stage_hits(self):
        target = {"id": "p-1"}
        source = {"id": "p-1"}
        self.diag.annotate_stage_ranks(
            [target],
            [{"query_text": "old", "sim_scores": {"p-1": {"rank": 2, "score": 0.4}}}],
            "bm25",
        )
        self.diag.annotate_stage_ranks(
            [source],
            [{"query_text": "new", "sim_scores": {"p-1": {"rank": 1, "score": 0.9}}}],
            "bm25",
        )

        self.diag.merge_paper_diagnostics(target, source)

        hits = target["diagnostics"]["stage_ranks"]["bm25"]["hits"]
        self.assertEqual([hit["query"] for hit in hits], ["new", "old"])


if __name__ == "__main__":
    unittest.main()
