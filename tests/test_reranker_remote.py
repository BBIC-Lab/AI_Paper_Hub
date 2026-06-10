import os
import unittest
from unittest.mock import MagicMock, patch

from src.reranker import (
    OpenAIReranker,
    create_reranker_from_env,
    load_remote_rerank_settings,
    normalize_rerank_endpoint,
)


class RemoteRerankerTest(unittest.TestCase):
    def test_normalize_rerank_endpoint(self):
        self.assertEqual(
            normalize_rerank_endpoint("https://rerank.example.test/v1"),
            "https://rerank.example.test/v1/rerank",
        )
        self.assertEqual(
            normalize_rerank_endpoint("https://rerank.example.test/v1/rerank"),
            "https://rerank.example.test/v1/rerank",
        )

    @patch("src.reranker.requests.post")
    def test_openai_reranker_posts_expected_payload_and_parses_scores(self, mock_post):
        resp = MagicMock()
        resp.raise_for_status.return_value = None
        resp.json.return_value = {
            "results": [
                {"index": 1, "score": 0.7},
                {"index": 0, "relevance_score": 0.9},
            ]
        }
        mock_post.return_value = resp

        reranker = OpenAIReranker(
            endpoint="https://rerank.example.test/v1",
            model="Qwen/Qwen3-Reranker-0.6B",
            api_key="secret",
            timeout=45,
        )
        result = reranker.rerank(query="q", documents=["d0", "d1"], top_n=2)

        self.assertEqual(
            mock_post.call_args.kwargs["json"],
            {
                "model": "Qwen/Qwen3-Reranker-0.6B",
                "query": "q",
                "documents": ["d0", "d1"],
                "top_n": 2,
            },
        )
        self.assertEqual(mock_post.call_args.kwargs["headers"]["Authorization"], "Bearer secret")
        self.assertEqual(mock_post.call_args.kwargs["timeout"], 45)
        self.assertEqual(
            result,
            {
                "results": [
                    {"index": 1, "relevance_score": 0.7},
                    {"index": 0, "relevance_score": 0.9},
                ]
            },
        )

    @patch.dict(
        os.environ,
        {
            "DPR_RERANK_PROVIDER": "openai",
            "RERANK_ENDPOINT": "https://rerank.example.test/v1",
            "RERANK_API_KEY": "secret",
            "DPR_RERANK_MODEL": "Qwen/Qwen3-Reranker-0.6B",
        },
        clear=True,
    )
    def test_load_remote_rerank_settings_uses_aliases(self):
        settings = load_remote_rerank_settings()

        self.assertIsNotNone(settings)
        self.assertEqual(settings.provider, "openai")
        self.assertEqual(settings.endpoint, "https://rerank.example.test/v1/rerank")
        self.assertEqual(settings.api_key, "secret")
        self.assertEqual(settings.model, "Qwen/Qwen3-Reranker-0.6B")

    @patch.dict(
        os.environ,
        {
            "DPR_RERANK_PROVIDER": "openai",
            "DPR_INFERENCE_BASE_URL": "https://private-host.example.test",
            "DPR_RERANK_ENDPOINT": "/v1/rerank",
            "DPR_RERANK_API_KEY": "secret",
            "DPR_RERANK_MODEL": "Qwen/Qwen3-Reranker-0.6B",
        },
        clear=True,
    )
    def test_rerank_allows_path_endpoint_with_base_url_and_redacts_logs(self):
        messages = []
        settings = load_remote_rerank_settings(log=messages.append)

        self.assertIsNotNone(settings)
        self.assertEqual(settings.endpoint, "https://private-host.example.test/v1/rerank")

        reranker, model = create_reranker_from_env(log=messages.append)
        self.assertEqual(reranker.endpoint, "https://private-host.example.test/v1/rerank")
        self.assertEqual(model, "Qwen/Qwen3-Reranker-0.6B")
        self.assertTrue(any("endpoint=/v1/rerank" in item for item in messages))
        self.assertFalse(any("private-host.example.test" in item for item in messages))


if __name__ == "__main__":
    unittest.main()
