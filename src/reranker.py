"""Remote reranker adapters used by Step 3."""

from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Any, Callable, Mapping, Optional
from urllib.parse import urlsplit

import requests


_DEFAULT_TIMEOUT_SECONDS = 60
_PROVIDER_ALIASES = {
    "openai": "openai",
    "openai-compatible": "openai",
    "openai_compatible": "openai",
    "vllm": "openai",
}


def _log_default(message: str) -> None:
    print(message, flush=True)


def _env_text(env: Mapping[str, str], name: str, default: str = "") -> str:
    return str(env.get(name) or default or "").strip()


def _env_text_any(env: Mapping[str, str], *names: str, default: str = "") -> str:
    for name in names:
        value = _env_text(env, name)
        if value:
            return value
    return str(default or "").strip()


def _join_base_url(base_url: str, endpoint: str) -> str:
    endpoint_text = str(endpoint or "").strip()
    if not endpoint_text:
        return ""
    if endpoint_text.startswith("http://") or endpoint_text.startswith("https://"):
        return endpoint_text
    base_text = str(base_url or "").strip().rstrip("/")
    if not base_text:
        return endpoint_text
    if endpoint_text.startswith("/"):
        return f"{base_text}{endpoint_text}"
    return f"{base_text}/{endpoint_text}"


def _redact_endpoint(endpoint: str) -> str:
    text = str(endpoint or "").strip()
    if not text:
        return "<unset>"
    try:
        parsed = urlsplit(text)
        if parsed.scheme and parsed.netloc:
            return parsed.path or "/"
    except Exception:
        pass
    return text


def normalize_rerank_provider(provider: str | None) -> str:
    text = str(provider or "").strip().lower()
    return _PROVIDER_ALIASES.get(text, text)


@dataclass(frozen=True)
class RemoteRerankSettings:
    provider: str
    endpoint: str
    api_key: str
    model: str
    timeout: int


def normalize_rerank_endpoint(endpoint: str) -> str:
    text = str(endpoint or "").strip().rstrip("/")
    if not text:
        raise ValueError("DPR_RERANK_ENDPOINT is required for remote rerank.")
    if text.endswith("/v1/rerank") or text.endswith("/rerank"):
        return text
    if text.endswith("/v1"):
        return f"{text}/rerank"
    return text


def load_remote_rerank_settings(
    env: Mapping[str, str] | None = None,
    *,
    model: str = "",
    log: Callable[[str], None] | None = None,
) -> RemoteRerankSettings | None:
    env = os.environ if env is None else env
    base_url = _env_text_any(env, "DPR_INFERENCE_BASE_URL", "INFERENCE_BASE_URL")
    raw_endpoint = _env_text_any(env, "DPR_RERANK_ENDPOINT", "RERANK_ENDPOINT")
    raw_provider = _env_text(env, "DPR_RERANK_PROVIDER")
    if not raw_endpoint and base_url:
        raw_endpoint = base_url
    endpoint = _join_base_url(base_url, raw_endpoint)
    provider = normalize_rerank_provider(raw_provider or ("openai" if endpoint else ""))
    if provider in {"", "none", "off", "disabled"}:
        return None
    if provider != "openai":
        if log:
            log(f"[WARN] Unsupported DPR_RERANK_PROVIDER={provider}; using RRF fallback.")
        return None

    model_name = str(model or "").strip() or _env_text(env, "DPR_RERANK_MODEL")
    if not endpoint:
        raise ValueError("DPR_RERANK_PROVIDER=openai requires DPR_RERANK_ENDPOINT or RERANK_ENDPOINT.")
    if not model_name:
        raise ValueError("DPR_RERANK_PROVIDER=openai requires DPR_RERANK_MODEL.")

    timeout_text = _env_text(env, "DPR_RERANK_API_TIMEOUT", str(_DEFAULT_TIMEOUT_SECONDS))
    try:
        timeout = int(timeout_text)
    except ValueError:
        if log:
            log(f"[WARN] Invalid DPR_RERANK_API_TIMEOUT={timeout_text}; using {_DEFAULT_TIMEOUT_SECONDS}s.")
        timeout = _DEFAULT_TIMEOUT_SECONDS

    return RemoteRerankSettings(
        provider="openai",
        endpoint=normalize_rerank_endpoint(endpoint),
        api_key=_env_text_any(env, "DPR_RERANK_API_KEY", "RERANK_API_KEY", "RERANK_KEY"),
        model=model_name,
        timeout=max(int(timeout or _DEFAULT_TIMEOUT_SECONDS), 1),
    )


class OpenAIReranker:
    """OpenAI/vLLM-compatible rerank client with the Step 3 rerank interface."""

    def __init__(
        self,
        *,
        endpoint: str,
        model: str,
        api_key: str = "",
        timeout: int = _DEFAULT_TIMEOUT_SECONDS,
    ):
        self.endpoint = normalize_rerank_endpoint(endpoint)
        self.model_name = str(model or "").strip()
        self.api_key = str(api_key or "").strip()
        self.timeout = max(int(timeout or _DEFAULT_TIMEOUT_SECONDS), 1)
        if not self.model_name:
            raise ValueError("rerank model is required.")

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    @staticmethod
    def _normalize_results(data: Any) -> list[dict[str, Any]]:
        if not isinstance(data, dict):
            raise RuntimeError("Remote rerank response must be a JSON object.")
        raw_results = data.get("results")
        if raw_results is None and isinstance(data.get("output"), dict):
            raw_results = data.get("output", {}).get("results")
        if raw_results is None:
            raw_results = data.get("data")
        if not isinstance(raw_results, list):
            raise RuntimeError("Remote rerank response missing results/data.")

        normalized: list[dict[str, Any]] = []
        for item in raw_results:
            if not isinstance(item, dict):
                continue
            raw_index = item.get("index", item.get("document_index"))
            try:
                index = int(raw_index)
            except Exception:
                continue
            score = item.get("relevance_score", item.get("score"))
            try:
                score_value = float(score)
            except Exception:
                score_value = 0.0
            normalized.append({"index": index, "relevance_score": score_value})
        return normalized

    def rerank(
        self,
        query: str,
        documents: list[str],
        top_n: Optional[int] = None,
        model: Optional[str] = None,
    ) -> dict:
        safe_documents = [str(item or "") for item in (documents or [])]
        payload: dict[str, Any] = {
            "model": str(model or "").strip() or self.model_name,
            "query": str(query or ""),
            "documents": safe_documents,
        }
        if top_n is not None:
            payload["top_n"] = int(top_n)

        response = requests.post(
            self.endpoint,
            headers=self._headers(),
            json=payload,
            timeout=self.timeout,
        )
        response.raise_for_status()
        return {"results": self._normalize_results(response.json())}


def create_reranker_from_env(
    *,
    model: str = "",
    log: Callable[[str], None] = _log_default,
) -> tuple[OpenAIReranker | None, str]:
    settings = load_remote_rerank_settings(model=model, log=log)
    if settings is None:
        return None, str(model or "").strip()
    log(
        f"[INFO] Using remote reranker: provider={settings.provider} "
        f"model={settings.model} endpoint={_redact_endpoint(settings.endpoint)} timeout={settings.timeout}s "
        f"{'with-auth' if settings.api_key else 'no-auth'}"
    )
    return (
        OpenAIReranker(
            endpoint=settings.endpoint,
            model=settings.model,
            api_key=settings.api_key,
            timeout=settings.timeout,
        ),
        settings.model,
    )
