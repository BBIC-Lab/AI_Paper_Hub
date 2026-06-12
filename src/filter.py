#!/usr/bin/env python
# 通用向量检索工具：封装 sentence-transformers 的向量计算与粗筛逻辑

from __future__ import annotations

import os
import numpy as np
from typing import Any, Dict, List, TYPE_CHECKING
import time
from datetime import datetime, timezone

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

from model_loader import is_remote_embedding_enabled, load_sentence_transformer

if TYPE_CHECKING:
  from sentence_transformers import SentenceTransformer

# E5 系列推荐使用 query/passage 前缀；BGE 系列默认不套 E5 前缀。
E5_QUERY_PREFIX = "query: "
E5_PASSAGE_PREFIX = "passage: "
SUPPORTED_EMBED_PREFIX_MODES = {"auto", "e5", "bge", "none", "custom"}


def log(message: str) -> None:
  ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
  print(f"[{ts}] {message}", flush=True)

def debug_hf_runtime(prefix: str) -> None:
  """
  打印 Hugging Face 相关的运行时信息，用于排查 CI 环境下的缓存路径/符号链接问题。
  - 默认仅在 GitHub Actions 或 DPR_DEBUG_HF=1 时输出，避免本地运行过于冗长。
  """
  enable = (os.getenv("DPR_DEBUG_HF") == "1") or (os.getenv("GITHUB_ACTIONS") == "true")
  if not enable:
    return
  if is_remote_embedding_enabled():
    return

  log(f"[DEBUG][HF] {prefix}")
  keys = [
    "GITHUB_ACTIONS",
    "GITHUB_WORKSPACE",
    "HOME",
    "HF_HOME",
    "HUGGINGFACE_HUB_CACHE",
    "HF_HUB_DISABLE_SYMLINKS",
    "TRANSFORMERS_CACHE",
    "XDG_CACHE_HOME",
  ]
  for k in keys:
    log(f"[DEBUG][HF] env {k}={os.getenv(k, '<unset>')}")

  try:
    import huggingface_hub  # type: ignore
    log(f"[DEBUG][HF] huggingface_hub={getattr(huggingface_hub, '__version__', '<unknown>')}")
    try:
      from huggingface_hub import constants as c  # type: ignore
      log(f"[DEBUG][HF] constants.HF_HOME={getattr(c, 'HF_HOME', None)}")
      log(f"[DEBUG][HF] constants.HUGGINGFACE_HUB_CACHE={getattr(c, 'HUGGINGFACE_HUB_CACHE', None)}")
      log(f"[DEBUG][HF] constants.HF_HUB_DISABLE_SYMLINKS={getattr(c, 'HF_HUB_DISABLE_SYMLINKS', None)}")
    except Exception as e:
      log(f"[DEBUG][HF] import huggingface_hub.constants failed: {e}")
  except Exception as e:
    log(f"[DEBUG][HF] import huggingface_hub failed: {e}")

  # 目录快速探测（不递归，避免刷屏）
  def ls_dir(path: str) -> None:
    try:
      items = os.listdir(path)
      items = items[:30]
      log(f"[DEBUG][HF] ls {path} ({len(items)} items shown): {items}")
    except Exception as e:
      log(f"[DEBUG][HF] ls {path} failed: {e}")

  ls_dir(os.path.expanduser("~/.cache/huggingface"))
  hf_home = os.getenv("HF_HOME")
  if hf_home:
    ls_dir(hf_home)


def _set_max_seq_length(model: Any, max_length: int | None) -> None:
  """尽量通过 SentenceTransformer 的 max_seq_length 控制截断长度。"""
  if max_length is None or max_length <= 0:
    return
  if hasattr(model, "max_seq_length"):
    try:
      model.max_seq_length = max_length
      return
    except Exception:
      pass


def _model_name_from_obj(model: Any, fallback: str = "") -> str:
  for attr in ("model_name", "_dpr_model_name", "model_name_or_path"):
    value = getattr(model, attr, "")
    if value:
      return str(value)
  return str(fallback or os.getenv("DPR_EMBED_MODEL") or "")


def resolve_embedding_prefixes(model_name: str | None = None) -> Dict[str, str]:
  """
  按模型族解析 query/passage 前缀：
  - auto: E5 使用官方前缀，BGE/未知模型不强制加前缀；
  - custom: 完全使用环境变量覆盖。
  """
  mode = str(os.getenv("DPR_EMBED_PREFIX_MODE") or "auto").strip().lower()
  if mode not in SUPPORTED_EMBED_PREFIX_MODES:
    mode = "auto"
  custom_query = str(os.getenv("DPR_EMBED_QUERY_PREFIX") or "")
  custom_passage = str(os.getenv("DPR_EMBED_PASSAGE_PREFIX") or "")
  if mode == "custom":
    return {"query": custom_query, "passage": custom_passage}
  if mode == "e5":
    return {"query": E5_QUERY_PREFIX, "passage": E5_PASSAGE_PREFIX}
  if mode in {"bge", "none"}:
    return {"query": "", "passage": ""}

  name = str(model_name or "").strip().lower()
  if "e5" in name:
    return {"query": E5_QUERY_PREFIX, "passage": E5_PASSAGE_PREFIX}
  return {"query": "", "passage": ""}


def decorate_query_text(text: str, model_name: str | None = None) -> str:
  value = str(text or "").strip()
  if not value:
    return ""
  prefix = resolve_embedding_prefixes(model_name).get("query") or ""
  return f"{prefix}{value}" if prefix else value


def decorate_passage_text(text: str, model_name: str | None = None) -> str:
  value = str(text or "").strip()
  if not value:
    return ""
  prefix = resolve_embedding_prefixes(model_name).get("passage") or ""
  return f"{prefix}{value}" if prefix else value
  if hasattr(model, "_first_module"):
    try:
      first = model._first_module()
      if hasattr(first, "max_seq_length"):
        first.max_seq_length = max_length
    except Exception:
      pass


def encode_queries(
  model: Any,
  texts: List[str],
  batch_size: int = 8,
  max_length: int | None = None,
  model_name: str | None = None,
) -> np.ndarray:
  """
  编码查询文本向量；前缀由 DPR_EMBED_PREFIX_MODE 和模型名共同决定。
  """
  resolved_model_name = model_name or _model_name_from_obj(model)
  decorated: List[str] = []
  for t in texts:
    t = (t or "").strip()
    if not t:
      decorated.append("")
    else:
      decorated.append(decorate_query_text(t, resolved_model_name))

  _set_max_seq_length(model, max_length)

  encode_kwargs: Dict[str, Any] = {
    "convert_to_numpy": True,
    "normalize_embeddings": True,
    "show_progress_bar": False,
    "batch_size": batch_size,
  }

  return model.encode(
    decorated,
    **encode_kwargs,
  )


def compute_embeddings(
  model: Any,
  items: List[Any],
  batch_size: int = 8,
  max_length: int | None = None,
  log_every: int = 20,
) -> np.ndarray:
  """
  为给定列表计算向量表示。
  约定：每个元素需提供 text_for_embedding 属性，返回「用于向量化的文本」。
  返回形状为 (N, D) 的 numpy 数组，并做归一化，便于用点积近似余弦相似度。
  """
  texts = []
  for it in items:
    text = getattr(it, "text_for_embedding", None)
    if callable(text):
      text = text()
    if isinstance(text, str):
      texts.append(text)
    else:
      texts.append(str(it))

  _set_max_seq_length(model, max_length)

  if not texts:
    return np.zeros((0, 0), dtype=np.float32)

  total = len(texts)
  log(f"[INFO] 正在为 {total} 条记录计算向量表示...")
  encode_kwargs: Dict[str, Any] = {
    "convert_to_numpy": True,
    "normalize_embeddings": True,
    "batch_size": batch_size,
  }

  embeddings_list: List[np.ndarray] = []
  start_time = time.time()
  processed = 0
  next_log_at = log_every if log_every > 0 else 0
  for start in range(0, total, batch_size):
    batch = texts[start : start + batch_size]
    batch_emb = model.encode(batch, **encode_kwargs)
    embeddings_list.append(batch_emb)
    processed += len(batch)
    if log_every > 0:
      while processed >= next_log_at and next_log_at <= total:
        elapsed = time.time() - start_time
        rate = processed / elapsed if elapsed > 0 else 0.0
        log(f"[INFO] Embedding 进度: {processed}/{total} (~{rate:.2f} paper/s)")
        next_log_at += log_every
    elif processed == total:
      elapsed = time.time() - start_time
      rate = processed / elapsed if elapsed > 0 else 0.0
      log(f"[INFO] Embedding 进度: {processed}/{total} (~{rate:.2f} paper/s)")

  return np.vstack(embeddings_list)


class EmbeddingCoarseFilter:
  """
  基于 sentence-transformers 的粗筛类：
  - 内部持有一个向量模型；
  - 对论文池按多个查询做相似度排序；
  - 只关注「召回 + 相似度排序」，具体 tag 等逻辑由调用方处理。
  """

  def __init__(
    self,
    model_name: str,
    top_k: int = 50,
    device: str | None = None,
    batch_size: int = 8,
    max_length: int | None = None,
  ):
    self.model_name = model_name
    self.top_k = top_k
    self.batch_size = batch_size
    self.max_length = max_length

    remote_mode = is_remote_embedding_enabled()
    if device is None:
      if remote_mode:
        self.device = "remote"
      else:
        try:
          import torch
          self.device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
          self.device = "cpu"
    else:
      self.device = device if not remote_mode else "remote"

    if remote_mode:
      print(f"[INFO] 正在初始化远程向量服务：{self.model_name}，device={self.device}")
    else:
      print(f"[INFO] 正在加载本地向量模型：{self.model_name}，device={self.device}")
      debug_hf_runtime("before SentenceTransformer()")
    self.model = load_sentence_transformer(self.model_name, device=self.device)
    try:
      setattr(self.model, "_dpr_model_name", self.model_name)
    except Exception:
      pass
    if not remote_mode:
      debug_hf_runtime("after SentenceTransformer()")
    _set_max_seq_length(self.model, self.max_length)

  def filter(self, items: List[Any], queries: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    使用内部向量模型，对给定对象列表按 queries 做粗筛。

    约定：
    - items：需要提供 text_for_embedding，用于构造向量；
    - queries：每个元素至少包含 query_text 字段，其余字段原样透传。
    返回结构：
    {
      "queries": [ { ... 原 query 字段 ..., "top_indices": [int, ...] }, ... ],
      "embeddings": np.ndarray  # items 对应的向量
    }
    """
    if not items:
      print("[WARN] items 为空，跳过粗筛。")
      return {"queries": [], "embeddings": None}
    if not queries:
      print("[WARN] 查询列表为空，跳过粗筛。")
      return {"queries": [], "embeddings": None}

    item_embeddings = compute_embeddings(
      self.model,
      items,
      batch_size=self.batch_size,
      max_length=self.max_length,
    )

    results_per_query: List[Dict[str, Any]] = []

    for q in queries:
      q_text = (q.get("query_text") or "").strip()
      if not q_text:
        continue

      print(f"[INFO] Embedding 粗筛：query_text={q_text[:40]}...")

      # 查询侧使用 E5 的 query 前缀
      q_emb = encode_queries(
        self.model,
        [q_text],
        batch_size=self.batch_size,
        max_length=self.max_length,
        model_name=self.model_name,
      )[0]

      sims = np.dot(item_embeddings, q_emb)

      if self.top_k <= 0 or self.top_k > sims.shape[0]:
        k = sims.shape[0]
      else:
        k = self.top_k

      indices = np.argsort(-sims)[:k]

      enriched = dict(q)
      enriched["top_indices"] = indices.tolist()
      results_per_query.append(enriched)

    return {
      "queries": results_per_query,
      "embeddings": item_embeddings,
    }
