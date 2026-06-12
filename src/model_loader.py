"""统一模型加载器：按顺序尝试下载源，按重试次数回退。"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import os
import time
from typing import Any, Callable, Mapping, Optional, TYPE_CHECKING
from urllib.parse import urlsplit

import numpy as np
import requests

if TYPE_CHECKING:
  from sentence_transformers import SentenceTransformer


HUGGINGFACE_ENDPOINT = "https://huggingface.co"
MODELSCOPE_ENDPOINT = "https://modelscope.cn/hf"
_DEFAULT_RETRIES = 3
_DEFAULT_HF_BACKOFF_RETRIES = 1
_DEFAULT_REMOTE_TIMEOUT_SECONDS = 60
_DEFAULT_REMOTE_PRESET_ENDPOINT = "https://embed.zwwen.online/embed"
_REMOTE_PROVIDER_ALIASES = {
  "": "legacy",
  "custom": "legacy",
  "legacy": "legacy",
  "openai": "openai",
  "openai-compatible": "openai",
  "openai_compatible": "openai",
  "vllm": "openai",
}
_REMOTE_PROFILE_ALIASES = {
  "": "default_remote",
  "default": "default_remote",
  "default_remote": "default_remote",
  "remote": "default_remote",
  "local": "local",
  "advanced": "advanced",
  "custom": "custom",
}
_REMOTE_DEVICE_ALIASES = {"remote"}


@dataclass(frozen=True)
class RemoteEmbeddingSettings:
  profile: str
  provider: str
  endpoint: str
  api_key: str
  timeout: int
  fallback: str


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


def normalize_remote_embedding_provider(provider: str | None) -> str:
  text = str(provider or "").strip().lower()
  return _REMOTE_PROVIDER_ALIASES.get(text, text)


def normalize_remote_embedding_profile(profile: str | None) -> str:
  text = str(profile or "").strip().lower()
  return _REMOTE_PROFILE_ALIASES.get(text, text)


def load_remote_embedding_settings(
  env: Mapping[str, str] | None = None,
  *,
  log: Callable[[str], None] | None = None,
) -> RemoteEmbeddingSettings | None:
  env = os.environ if env is None else env
  raw_profile = _env_text(env, "DPR_EMBED_PROFILE")
  raw_provider = _env_text(env, "DPR_EMBED_PROVIDER")
  provider = normalize_remote_embedding_provider(raw_provider or "legacy")
  base_url = _env_text_any(env, "DPR_INFERENCE_BASE_URL", "INFERENCE_BASE_URL")
  endpoint_alias = _env_text_any(env, "DPR_EMBED_ENDPOINT", "EMBED_ENDPOINT")
  raw_custom_endpoint = endpoint_alias or _env_text(env, "DPR_EMBED_API_URL")
  if not raw_custom_endpoint and provider == "openai" and base_url:
    raw_custom_endpoint = base_url
  custom_endpoint = _join_base_url(base_url, raw_custom_endpoint)
  profile = normalize_remote_embedding_profile(raw_profile)
  # 显式 default_remote 要屏蔽旧 custom 变量，避免前端切回默认后仍命中旧 endpoint。
  if not raw_profile and custom_endpoint:
    profile = "custom"

  if profile == "local":
    return None
  if profile == "advanced":
    if log:
      log("[WARN] DPR_EMBED_PROFILE=advanced is reserved; using local embedding.")
    return None
  if profile == "default_remote":
    endpoint = _env_text(env, "DPR_EMBED_DEFAULT_API_URL", _DEFAULT_REMOTE_PRESET_ENDPOINT)
    api_key = _env_text(env, "DPR_EMBED_DEFAULT_API_KEY")
    if endpoint.rstrip("/") == _DEFAULT_REMOTE_PRESET_ENDPOINT.rstrip("/"):
      provider = "legacy"
  elif profile == "custom":
    endpoint = custom_endpoint
    api_key = _env_text_any(env, "DPR_EMBED_API_KEY", "EMBED_API_KEY", "EMBED_KEY")
  else:
    if log:
      log(f"[WARN] Unsupported DPR_EMBED_PROFILE={profile}; using local embedding.")
    return None

  if not endpoint:
    return None

  if provider not in {"legacy", "openai"}:
    if log:
      log(f"[WARN] Unsupported DPR_EMBED_PROVIDER={provider}; falling back to legacy /embed protocol.")
    provider = "legacy"

  timeout_text = _env_text(env, "DPR_EMBED_API_TIMEOUT", str(_DEFAULT_REMOTE_TIMEOUT_SECONDS))
  try:
    timeout = int(timeout_text)
  except ValueError:
    if log:
      log(
        f"[WARN] Invalid DPR_EMBED_API_TIMEOUT={timeout_text}; "
        f"using default {_DEFAULT_REMOTE_TIMEOUT_SECONDS}s."
      )
    timeout = _DEFAULT_REMOTE_TIMEOUT_SECONDS

  fallback = _env_text(env, "DPR_EMBED_REMOTE_FALLBACK", "local").lower()
  # 默认预置 embedding 必须可用本地兜底，避免旧 Variable=fail 让公网 TLS 抖动中断日报。
  if profile == "default_remote":
    fallback = "local"
  if fallback not in {"local", "fail"}:
    if log:
      log(f"[WARN] Unsupported DPR_EMBED_REMOTE_FALLBACK={fallback}; using local.")
    fallback = "local"

  return RemoteEmbeddingSettings(
    profile=profile,
    provider=provider,
    endpoint=endpoint,
    api_key=api_key,
    timeout=max(int(timeout or _DEFAULT_REMOTE_TIMEOUT_SECONDS), 1),
    fallback=fallback,
  )


def is_remote_embedding_enabled() -> bool:
  return load_remote_embedding_settings() is not None


def remote_embedding_env_summary() -> str:
  settings = load_remote_embedding_settings()
  if settings is None:
    return "disabled"
  auth = "with-auth" if settings.api_key else "no-auth"
  return f"{settings.profile}/{settings.provider}:{_redact_endpoint(settings.endpoint)} timeout={settings.timeout}s {auth}"


def normalize_local_embedding_device(device: str | None) -> str:
  """把远程占位符转换为 PyTorch 可识别的本地 fallback 设备。"""
  text = str(device or "").strip()
  if not text or text.lower() in _REMOTE_DEVICE_ALIASES:
    return "cpu"
  return text


class RemoteSentenceTransformer:
  """兼容 SentenceTransformer.encode 接口的远程 embedding 包装器。"""

  is_remote = True

  def __init__(
    self,
    model_name: str,
    endpoint: str,
    provider: str = "legacy",
    api_key: str = "",
    timeout: int = _DEFAULT_REMOTE_TIMEOUT_SECONDS,
    default_batch_size: int = 8,
    local_device: str = "cpu",
    local_retries: int | None = None,
    fallback: str = "local",
    local_providers: tuple[tuple[str, str], ...] = (
      ("huggingface", HUGGINGFACE_ENDPOINT),
      ("modelscope", MODELSCOPE_ENDPOINT),
    ),
    log: Callable[[str], None] = _log_default,
  ):
    self.model_name = model_name
    self.provider = normalize_remote_embedding_provider(provider)
    if self.provider not in {"legacy", "openai"}:
      self.provider = "legacy"
    self.endpoint = self._normalize_endpoint(endpoint, self.provider)
    self.api_key = str(api_key or "").strip()
    self.timeout = max(int(timeout or _DEFAULT_REMOTE_TIMEOUT_SECONDS), 1)
    self.default_batch_size = max(int(default_batch_size or 1), 1)
    self.max_seq_length = None
    self.local_device = normalize_local_embedding_device(local_device)
    self.local_retries = local_retries
    self.fallback = "fail" if str(fallback or "").strip().lower() == "fail" else "local"
    self.local_providers = local_providers
    self._local_model = None
    self._log = log
    self._remote_available = True
    self._remote_disabled_reason = ""

  @staticmethod
  def _normalize_endpoint(endpoint: str, provider: str = "legacy") -> str:
    text = str(endpoint or "").strip().rstrip("/")
    if not text:
      raise ValueError("远程 embedding 服务地址不能为空（DPR_EMBED_API_URL）")
    if normalize_remote_embedding_provider(provider) == "openai":
      if text.endswith("/v1/embeddings"):
        return text
      if text.endswith("/v1"):
        return f"{text}/embeddings"
      return text
    if text.endswith("/embed"):
      return text
    return f"{text}/embed"

  def _headers(self) -> dict[str, str]:
    headers = {
      "Content-Type": "application/json",
    }
    if self.api_key:
      headers["Authorization"] = f"Bearer {self.api_key}"
    return headers

  def _build_payload(self, chunk: list[str]) -> dict[str, Any]:
    if self.provider == "openai":
      return {
        "model": self.model_name,
        "input": chunk,
      }
    return {"texts": chunk}

  def _parse_embedding_response(self, data: Any, expected_count: int) -> np.ndarray:
    embeddings = None
    if self.provider == "openai":
      items = data.get("data") if isinstance(data, dict) else None
      if isinstance(items, list):
        indexed_items = []
        for pos, item in enumerate(items):
          if not isinstance(item, dict):
            continue
          raw_index = item.get("index", pos)
          try:
            index = int(raw_index)
          except Exception:
            index = pos
          indexed_items.append((index, item.get("embedding")))
        indexed_items.sort(key=lambda item: item[0])
        embeddings = [item[1] for item in indexed_items]
    if embeddings is None and isinstance(data, dict):
      embeddings = data.get("embeddings")
    if not isinstance(embeddings, list):
      raise RuntimeError("远程 embedding 服务返回缺少 embeddings/data 字段")
    try:
      arr = np.asarray(embeddings, dtype=np.float32)
    except Exception as exc:
      raise RuntimeError(f"远程 embedding 返回无法转换为 float32：{exc}") from exc

    if arr.ndim != 2:
      raise RuntimeError(f"远程 embedding 返回维度异常：shape={getattr(arr, 'shape', None)}")
    if arr.shape[0] != expected_count:
      raise RuntimeError(
        f"远程 embedding 返回条数异常：expected={expected_count} actual={arr.shape[0]}"
      )
    return arr

  def _get_local_model(self):
    if self._local_model is None:
      self._log(
        f"[WARN] 远程 embedding 不可用，回退本地模型：{self.model_name} "
        f"(device={self.local_device})"
      )
      self._local_model = _load_local_sentence_transformer(
        self.model_name,
        device=self.local_device,
        retries=self.local_retries,
        log=self._log,
        providers=self.local_providers,
      )
      if self.max_seq_length is not None and hasattr(self._local_model, "max_seq_length"):
        try:
          self._local_model.max_seq_length = self.max_seq_length
        except Exception:
          pass
    return self._local_model

  def _disable_remote(self, reason: Exception | str) -> None:
    self._remote_available = False
    self._remote_disabled_reason = str(reason or "").strip()

  def _encode_via_local(
    self,
    texts,
    *,
    convert_to_numpy: bool,
    normalize_embeddings: bool,
    batch_size: int,
    show_progress_bar: bool,
    **kwargs,
  ):
    local_model = self._get_local_model()
    result = local_model.encode(
      texts,
      convert_to_numpy=convert_to_numpy,
      normalize_embeddings=normalize_embeddings,
      batch_size=batch_size,
      show_progress_bar=show_progress_bar,
      **kwargs,
    )
    if convert_to_numpy and not isinstance(result, np.ndarray):
      try:
        result = np.asarray(result, dtype=np.float32)
      except Exception:
        pass
    return result

  def encode(
    self,
    texts,
    convert_to_numpy: bool = True,
    normalize_embeddings: bool = True,
    batch_size: int = 8,
    show_progress_bar: bool = False,
    **kwargs,
  ):
    if isinstance(texts, str):
      texts = [texts]
    if not isinstance(texts, list):
      texts = list(texts or [])
    if not texts:
      empty = np.zeros((0, 0), dtype=np.float32)
      return empty if convert_to_numpy else empty.tolist()

    safe_batch_size = max(int(batch_size or self.default_batch_size), 1)
    if not self._remote_available:
      return self._encode_via_local(
        texts,
        convert_to_numpy=convert_to_numpy,
        normalize_embeddings=normalize_embeddings,
        batch_size=safe_batch_size,
        show_progress_bar=show_progress_bar,
        **kwargs,
      )
    try:
      chunks = [texts[i : i + safe_batch_size] for i in range(0, len(texts), safe_batch_size)]
      outputs: list[np.ndarray] = []

      self._log(
        f"[INFO] 远程 embedding：model={self.model_name} "
        f"endpoint={_redact_endpoint(self.endpoint)} total={len(texts)} batch={safe_batch_size}"
      )

      for chunk_index, chunk in enumerate(chunks, start=1):
        headers = self._headers()
        response = requests.post(
          self.endpoint,
          headers=headers,
          json=self._build_payload(chunk),
          timeout=self.timeout,
        )
        if response.status_code == 401 and headers.get("Authorization"):
          self._log("[WARN] 远程 embedding 鉴权失败，自动回退为无鉴权请求重试一次。")
          headers = {
            "Content-Type": "application/json",
          }
          response = requests.post(
            self.endpoint,
            headers=headers,
            json=self._build_payload(chunk),
            timeout=self.timeout,
          )
        response.raise_for_status()
        data = response.json()
        arr = self._parse_embedding_response(data, len(chunk))
        if normalize_embeddings:
          norms = np.linalg.norm(arr, axis=1, keepdims=True)
          arr = arr / np.clip(norms, 1e-12, None)
        outputs.append(arr)
        self._log(
          f"[INFO] 远程 embedding 批次完成：{chunk_index}/{len(chunks)} "
          f"count={len(chunk)} dim={arr.shape[1]}"
        )

      merged = np.vstack(outputs) if outputs else np.zeros((0, 0), dtype=np.float32)
      return merged if convert_to_numpy else merged.tolist()
    except Exception as exc:
      self._disable_remote(exc)
      if self.fallback == "fail":
        self._log(f"[WARN] Remote embedding request failed and fallback=fail: {exc}")
        raise
      self._log(f"[WARN] 远程 embedding 请求失败，将自动回退本地模型：{exc}")
      return self._encode_via_local(
        texts,
        convert_to_numpy=convert_to_numpy,
        normalize_embeddings=normalize_embeddings,
        batch_size=safe_batch_size,
        show_progress_bar=show_progress_bar,
        **kwargs,
      )

  def start_multi_process_pool(self, target_devices=None):
    del target_devices
    return None

  def encode_multi_process(
    self,
    texts,
    pool=None,
    batch_size: int = 8,
    normalize_embeddings: bool = True,
    **kwargs,
  ):
    del pool
    return self.encode(
      texts,
      convert_to_numpy=True,
      normalize_embeddings=normalize_embeddings,
      batch_size=batch_size,
      **kwargs,
    )

  def stop_multi_process_pool(self, pool):
    del pool
    return None


@contextmanager
def _hf_http_backoff(max_retries: int):
  """临时覆盖 huggingface_hub 的 http_backoff 重试次数。

  仅用于抑制单次请求内置重试次数（日志中通常体现为 `Retry x/5`）。
  """
  if max_retries <= 0:
    yield
    return

  try:
    from huggingface_hub.utils import _http as hf_http
  except Exception:
    yield
    return

  origin_http_backoff = hf_http.http_backoff

  def http_backoff_with_retry_limit(*args, **kwargs):
    kwargs.setdefault("max_retries", max_retries)
    return origin_http_backoff(*args, **kwargs)

  hf_http.http_backoff = http_backoff_with_retry_limit
  try:
    yield
  finally:
    hf_http.http_backoff = origin_http_backoff


@contextmanager
def _hf_endpoint(endpoint: Optional[str] = None):
  had_endpoint = "HF_ENDPOINT" in os.environ
  old_endpoint = os.environ.get("HF_ENDPOINT")
  had_base_url = "HF_HUB_BASE_URL" in os.environ
  old_base_url = os.environ.get("HF_HUB_BASE_URL")
  if endpoint:
    os.environ["HF_ENDPOINT"] = endpoint
    os.environ["HF_HUB_BASE_URL"] = endpoint
  elif had_endpoint:
    if "HF_ENDPOINT" in os.environ:
      del os.environ["HF_ENDPOINT"]
    if "HF_HUB_BASE_URL" in os.environ:
      del os.environ["HF_HUB_BASE_URL"]

  try:
    yield
  finally:
    if had_endpoint:
      if old_endpoint is None:
        del os.environ["HF_ENDPOINT"]
      else:
        os.environ["HF_ENDPOINT"] = old_endpoint
    elif "HF_ENDPOINT" in os.environ:
      del os.environ["HF_ENDPOINT"]
    if had_base_url:
      if old_base_url is None:
        del os.environ["HF_HUB_BASE_URL"]
      else:
        os.environ["HF_HUB_BASE_URL"] = old_base_url
    elif "HF_HUB_BASE_URL" in os.environ:
      del os.environ["HF_HUB_BASE_URL"]


def load_sentence_transformer(
  model_name: str,
  *,
  device: str,
  allow_remote: bool = True,
  retries: int | None = None,
  log: Callable[[str], None] = _log_default,
  providers: tuple[tuple[str, str], ...] = (
    ("huggingface", HUGGINGFACE_ENDPOINT),
    ("modelscope", MODELSCOPE_ENDPOINT),
  ),
):
  requested_device = str(device or "").strip() or "cpu"
  local_device = normalize_local_embedding_device(requested_device)
  remote_settings = load_remote_embedding_settings(log=log)
  if allow_remote and remote_settings is not None:
    device_note = f"device={requested_device}"
    if local_device != requested_device:
      device_note += f" local_fallback_device={local_device}"
    log(
      f"[INFO] Using remote embedding service: model={model_name} "
      f"endpoint={_redact_endpoint(remote_settings.endpoint)} timeout={remote_settings.timeout}s "
      f"profile={remote_settings.profile} provider={remote_settings.provider} "
      f"fallback={remote_settings.fallback} {device_note}"
    )
    return RemoteSentenceTransformer(
      model_name=model_name,
      endpoint=remote_settings.endpoint,
      provider=remote_settings.provider,
      api_key=remote_settings.api_key,
      timeout=remote_settings.timeout,
      local_device=local_device,
      local_retries=retries,
      fallback=remote_settings.fallback,
      local_providers=providers,
      log=log,
    )

  if remote_settings is not None and not allow_remote:
    log(f"[INFO] Remote embedding disabled by caller; using local model: {model_name} (device={local_device})")

  return _load_local_sentence_transformer(
    model_name,
    device=local_device,
    retries=retries,
    log=log,
    providers=providers,
  )


def _load_local_sentence_transformer(
  model_name: str,
  *,
  device: str,
  retries: int | None = None,
  log: Callable[[str], None] = _log_default,
  providers: tuple[tuple[str, str], ...] = (
    ("huggingface", HUGGINGFACE_ENDPOINT),
    ("modelscope", MODELSCOPE_ENDPOINT),
  ),
):
  requested_device = str(device or "").strip() or "cpu"
  device = normalize_local_embedding_device(requested_device)
  if requested_device != device:
    log(f"[WARN] 本地 embedding 不支持 device={requested_device}，已改用 device={device}。")

  if retries is None:
    env_retries = os.getenv("LLM_EMBED_MODEL_RETRIES")
    if env_retries is None:
      retries = _DEFAULT_RETRIES
    else:
      try:
        retries = int(env_retries)
      except ValueError:
        print(f"[WARN] 环境变量 LLM_EMBED_MODEL_RETRIES 无效：{env_retries}，回退默认 {_DEFAULT_RETRIES}")
        retries = _DEFAULT_RETRIES
  hf_backoff_retries = _DEFAULT_HF_BACKOFF_RETRIES
  env_hf_backoff_retries = os.getenv("HF_HUB_HTTP_BACKOFF_RETRIES")
  if env_hf_backoff_retries is not None:
    try:
      hf_backoff_retries = int(env_hf_backoff_retries)
    except ValueError:
      print(
        f"[WARN] 环境变量 HF_HUB_HTTP_BACKOFF_RETRIES 无效：{env_hf_backoff_retries}，"
        f"回退默认 {_DEFAULT_HF_BACKOFF_RETRIES}"
      )
      hf_backoff_retries = _DEFAULT_HF_BACKOFF_RETRIES
    if hf_backoff_retries < 0:
      hf_backoff_retries = 0

  attempts = max(int(retries or _DEFAULT_RETRIES), 1)
  last_err: Exception | None = None

  for round_idx in range(1, attempts + 1):
    for provider_name, endpoint in providers:
      try:
        log(
          f"[INFO] 尝试加载模型（第 {round_idx}/{attempts} 轮）：{model_name}"
          f"（provider={provider_name}，device={device}）"
        )
        with _hf_endpoint(endpoint), _hf_http_backoff(max_retries=hf_backoff_retries):
          from sentence_transformers import SentenceTransformer
          return SentenceTransformer(model_name, device=device)
      except Exception as e:  # pragma: no cover - 仅异常路径
        last_err = e
        msg = str(e)
        if len(msg) > 260:
          msg = msg[:260]
        log(
          f"[WARN] 模型加载失败（provider={provider_name}，round={round_idx}/{attempts}）："
          f"{msg}"
        )

    if round_idx < attempts:
      wait_seconds = 1
      log(f"[INFO] 重试间隔：{wait_seconds}s")
      time.sleep(wait_seconds)

  if last_err is not None:
    raise last_err
  raise RuntimeError(f"加载模型失败：{model_name}")
