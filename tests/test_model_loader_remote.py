import os
import unittest
from unittest.mock import MagicMock, patch

import numpy as np
import requests

from src.model_loader import (
    RemoteSentenceTransformer,
    is_remote_embedding_enabled,
    load_remote_embedding_settings,
    load_sentence_transformer,
    normalize_remote_embedding_profile,
)


class RemoteSentenceTransformerTest(unittest.TestCase):
    @patch("src.model_loader.requests.post")
    def test_remote_encode_batches_and_normalizes(self, mock_post):
        resp1 = MagicMock()
        resp1.raise_for_status.return_value = None
        resp1.json.return_value = {
            "embeddings": [
                [3.0, 4.0],
                [0.0, 5.0],
            ]
        }
        resp2 = MagicMock()
        resp2.raise_for_status.return_value = None
        resp2.json.return_value = {
            "embeddings": [
                [8.0, 6.0],
            ]
        }
        mock_post.side_effect = [resp1, resp2]

        model = RemoteSentenceTransformer(
            model_name="BAAI/bge-small-en-v1.5",
            endpoint="https://embed.example.test",
            api_key="test-key",
            timeout=30,
            default_batch_size=2,
        )
        arr = model.encode(
            ["a", "b", "c"],
            convert_to_numpy=True,
            normalize_embeddings=True,
            batch_size=2,
        )

        self.assertEqual(arr.shape, (3, 2))
        np.testing.assert_allclose(arr[0], np.asarray([0.6, 0.8], dtype=np.float32), atol=1e-6)
        np.testing.assert_allclose(arr[1], np.asarray([0.0, 1.0], dtype=np.float32), atol=1e-6)
        np.testing.assert_allclose(arr[2], np.asarray([0.8, 0.6], dtype=np.float32), atol=1e-6)
        self.assertEqual(mock_post.call_count, 2)
        first_call = mock_post.call_args_list[0]
        self.assertEqual(first_call.kwargs["json"], {"texts": ["a", "b"]})
        self.assertEqual(first_call.kwargs["headers"]["Authorization"], "Bearer test-key")
        self.assertEqual(first_call.kwargs["timeout"], 30)

    @patch("src.model_loader.requests.post")
    def test_openai_remote_encode_uses_embeddings_api_shape(self, mock_post):
        resp = MagicMock()
        resp.raise_for_status.return_value = None
        resp.json.return_value = {
            "data": [
                {"index": 1, "embedding": [0.0, 3.0]},
                {"index": 0, "embedding": [4.0, 0.0]},
            ]
        }
        mock_post.return_value = resp

        model = RemoteSentenceTransformer(
            model_name="BAAI/bge-m3",
            endpoint="https://vllm.example.test/v1",
            provider="openai",
            api_key="test-key",
            timeout=30,
        )
        arr = model.encode(["a", "b"], convert_to_numpy=True, normalize_embeddings=True, batch_size=8)

        self.assertEqual(model.endpoint, "https://vllm.example.test/v1/embeddings")
        np.testing.assert_allclose(arr[0], np.asarray([1.0, 0.0], dtype=np.float32), atol=1e-6)
        np.testing.assert_allclose(arr[1], np.asarray([0.0, 1.0], dtype=np.float32), atol=1e-6)
        first_call = mock_post.call_args
        self.assertEqual(first_call.kwargs["json"], {"model": "BAAI/bge-m3", "input": ["a", "b"]})
        self.assertEqual(first_call.kwargs["headers"]["Authorization"], "Bearer test-key")

    @patch("src.model_loader._load_local_sentence_transformer")
    @patch("src.model_loader.requests.post")
    def test_remote_encode_falls_back_to_local_model_when_remote_fails(self, mock_post, mock_load_local):
        mock_post.side_effect = requests.exceptions.Timeout("remote timeout")
        local_model = MagicMock()
        local_model.encode.return_value = np.asarray([[0.1, 0.2]], dtype=np.float32)
        mock_load_local.return_value = local_model

        model = RemoteSentenceTransformer(
            model_name="BAAI/bge-small-en-v1.5",
            endpoint="https://embed.example.test",
            api_key="test-key",
            timeout=30,
            default_batch_size=2,
        )
        arr = model.encode(
            ["a"],
            convert_to_numpy=True,
            normalize_embeddings=True,
            batch_size=2,
        )

        self.assertEqual(mock_post.call_count, 1)
        mock_load_local.assert_called_once()
        local_model.encode.assert_called_once()
        self.assertEqual(arr.shape, (1, 2))

    @patch("src.model_loader._load_local_sentence_transformer")
    @patch("src.model_loader.requests.post")
    def test_remote_failure_disables_remote_for_later_calls(self, mock_post, mock_load_local):
        mock_post.side_effect = requests.exceptions.Timeout("remote timeout")
        local_model = MagicMock()
        local_model.encode.side_effect = [
            np.asarray([[0.1, 0.2]], dtype=np.float32),
            np.asarray([[0.3, 0.4]], dtype=np.float32),
        ]
        mock_load_local.return_value = local_model

        model = RemoteSentenceTransformer(
            model_name="BAAI/bge-small-en-v1.5",
            endpoint="https://embed.example.test",
            api_key="test-key",
            timeout=30,
            default_batch_size=2,
        )

        arr1 = model.encode(["a"], convert_to_numpy=True, normalize_embeddings=True, batch_size=2)
        arr2 = model.encode(["b"], convert_to_numpy=True, normalize_embeddings=True, batch_size=2)

        self.assertEqual(mock_post.call_count, 1)
        mock_load_local.assert_called_once()
        self.assertEqual(local_model.encode.call_count, 2)
        self.assertFalse(model._remote_available)
        self.assertEqual(arr1.shape, (1, 2))
        self.assertEqual(arr2.shape, (1, 2))

    @patch.dict(
        os.environ,
        {
            "DPR_EMBED_API_URL": "https://embed.example.test",
            "DPR_EMBED_API_KEY": "env-key",
            "DPR_EMBED_API_TIMEOUT": "45",
        },
        clear=False,
    )
    def test_load_sentence_transformer_returns_remote_wrapper_from_env(self):
        model = load_sentence_transformer("BAAI/bge-small-en-v1.5", device="cpu")
        self.assertTrue(getattr(model, "is_remote", False))
        self.assertEqual(model.model_name, "BAAI/bge-small-en-v1.5")
        self.assertEqual(model.endpoint, "https://embed.example.test/embed")
        self.assertEqual(model.timeout, 45)
        self.assertEqual(model.api_key, "env-key")
        self.assertEqual(model.fallback, "local")

    @patch.dict(
        os.environ,
        {
            "DPR_EMBED_PROFILE": "custom",
            "DPR_EMBED_PROVIDER": "openai",
            "DPR_EMBED_ENDPOINT": "https://vllm.example.test/v1",
            "DPR_EMBED_API_KEY": "env-key",
        },
        clear=True,
    )
    def test_openai_embedding_settings_use_endpoint_alias(self):
        settings = load_remote_embedding_settings()

        self.assertIsNotNone(settings)
        self.assertEqual(settings.profile, "custom")
        self.assertEqual(settings.provider, "openai")
        self.assertEqual(settings.endpoint, "https://vllm.example.test/v1")
        self.assertEqual(settings.api_key, "env-key")

        model = load_sentence_transformer("BAAI/bge-m3", device="cpu")
        self.assertEqual(model.provider, "openai")
        self.assertEqual(model.endpoint, "https://vllm.example.test/v1/embeddings")

    @patch.dict(
        os.environ,
        {
            "DPR_EMBED_PROFILE": "default_remote",
            "DPR_EMBED_PROVIDER": "openai",
            "DPR_EMBED_ENDPOINT": "https://stale-custom.example.test/v1",
            "DPR_EMBED_API_KEY": "stale-key",
            "DPR_EMBED_REMOTE_FALLBACK": "fail",
        },
        clear=True,
    )
    def test_default_remote_profile_ignores_stale_custom_endpoint_alias(self):
        settings = load_remote_embedding_settings()

        self.assertIsNotNone(settings)
        self.assertEqual(settings.profile, "default_remote")
        self.assertEqual(settings.provider, "legacy")
        self.assertEqual(settings.endpoint, "https://embed.zwwen.online/embed")
        self.assertEqual(settings.api_key, "")
        self.assertEqual(settings.fallback, "local")

    @patch.dict(
        os.environ,
        {
            "DPR_EMBED_PROFILE": "custom",
            "DPR_EMBED_PROVIDER": "openai",
            "DPR_INFERENCE_BASE_URL": "https://private-host.example.test",
            "DPR_EMBED_ENDPOINT": "/v1/embeddings",
            "DPR_EMBED_API_KEY": "env-key",
        },
        clear=True,
    )
    def test_openai_embedding_allows_path_endpoint_with_base_url(self):
        messages = []
        settings = load_remote_embedding_settings(log=messages.append)

        self.assertIsNotNone(settings)
        self.assertEqual(settings.endpoint, "https://private-host.example.test/v1/embeddings")

        model = load_sentence_transformer("BAAI/bge-m3", device="cpu", log=messages.append)
        self.assertEqual(model.endpoint, "https://private-host.example.test/v1/embeddings")
        self.assertTrue(any("endpoint=/v1/embeddings" in item for item in messages))
        self.assertFalse(any("private-host.example.test" in item for item in messages))

    def test_normalize_remote_embedding_profile_aliases(self):
        self.assertEqual(normalize_remote_embedding_profile(""), "default_remote")
        self.assertEqual(normalize_remote_embedding_profile("default"), "default_remote")
        self.assertEqual(normalize_remote_embedding_profile("remote"), "default_remote")
        self.assertEqual(normalize_remote_embedding_profile("local"), "local")
        self.assertEqual(normalize_remote_embedding_profile("custom"), "custom")

    @patch.dict(
        os.environ,
        {
            "DPR_EMBED_PROFILE": "default_remote",
            "DPR_EMBED_DEFAULT_API_URL": "https://default-embed.example.test",
            "DPR_EMBED_DEFAULT_API_KEY": "default-key",
            "DPR_EMBED_API_URL": "https://custom-embed.example.test",
            "DPR_EMBED_API_KEY": "custom-key",
            "DPR_EMBED_API_TIMEOUT": "31",
        },
        clear=True,
    )
    def test_default_remote_profile_uses_default_secret_pair(self):
        settings = load_remote_embedding_settings()

        self.assertIsNotNone(settings)
        self.assertEqual(settings.profile, "default_remote")
        self.assertEqual(settings.endpoint, "https://default-embed.example.test")
        self.assertEqual(settings.api_key, "default-key")
        self.assertEqual(settings.timeout, 31)

    @patch.dict(
        os.environ,
        {
            "DPR_EMBED_PROFILE": "default_remote",
            "DPR_EMBED_API_URL": "https://custom-embed.example.test",
            "DPR_EMBED_API_KEY": "custom-key",
        },
        clear=True,
    )
    def test_default_remote_profile_uses_preset_endpoint_without_url_secret(self):
        settings = load_remote_embedding_settings()

        self.assertTrue(is_remote_embedding_enabled())
        self.assertIsNotNone(settings)
        self.assertEqual(settings.profile, "default_remote")
        self.assertEqual(settings.endpoint, "https://embed.zwwen.online/embed")
        self.assertEqual(settings.api_key, "")

    @patch.dict(
        os.environ,
        {
            "DPR_EMBED_PROFILE": "local",
            "DPR_EMBED_DEFAULT_API_URL": "https://default-embed.example.test",
            "DPR_EMBED_API_URL": "https://custom-embed.example.test",
        },
        clear=True,
    )
    @patch("src.model_loader._load_local_sentence_transformer")
    def test_local_profile_forces_local_even_when_remote_secrets_exist(self, mock_load_local):
        local_model = MagicMock()
        mock_load_local.return_value = local_model

        self.assertFalse(is_remote_embedding_enabled())
        model = load_sentence_transformer("BAAI/bge-small-en-v1.5", device="cpu")

        self.assertIs(model, local_model)
        mock_load_local.assert_called_once()

    @patch.dict(
        os.environ,
        {
            "DPR_EMBED_PROFILE": "custom",
            "DPR_EMBED_DEFAULT_API_URL": "https://default-embed.example.test",
            "DPR_EMBED_DEFAULT_API_KEY": "default-key",
            "DPR_EMBED_API_URL": "https://custom-embed.example.test",
            "DPR_EMBED_API_KEY": "custom-key",
        },
        clear=True,
    )
    def test_custom_profile_uses_custom_secret_pair(self):
        settings = load_remote_embedding_settings()

        self.assertIsNotNone(settings)
        self.assertEqual(settings.profile, "custom")
        self.assertEqual(settings.endpoint, "https://custom-embed.example.test")
        self.assertEqual(settings.api_key, "custom-key")

    @patch.dict(
        os.environ,
        {
            "DPR_EMBED_PROFILE": "advanced",
            "DPR_EMBED_DEFAULT_API_URL": "https://default-embed.example.test",
            "DPR_EMBED_API_URL": "https://custom-embed.example.test",
        },
        clear=True,
    )
    def test_advanced_profile_is_reserved_and_falls_back_to_local(self):
        messages = []

        self.assertIsNone(load_remote_embedding_settings(log=messages.append))
        self.assertIn("reserved", " ".join(messages))

    @patch.dict(os.environ, {}, clear=True)
    def test_load_sentence_transformer_defaults_to_preset_remote_without_env(self):
        settings = load_remote_embedding_settings()

        self.assertTrue(is_remote_embedding_enabled())
        self.assertIsNotNone(settings)
        self.assertEqual(settings.profile, "default_remote")
        self.assertEqual(settings.endpoint, "https://embed.zwwen.online/embed")

        model = load_sentence_transformer("BAAI/bge-small-en-v1.5", device="cpu")

        self.assertTrue(getattr(model, "is_remote", False))
        self.assertEqual(model.endpoint, "https://embed.zwwen.online/embed")

    @patch.dict(os.environ, {"DPR_EMBED_API_URL": "https://from-os-env.example.test"}, clear=False)
    def test_load_remote_embedding_settings_honors_explicit_empty_env(self):
        settings = load_remote_embedding_settings({})

        self.assertIsNotNone(settings)
        self.assertEqual(settings.profile, "default_remote")
        self.assertEqual(settings.endpoint, "https://embed.zwwen.online/embed")

    @patch.dict(os.environ, {"DPR_EMBED_API_URL": "https://embed.example.test"}, clear=False)
    def test_load_sentence_transformer_uses_cpu_fallback_for_remote_device_alias(self):
        model = load_sentence_transformer("BAAI/bge-small-en-v1.5", device="remote")
        self.assertTrue(getattr(model, "is_remote", False))
        self.assertEqual(model.local_device, "cpu")

    @patch.dict(os.environ, {"DPR_EMBED_API_URL": "https://embed.example.test"}, clear=False)
    @patch("src.model_loader._load_local_sentence_transformer")
    @patch("src.model_loader.requests.post")
    def test_remote_device_alias_falls_back_to_local_cpu_when_remote_request_fails(
        self,
        mock_post,
        mock_load_local,
    ):
        mock_post.side_effect = requests.exceptions.Timeout("remote timeout")
        local_model = MagicMock()
        local_model.encode.return_value = np.asarray([[0.1, 0.2]], dtype=np.float32)
        mock_load_local.return_value = local_model

        model = load_sentence_transformer("BAAI/bge-small-en-v1.5", device="remote")
        arr = model.encode(["a"], convert_to_numpy=True, normalize_embeddings=True, batch_size=2)

        mock_load_local.assert_called_once()
        self.assertEqual(mock_load_local.call_args.kwargs["device"], "cpu")
        self.assertEqual(arr.shape, (1, 2))

    @patch.dict(os.environ, {"DPR_EMBED_API_URL": "https://embed.example.test"}, clear=False)
    @patch("src.model_loader._load_local_sentence_transformer")
    @patch("src.model_loader.requests.post")
    def test_remote_failure_can_be_configured_to_fail_fast(self, mock_post, mock_load_local):
        mock_post.side_effect = requests.exceptions.Timeout("remote timeout")

        model = RemoteSentenceTransformer(
            model_name="BAAI/bge-small-en-v1.5",
            endpoint="https://embed.example.test",
            api_key="test-key",
            timeout=30,
            default_batch_size=2,
            fallback="fail",
        )

        with self.assertRaises(requests.exceptions.Timeout):
            model.encode(["a"], convert_to_numpy=True, normalize_embeddings=True, batch_size=2)

        mock_load_local.assert_not_called()

    @patch.dict(os.environ, {"DPR_EMBED_API_URL": "https://embed.example.test"}, clear=False)
    @patch("src.model_loader._load_local_sentence_transformer")
    def test_load_sentence_transformer_can_force_local(self, mock_load_local):
        local_model = MagicMock()
        mock_load_local.return_value = local_model

        model = load_sentence_transformer(
            "BAAI/bge-small-en-v1.5",
            device="cpu",
            allow_remote=False,
        )

        mock_load_local.assert_called_once()
        self.assertIs(model, local_model)

    @patch.dict(os.environ, {"DPR_EMBED_API_URL": "https://embed.example.test"}, clear=False)
    @patch("src.model_loader._load_local_sentence_transformer")
    def test_load_sentence_transformer_normalizes_remote_device_when_force_local(self, mock_load_local):
        local_model = MagicMock()
        mock_load_local.return_value = local_model

        model = load_sentence_transformer(
            "BAAI/bge-small-en-v1.5",
            device="remote",
            allow_remote=False,
        )

        mock_load_local.assert_called_once()
        self.assertEqual(mock_load_local.call_args.kwargs["device"], "cpu")
        self.assertIs(model, local_model)


if __name__ == "__main__":
    unittest.main()
