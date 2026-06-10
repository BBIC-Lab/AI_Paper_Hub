import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from llm import LLMAuthenticationError, LLMClient


class LlmBaseUrlTest(unittest.TestCase):
    def _mock_response(self):
        resp = MagicMock()
        resp.raise_for_status.return_value = None
        resp.json.return_value = {
            "choices": [
                {
                    "message": {
                        "content": "ok",
                    }
                }
            ],
            "usage": {
                "prompt_tokens": 1,
                "completion_tokens": 1,
                "total_tokens": 2,
            },
        }
        return resp

    @patch("llm.requests.post")
    def test_chat_appends_v1_when_base_is_root(self, mock_post):
        mock_post.return_value = self._mock_response()
        client = LLMClient(
            api_key="test-key",
            model="gpt-4.1-mini",
            base_url="https://api.openai.com",
        )

        client.chat([{"role": "user", "content": "hello"}])

        self.assertEqual(
            mock_post.call_args.args[0],
            "https://api.openai.com/v1/chat/completions",
        )

    @patch("llm.requests.post")
    def test_chat_keeps_versioned_base(self, mock_post):
        mock_post.return_value = self._mock_response()
        client = LLMClient(
            api_key="test-key",
            model="gpt-4.1-mini",
            base_url="https://api.openai.com/v1",
        )

        client.chat([{"role": "user", "content": "hello"}])

        self.assertEqual(
            mock_post.call_args.args[0],
            "https://api.openai.com/v1/chat/completions",
        )

    @patch("llm.requests.post")
    def test_chat_uses_full_endpoint_directly(self, mock_post):
        mock_post.return_value = self._mock_response()
        client = LLMClient(
            api_key="test-key",
            model="gpt-4.1-mini",
            base_url="https://api.openai.com/v1/chat/completions",
        )

        client.chat([{"role": "user", "content": "hello"}])

        self.assertEqual(
            mock_post.call_args.args[0],
            "https://api.openai.com/v1/chat/completions",
        )

    def test_sanitize_error_detail_redacts_provider_key_echo(self):
        detail = {
            "error": {
                "message": "Incorrect credentials: api_key=badtoken123456789.",
                "code": "invalid_api_key",
            }
        }

        sanitized = LLMClient._sanitize_error_detail(detail)

        self.assertIn("[REDACTED]", sanitized["error"]["message"])
        self.assertNotIn("badtoken", sanitized["error"]["message"])

    @patch("llm.requests.post")
    def test_chat_auth_error_fails_fast(self, mock_post):
        resp = MagicMock()
        resp.status_code = 401
        resp.json.return_value = {
            "error": {
                "message": "Invalid credentials.",
                "code": "invalid_api_key",
            }
        }
        err = Exception("401 Client Error")
        err.response = resp
        resp.raise_for_status.side_effect = err
        mock_post.return_value = resp
        client = LLMClient(
            api_key="bad-token-for-test",
            model="gpt-4.1-mini",
            base_url="https://api.openai.com/v1",
        )

        with self.assertRaises(LLMAuthenticationError):
            client.chat([{"role": "user", "content": "hello"}])

        self.assertEqual(mock_post.call_count, 1)


if __name__ == "__main__":
    unittest.main()
