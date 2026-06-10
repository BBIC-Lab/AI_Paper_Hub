import json
import os
import re
import time
from typing import List, Dict, Tuple, Any, Optional

import requests

"""
统一的 OpenAI-compatible Chat Completions 客户端封装。

第一版工作流只依赖通用的 base_url + api_key + model 配置；不同厂商的
特殊 API（如 Claude Messages、Responses API、专用 rerank）后续再通过
独立 adapter 扩展。
"""

# 单次实验级别的全局 token 统计（需由调用方在实验开始前手动 reset）
GLOBAL_TOKENS = {
    'prompt': 0,    # 提示词（prompt）部分 token
    'thinking': 0,  # 推理/思维链部分 token（reasoning_tokens）
    'content': 0,   # 可见输出部分 token（completion_tokens - reasoning_tokens）
    'total': 0,     # provider 返回的总 token（通常含 prompt + completion）
}
# 单次实验级别的全局时间统计（秒）
GLOBAL_TIME_SECONDS: float = 0.0

DEFAULT_OPENAI_COMPATIBLE_BASE_URL = "https://api.openai.com/v1"


class LLMAuthenticationError(RuntimeError):
    """Raised when the model provider rejects the configured credentials."""


def reset_global_tokens():
    """重置本次实验的全局 token 统计。"""
    GLOBAL_TOKENS['prompt'] = 0
    GLOBAL_TOKENS['thinking'] = 0
    GLOBAL_TOKENS['content'] = 0
    GLOBAL_TOKENS['total'] = 0


def get_global_tokens() -> Dict[str, int]:
    """获取本次实验的全局 token 统计（thinking/content/total）。"""
    return dict(GLOBAL_TOKENS)


def reset_global_time():
    """重置本次实验的大模型总耗时统计（秒）。"""
    global GLOBAL_TIME_SECONDS
    GLOBAL_TIME_SECONDS = 0.0


def get_global_time() -> float:
    """获取本次实验的大模型总耗时（秒）。"""
    return float(GLOBAL_TIME_SECONDS)


class LLMClient:
    tokens = {
        'prompt': 0,
        'content': 0,
        'reasoning': 0,
        'total': 0,
    }

    def __init__(self, api_key: str, model: str, base_url: str):
        """
        初始化 LLM 客户端。

        :param api_key: API 密钥
        :param model: 模型名称
        :param base_url: API 的基础 URL
        """
        self.api_key = api_key
        self.model = model
        self.base_url = base_url
        self._base_urls = self._normalize_base_urls([base_url])
        # 实例级别的累计统计（无需显式 reset；通常每个实验构造一个 client）
        self._call_index = 0
        self._cum_tokens = {
            'prompt': 0,
            'thinking': 0,
            'content': 0,
            'total': 0,
        }
        # 实例级别的累计耗时（秒）
        self._cum_time_seconds: float = 0.0
        self.kwargs: Dict[str, Any] = {
            'max_tokens': 4000,  # 更安全的默认值，避免超过部分模型上限
            'temperature': 0.6,
            'top_p': 0.3,
            'top_k': 50,
            'frequency_penalty': 0.5,
            'n': 1,
            'stream': False,
        }

    @staticmethod
    def _normalize_base_urls(urls: List[str | None]) -> List[str]:
        out: List[str] = []
        for url in urls:
            if not url:
                continue
            candidate = str(url).strip().rstrip("/")
            if candidate and candidate not in out:
                out.append(candidate)
        return out

    def _iter_request_bases(self) -> List[str]:
        return self._normalize_base_urls(self._base_urls)

    @staticmethod
    def _build_chat_completions_url(base_url: str | None) -> str:
        raw = str(base_url or "").strip().rstrip("/")
        if not raw:
            raise ValueError("缺少可用的 LLM base_url")
        if raw.lower().endswith("/chat/completions"):
            return raw
        if re.search(r"/v\d+$", raw, re.IGNORECASE):
            return f"{raw}/chat/completions"
        return f"{raw}/v1/chat/completions"

    def _iter_retry_bases(self, total_attempts: int = 6) -> List[str]:
        bases = self._iter_request_bases()
        if total_attempts <= 0:
            return []
        if not bases:
            return []

        if len(bases) == 1:
            return [bases[0]] * total_attempts

        attempts: List[str] = []
        for idx in range(total_attempts):
            attempts.append(bases[idx % len(bases)])
        return attempts

    @staticmethod
    def _redact_sensitive_text(value: Any) -> str:
        text = str(value or "")
        replacements = [
            r"(?i)\bsk-(?:proj-)?[A-Za-z0-9_\-]{8,}\b",
            r"(?i)\bcr_[A-Za-z0-9_\-*]{8,}\b",
            r"(?i)\bgithub_pat_[A-Za-z0-9_]{8,}\b",
            r"(?i)\bgh[pousr]_[A-Za-z0-9_]{8,}\b",
            r"(?i)\b(?:api[_-]?key|token|authorization|bearer)\s*[:=]\s*['\"]?[^'\"\s,;]+",
        ]
        redacted = text
        for pattern in replacements:
            redacted = re.sub(pattern, "[REDACTED]", redacted)
        return redacted

    @classmethod
    def _sanitize_error_detail(cls, value: Any) -> Any:
        if isinstance(value, dict):
            out: Dict[str, Any] = {}
            for key, item in value.items():
                lowered = str(key).lower()
                if any(token in lowered for token in ("key", "token", "authorization", "secret")):
                    out[key] = "[REDACTED]"
                else:
                    out[key] = cls._sanitize_error_detail(item)
            return out
        if isinstance(value, list):
            return [cls._sanitize_error_detail(item) for item in value]
        if isinstance(value, str):
            return cls._redact_sensitive_text(value)
        return value

    @staticmethod
    def _http_status(exc: Exception) -> int | None:
        response = getattr(exc, "response", None)
        status_code = getattr(response, "status_code", None)
        try:
            return int(status_code) if status_code is not None else None
        except Exception:
            return None

    @classmethod
    def _is_auth_error(cls, exc: Exception) -> bool:
        status_code = cls._http_status(exc)
        if status_code in (401, 403):
            return True
        response = getattr(exc, "response", None)
        try:
            payload = response.json() if response is not None else {}
            err = payload.get("error") if isinstance(payload, dict) else {}
            code = str((err or {}).get("code") or "").lower()
            msg = str((err or {}).get("message") or "").lower()
            return code in {"invalid_api_key", "invalid_api_key_error"} or "incorrect api key" in msg
        except Exception:
            return False

    @classmethod
    def _print_response_error(cls, exc: Exception) -> None:
        response = getattr(exc, "response", None)
        if response is None:
            return
        try:
            print("错误详情(JSON):", cls._sanitize_error_detail(response.json()))
        except ValueError:
            try:
                print("错误详情(TEXT):", cls._redact_sensitive_text(response.text[:500]))
            except Exception:
                pass

    def _provider_name(self, base_url: str | None = None) -> str:
        try:
            url = (base_url or self.base_url or '').lower()
            if 'deepseek' in url:
                return 'deepseek'
            if 'siliconflow' in url or 'siliconflow.cn' in url:
                return 'siliconflow'
            if 'ollama' in url or 'localhost' in url:
                return 'ollama'
            if 'cstcloud' in url or 'uni-api.cstcloud.cn' in url:
                return 'cstcloud'
        except Exception:
            pass
        return 'llm'

    @staticmethod
    def _extract_text_content(value: Any) -> str:
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            parts: List[str] = []
            for item in value:
                text = LLMClient._extract_text_content(item)
                if text:
                    parts.append(text)
            return "\n".join(parts).strip()
        if isinstance(value, dict):
            for key in ("text", "content", "value"):
                text = value.get(key)
                if isinstance(text, str) and text.strip():
                    return text
        return ""

    @staticmethod
    def _strip_json_wrappers(text: str) -> str:
        cleaned = (text or "").strip()
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)
        return cleaned.strip()

    @staticmethod
    def _repair_json_suffix(text: str) -> str:
        if not text:
            return text

        stack: List[str] = []
        in_str = False
        escaped = False

        for ch in text:
            if in_str:
                if escaped:
                    escaped = False
                    continue
                if ch == "\\":
                    escaped = True
                    continue
                if ch == '"':
                    in_str = False
                continue

            if ch == '"':
                in_str = True
            elif ch == '{':
                stack.append('}')
            elif ch == '[':
                stack.append(']')
            elif ch in ('}', ']'):
                if stack and stack[-1] == ch:
                    stack.pop()

        repaired = text
        if in_str:
            repaired += '"'
        if stack:
            repaired += ''.join(reversed(stack))
        repaired = re.sub(r",(\s*[}\]])", r"\1", repaired)
        return repaired

    @classmethod
    def parse_json_content(cls, text: str) -> Any:
        raw = cls._strip_json_wrappers((text or "").strip())
        if not raw:
            return None

        decoder = json.JSONDecoder()
        candidates: List[str] = []
        first_obj = raw.find("{")
        last_obj = raw.rfind("}")
        first_arr = raw.find("[")
        last_arr = raw.rfind("]")
        if first_obj != -1:
            candidates.append(raw[first_obj:])
            if last_obj != -1 and last_obj >= first_obj:
                candidates.append(raw[first_obj:last_obj + 1])
        if first_arr != -1:
            candidates.append(raw[first_arr:])
            if last_arr != -1 and last_arr >= first_arr:
                candidates.append(raw[first_arr:last_arr + 1])
        candidates.append(raw)

        seen: set[str] = set()
        last_exc: Exception | None = None
        for candidate in candidates:
            if candidate in seen:
                continue
            seen.add(candidate)
            try:
                obj, _idx = decoder.raw_decode(candidate)
                return obj
            except Exception as exc:
                last_exc = exc
                repaired = cls._repair_json_suffix(candidate)
                if repaired == candidate:
                    continue
                try:
                    return json.loads(repaired)
                except Exception as exc2:
                    last_exc = exc2

        raise ValueError(f"模型未返回合法 JSON：{raw[:500]}") from last_exc

    @staticmethod
    def build_json_schema_response_format(
        schema_name: str,
        schema: Dict[str, Any],
        strict: bool = True,
    ) -> Dict[str, Any]:
        return {
            "type": "json_schema",
            "json_schema": {
                "name": schema_name,
                "schema": schema,
                "strict": bool(strict),
            },
        }

    @staticmethod
    def build_json_object_response_format() -> Dict[str, str]:
        return {"type": "json_object"}

    def _supports_json_schema_response_format(self) -> bool:
        provider_fingerprint = " ".join(
            str(part or "").lower()
            for part in [self.model, self.base_url, *self._iter_request_bases()]
        )
        return "deepseek" not in provider_fingerprint

    @staticmethod
    def _is_structured_output_unsupported_error(error: Exception) -> bool:
        response = getattr(error, "response", None)
        status_code = getattr(response, "status_code", None)
        text = ""
        if response is not None:
            try:
                text = response.text or ""
            except Exception:
                text = ""
        if not text:
            text = str(error or "")
        lowered = text.lower()
        has_target = any(token in lowered for token in (
            "response_format",
            "json_schema",
            "json object",
            "json_object",
        ))
        has_signal = any(token in lowered for token in (
            "unsupported",
            "not support",
            "not supported",
            "invalid",
            "unknown",
            "unrecognized",
            "extra inputs",
            "unexpected",
            "must be one of",
            "one of",
            "allowed values",
            "enum",
        ))
        if has_target and has_signal:
            return True
        if (
            status_code in (400, 404, 415, 422)
            and "response_format" in lowered
            and any(token in lowered for token in ("json_object", "json_schema", "text"))
        ):
            return True
        if status_code in (400, 404, 415, 422) and "response_format" in lowered:
            return True
        return False

    def chat(self, messages: List[Dict[str, str]], response_format: Optional[Dict[str, Any]] = None) -> dict:
        """
        统一 Chat Completions 请求。

        :param messages: OpenAI 格式的消息列表
        :param response_format: 可选，OpenAI-compatible 结构化输出配置
        """
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        model_name = self.model
        if 'qwen3' in model_name.lower():
            if '/think' in model_name:
                self.kwargs['enable_thinking'] = True
                model_name = model_name.replace('/think', '')
            else:
                self.kwargs['enable_thinking'] = False
                model_name = model_name.replace('/think', '')

        payload: Dict[str, Any] = {
            "model": model_name,
            "messages": messages,
        }
        # 仅透传 OpenAI Chat Completions 兼容字段，避免提供商拒绝未知参数
        allowed_keys = {
            'max_tokens', 'temperature', 'top_p', 'n', 'stream',
            'presence_penalty', 'frequency_penalty', 'stop', 'logprobs',
            'tools', 'tool_choice', 'logit_bias',
            'response_format',
        }
        if isinstance(self.kwargs, dict):
            for k, v in self.kwargs.items():
                if k in allowed_keys:
                    payload[k] = v
        if response_format is not None:
            payload['response_format'] = response_format

        # 对输出 token 上限做保护（部分模型 4k 上限，统一取不超过 10000）
        try:
            if isinstance(payload.get('max_tokens'), int) and payload['max_tokens'] > 10000:
                payload['max_tokens'] = 10000
        except Exception:
            pass

        start_time = time.time()
        request_bases = self._iter_retry_bases(total_attempts=6)
        last_error: Exception | None = None
        for attempt_idx, req_base in enumerate(request_bases, start=1):
            request_url = self._build_chat_completions_url(req_base)
            try:
                response = requests.post(request_url, headers=headers, json=payload, timeout=120)
                response.raise_for_status()
                try:
                    response_data = response.json()
                except ValueError:
                    print("API 响应无法解析为 JSON，原始文本预览:", response.text[:500])
                    raise

                debug_raw = os.getenv("DPR_LLM_DEBUG_RAW") == "1" or os.getenv("LLM_DEBUG_RAW") == "1"
                if debug_raw:
                    print("[DEBUG] LLM 原始响应包:", response.text)

                if isinstance(response_data, dict) and 'error' in response_data:
                    err = response_data.get('error') or {}
                    print("API 返回错误:", {
                        'type': err.get('type'),
                        'code': err.get('code'),
                        'message': err.get('message') or err,
                    })
                    raise requests.exceptions.HTTPError(f"API error: {err}")

                if 'choices' not in response_data or not response_data['choices']:
                    print("API 响应不包含 choices 字段或为空：", str(response_data)[:500])
                    raise requests.exceptions.HTTPError("API response missing choices")

                choice = response_data['choices'][0] if isinstance(response_data['choices'][0], dict) else {}
                message = choice.get('message', {}) if isinstance(choice, dict) else {}
                content = self._extract_text_content(message.get('content'))
                reasoning_content = self._extract_text_content(message.get('reasoning_content'))
                refusal = str(message.get('refusal') or '').strip()
                finish_reason = choice.get('finish_reason') if isinstance(choice, dict) else None

                usage = response_data.get('usage', {})
                prompt_tokens = usage.get('prompt_tokens', 0)
                completion_tokens = usage.get('completion_tokens', 0)
                total_tokens = usage.get('total_tokens', 0)
                reasoning_tokens = 0
                if 'completion_tokens_details' in usage:
                    reasoning_tokens = usage['completion_tokens_details'].get('reasoning_tokens', 0)

                self.tokens['prompt'] += prompt_tokens
                self.tokens['content'] += completion_tokens - reasoning_tokens
                self.tokens['reasoning'] += reasoning_tokens
                self.tokens['total'] += total_tokens

                try:
                    GLOBAL_TOKENS['prompt'] += int(prompt_tokens)
                    GLOBAL_TOKENS['thinking'] += int(reasoning_tokens)
                    GLOBAL_TOKENS['content'] += int(completion_tokens - reasoning_tokens)
                    GLOBAL_TOKENS['total'] += int(total_tokens)
                except Exception:
                    pass

                try:
                    elapsed = time.time() - start_time
                    self._cum_time_seconds += float(elapsed)
                    try:
                        global GLOBAL_TIME_SECONDS
                        GLOBAL_TIME_SECONDS += float(elapsed)
                    except Exception:
                        pass

                    self._call_index += 1
                    self._cum_tokens['prompt'] += int(prompt_tokens)
                    self._cum_tokens['thinking'] += int(reasoning_tokens)
                    self._cum_tokens['content'] += int(completion_tokens - reasoning_tokens)
                    self._cum_tokens['total'] += int(total_tokens)

                    provider = self._provider_name(req_base)
                    header = f"[{provider}][{self.model}] 第{self._call_index}次"
                    line_cur = (
                        f"本次 tokens：prompt={int(prompt_tokens)}, thinking={int(reasoning_tokens)}, "
                        f"content={int(completion_tokens - reasoning_tokens)}, total={int(total_tokens)}"
                    )
                    line_cum = (
                        f"累计 tokens：prompt={self._cum_tokens['prompt']}, thinking={self._cum_tokens['thinking']}, "
                        f"content={self._cum_tokens['content']}, total={self._cum_tokens['total']}"
                    )
                    line_time = (
                        f"本次用时：{elapsed:.2f}s，"
                        f"累计用时：{self._cum_time_seconds:.2f}s"
                    )
                    print(header + "\n" + line_cur + "\n" + line_cum + "\n" + line_time)
                except Exception:
                    pass

                return {
                    "content": content,
                    "raw_content": message.get('content'),
                    "reasoning_content": reasoning_content,
                    "refusal": refusal,
                    "finish_reason": finish_reason,
                    "message": message,
                    "raw_response": response_data,
                    "tokens": {
                        "prompt": prompt_tokens,
                        "content": completion_tokens - reasoning_tokens,
                        "reasoning": reasoning_tokens,
                        "total": total_tokens
                    }
                }

            except Exception as e:
                last_error = e
                if response_format is not None and self._is_structured_output_unsupported_error(e):
                    raise
                if self._is_auth_error(e):
                    print(f"LLM 认证失败（base={self._redact_sensitive_text(req_base)}）：请检查 DPR_LLM_API_KEY / base_url。")
                    self._print_response_error(e)
                    raise LLMAuthenticationError(str(e)) from e
                if attempt_idx < len(request_bases):
                    next_base = request_bases[attempt_idx] if attempt_idx < len(request_bases) else ''
                    print(
                        f"请求失败（base={self._redact_sensitive_text(req_base)}，第 {attempt_idx} 次），"
                        f"将回退到 {self._redact_sensitive_text(next_base)}"
                    )
                    self._print_response_error(e)
                    continue
                print(f"通过 requests 调用 API 时出错: {self._redact_sensitive_text(e)}")
                self._print_response_error(e)
                raise

        if last_error is not None:
            raise last_error
        raise RuntimeError("LLM 请求未命中可用 base")

    def chat_structured(
        self,
        messages: List[Dict[str, str]],
        schema_name: str,
        schema: Dict[str, Any],
        *,
        strict: bool = True,
        allow_json_object_fallback: bool = True,
        allow_plain_json_fallback: bool = True,
    ) -> Dict[str, Any]:
        attempts: List[Tuple[str, Optional[Dict[str, Any]]]] = []
        if self._supports_json_schema_response_format() or not allow_json_object_fallback:
            attempts.append((
                "json_schema",
                self.build_json_schema_response_format(
                    schema_name=schema_name,
                    schema=schema,
                    strict=strict,
                ),
            ))
        if allow_json_object_fallback:
            attempts.append(("json_object", self.build_json_object_response_format()))
        if allow_plain_json_fallback:
            attempts.append(("plain_json", None))

        last_error: Exception | None = None
        for idx, (format_name, response_format) in enumerate(attempts):
            try:
                response = self.chat(messages=messages, response_format=response_format)
            except Exception as exc:
                last_error = exc
                if idx + 1 < len(attempts) and self._is_structured_output_unsupported_error(exc):
                    print(
                        f"[INFO] Structured Outputs 不受支持，回退到 {attempts[idx + 1][0]}。"
                    )
                    continue
                raise

            parsed = None
            parse_error: Exception | None = None
            if not response.get("refusal"):
                content = str(response.get("content") or "").strip()
                if content:
                    try:
                        parsed = self.parse_json_content(content)
                    except Exception as exc:
                        parse_error = exc

            structured = dict(response)
            structured["parsed"] = parsed
            structured["parse_error"] = parse_error
            structured["response_format_used"] = format_name
            return structured

        if last_error is not None:
            raise last_error
        raise RuntimeError("结构化输出请求未命中可用格式")

    def rerank(
        self,
        query: str,
        documents: List[str],
        top_n: Optional[int] = None,
        model: Optional[str] = None,
    ) -> dict:
        """第一版不内置 native rerank；流水线默认使用 RRF fallback。"""
        raise NotImplementedError("当前未配置 native rerank；请使用 RRF fallback。")


class OpenAICompatibleClient(LLMClient):
    """任意 OpenAI-compatible Chat Completions 服务。"""

    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str = DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    ):
        super().__init__(api_key=api_key, model=model, base_url=base_url)


def _read_env_text(*names: str) -> str:
    for name in names:
        value = str(os.getenv(name) or "").strip()
        if value:
            return value
    return ""


def _normalize_provider(value: str | None) -> str:
    provider = str(value or "").strip().lower()
    return provider or "openai-compatible"


def _strip_openai_compatible_prefix(model: str) -> str:
    text = str(model or "").strip()
    for prefix in ("openai-compatible/", "openai/"):
        if text.lower().startswith(prefix):
            return text.split("/", 1)[1].strip()
    return text


def _task_model_env_names(task: str) -> List[str]:
    key = str(task or "").strip().lower().replace("-", "_")
    mapping = {
        "rewrite": ["DPR_LLM_REWRITE_MODEL"],
        "filter": ["DPR_LLM_FILTER_MODEL"],
        "refine": ["DPR_LLM_FILTER_MODEL"],
        "summary": ["DPR_LLM_SUMMARY_MODEL"],
        "docs": ["DPR_LLM_SUMMARY_MODEL"],
        "chat": ["DPR_LLM_CHAT_MODEL"],
    }
    return mapping.get(key, [])


def make_task_client(
    task: str = "default",
    *,
    model: str | None = None,
    api_key: str | None = None,
    base_url: str | None = None,
) -> LLMClient:
    """
    从通用 DPR_LLM_* 环境变量创建 OpenAI-compatible 客户端。

    优先级：
    - api_key 参数 / DPR_LLM_API_KEY / LLM_API_KEY / OPENAI_API_KEY
    - base_url 参数 / DPR_LLM_BASE_URL / LLM_BASE_URL / OPENAI_BASE_URL
    - model 参数 / 任务模型变量 / DPR_LLM_MODEL / LLM_MODEL
    """
    provider = _normalize_provider(_read_env_text("DPR_LLM_PROVIDER", "LLM_PROVIDER"))
    if provider not in {"openai-compatible", "openai", "generic", "custom"}:
        raise ValueError(
            f"不支持的 DPR_LLM_PROVIDER={provider!r}；第一版仅支持 OpenAI-compatible Chat Completions。"
        )

    resolved_api_key = str(api_key or "").strip() or _read_env_text(
        "DPR_LLM_API_KEY",
        "LLM_API_KEY",
        "OPENAI_API_KEY",
        "DEEPSEEK_API_KEY",
    )
    if not resolved_api_key:
        raise RuntimeError("缺少 DPR_LLM_API_KEY（或 LLM_API_KEY / OPENAI_API_KEY）。")

    resolved_base_url = str(base_url or "").strip() or _read_env_text(
        "DPR_LLM_BASE_URL",
        "LLM_BASE_URL",
        "OPENAI_BASE_URL",
    )
    if not resolved_base_url:
        resolved_base_url = DEFAULT_OPENAI_COMPATIBLE_BASE_URL

    model_candidates = [str(model or "").strip()]
    model_candidates.extend(_read_env_text(name) for name in _task_model_env_names(task))
    model_candidates.extend([
        _read_env_text("DPR_LLM_MODEL"),
        _read_env_text("LLM_MODEL"),
    ])
    resolved_model = ""
    for candidate in model_candidates:
        candidate = _strip_openai_compatible_prefix(candidate)
        if candidate:
            resolved_model = candidate
            break
    if not resolved_model:
        raise RuntimeError(
            f"缺少 {task} 模型配置：请设置 DPR_LLM_MODEL 或对应任务模型环境变量。"
        )

    return OpenAICompatibleClient(
        api_key=resolved_api_key,
        model=resolved_model,
        base_url=resolved_base_url,
    )


class ClientFactory:
    @staticmethod
    def from_env(task: str = "default"):
        return make_task_client(task=task)

    @staticmethod
    def from_config(_config: dict | None = None):
        """
        兼容旧调用入口，但不再读取 config 文件，统一从环境变量读取。
        """
        return ClientFactory.from_env()
