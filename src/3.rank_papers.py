#!/usr/bin/env python
# Step 3：第一版不依赖专用 rerank API，默认把 RRF 结果转成 ranked 结构。

import argparse
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

try:
  from core import artifacts as core_artifacts
  from core.diagnostics import annotate_stage_ranks
  from core import paths as core_paths
except Exception:  # pragma: no cover - package import fallback
  from src.core import artifacts as core_artifacts
  from src.core.diagnostics import annotate_stage_ranks
  from src.core import paths as core_paths

try:
  from reranker import create_reranker_from_env
except Exception:  # pragma: no cover - package import fallback
  from src.reranker import create_reranker_from_env

SCRIPT_DIR = os.path.dirname(__file__)
ROOT_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
TODAY_STR = core_paths.run_date_from_env()
ARCHIVE_DIR = str(core_paths.archive_dir(ROOT_DIR, TODAY_STR))
FILTERED_DIR = str(core_paths.filtered_dir(ROOT_DIR, TODAY_STR))
RANKED_DIR = str(core_paths.rank_dir(ROOT_DIR, TODAY_STR))

MAX_CHARS_PER_DOC = 850
BATCH_SIZE = 100
TOKEN_SAFETY = 29000
RRF_K = 60
LANE_TOP_K_BASE = 30
LANE_TOP_K_STEP = 10
LANE_TOP_K_MAX = 120
GLOBAL_POOL_GUARANTEED_MIN = 5
GLOBAL_POOL_GUARANTEED_MAX = 20
GLOBAL_POOL_RRF_MIN = 60
GLOBAL_POOL_RRF_MAX = 300
DEFAULT_RECOMMEND_MIX = {"core_ratio": 2, "inspiration_ratio": 3}
TRACK_CORE = "core"
TRACK_INSPIRATION = "inspiration"
RERANK_PASS1_KEEP_PER_BATCH = 30


def log(message: str) -> None:
  ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
  print(f"[{ts}] {message}", flush=True)


def group_start(title: str) -> None:
  print(f"::group::{title}", flush=True)


def group_end() -> None:
  print("::endgroup::", flush=True)

def build_token_encoder():
  try:
    import tiktoken  # type: ignore
    return tiktoken.get_encoding("cl100k_base")
  except Exception:
    return None


def estimate_tokens(text: str, encoder) -> int:
  if encoder is None:
    return max(1, len(text) // 3)
  return len(encoder.encode(text))


def score_to_stars(score: float) -> int:
  if score >= 0.9:
    return 5
  if score >= 0.5:
    return 4
  if score >= 0.1:
    return 3
  if score >= 0.01:
    return 2
  return 1


def build_ranked_from_sim_scores(query_obj: Dict[str, Any]) -> List[Dict[str, Any]]:
  sim_scores = query_obj.get("sim_scores")
  if not isinstance(sim_scores, dict) or not sim_scores:
    return []

  items: List[Tuple[str, float | None, int | None]] = []
  for pid, meta in sim_scores.items():
    score = None
    rank = None
    if isinstance(meta, dict):
      raw_score = meta.get("score")
      raw_rank = meta.get("rank")
      if isinstance(raw_score, (int, float)):
        score = float(raw_score)
      if isinstance(raw_rank, (int, float)):
        rank = int(raw_rank)
    elif isinstance(meta, (int, float)):
      score = float(meta)
    items.append((str(pid), score, rank))

  items.sort(
    key=lambda item: (
      item[2] is None,
      item[2] if item[2] is not None else 10**9,
      -(item[1] if item[1] is not None else 0.0),
      item[0],
    )
  )
  if not items:
    return []

  numeric_scores = [item[1] for item in items if item[1] is not None]
  min_score = min(numeric_scores) if numeric_scores else None
  max_score = max(numeric_scores) if numeric_scores else None
  total = len(items)
  ranked: List[Dict[str, Any]] = []
  for idx, (pid, score, _rank) in enumerate(items, start=1):
    if (
      score is not None
      and min_score is not None
      and max_score is not None
      and max_score > min_score
    ):
      normalized = (score - min_score) / (max_score - min_score)
    elif total == 1:
      normalized = 1.0
    else:
      normalized = (total - idx) / (total - 1)
    ranked.append(
      {
        "paper_id": pid,
        "score": float(normalized),
        "star_rating": score_to_stars(float(normalized)),
      }
    )
  return ranked


def load_json(path: str) -> Dict[str, Any]:
  if not os.path.exists(path):
    raise FileNotFoundError(f"找不到文件：{path}")
  return core_artifacts.read_json_object(path)


def save_json(data: Dict[str, Any], path: str) -> None:
  core_artifacts.write_json(path, data)
  log(f"[INFO] 已将打分结果写入：{path}")


def save_rank_payload(data: Dict[str, Any], output_path: str) -> None:
  annotate_stage_ranks(data.get("papers") or [], data.get("queries") or [], "rerank")
  save_json(data, output_path)


def format_doc(title: str, abstract: str) -> str:
  content = f"Title: {title}\nAbstract: {abstract}".strip()
  if len(content) > MAX_CHARS_PER_DOC:
    content = content[:MAX_CHARS_PER_DOC]
  return content


def build_documents(papers_by_id: Dict[str, Dict[str, Any]], paper_ids: List[str]) -> List[str]:
  docs: List[str] = []
  for pid in paper_ids:
    p = papers_by_id.get(pid)
    if not p:
      docs.append(f"[Missing paper {pid}]")
      continue
    title = (p.get("title") or "").strip()
    abstract = (p.get("abstract") or "").strip()
    if title or abstract:
      docs.append(format_doc(title, abstract))
    else:
      docs.append(f"[Empty paper {pid}]")
  return docs


def get_top_ids(query_obj: Dict[str, Any]) -> List[str]:
  sim_scores = query_obj.get("sim_scores") or {}
  top_ids = query_obj.get("top_ids") or []
  if not top_ids and isinstance(sim_scores, dict) and sim_scores:
    top_ids = sorted(sim_scores.keys(), key=lambda pid: sim_scores[pid].get("rank", 1e9))
  return list(top_ids)


def _unique_keep_order(items: List[str]) -> List[str]:
  seen = set()
  out: List[str] = []
  for item in items:
    pid = str(item or "").strip()
    if not pid or pid in seen:
      continue
    seen.add(pid)
    out.append(pid)
  return out


def _clamp_int(value: float | int, min_value: int, max_value: int) -> int:
  return max(min_value, min(int(value), max_value))


def _as_nonnegative_int(value: Any, default: int) -> int:
  try:
    parsed = int(value)
  except Exception:
    return default
  return parsed if parsed >= 0 else default


def normalize_recommend_mix(value: Any) -> Dict[str, int]:
  raw = value if isinstance(value, dict) else {}
  core = _as_nonnegative_int(raw.get("core_ratio"), DEFAULT_RECOMMEND_MIX["core_ratio"])
  inspiration = _as_nonnegative_int(raw.get("inspiration_ratio"), DEFAULT_RECOMMEND_MIX["inspiration_ratio"])
  if core <= 0 and inspiration <= 0:
    return dict(DEFAULT_RECOMMEND_MIX)
  return {"core_ratio": core, "inspiration_ratio": inspiration}


def normalize_query_track(query: Dict[str, Any]) -> str:
  raw = str(query.get("query_track") or "").strip().lower()
  if raw in {TRACK_CORE, TRACK_INSPIRATION, "bridge"}:
    return raw
  q_type = str(query.get("type") or "").strip().lower()
  if q_type in {"keyword"}:
    return TRACK_INSPIRATION
  return TRACK_CORE


def query_track_enabled(query: Dict[str, Any]) -> bool:
  mix = normalize_recommend_mix(query.get("recommend_mix"))
  track = normalize_query_track(query)
  if track == TRACK_CORE:
    return int(mix.get("core_ratio") or 0) > 0
  if track == TRACK_INSPIRATION:
    return int(mix.get("inspiration_ratio") or 0) > 0
  return int(mix.get("core_ratio") or 0) > 0 and int(mix.get("inspiration_ratio") or 0) > 0


def build_track_rerank_query_text(query: Dict[str, Any]) -> str:
  q_text = str(query.get("rewrite") or query.get("query_text") or "").strip()
  if normalize_query_track(query) != TRACK_INSPIRATION:
    return q_text
  core_context = str(query.get("core_context") or "").strip()
  if not core_context:
    return q_text
  # 通用启发通路：锚定“可迁移机制”，避免泛化到任意热门方法论文。
  return (
    f"Reusable method/query: {q_text}. "
    f"User research context for possible transfer: {core_context}. "
    "Rank high only when the paper offers a concrete mechanism, model, tool, or analysis route "
    "that can plausibly transfer to the research context."
  )


def resolve_global_pool_budget(
  total_papers: int,
  intent_query_count: int,
) -> Tuple[int, int, int]:
  """
  统一候选池预算：
  - lane_top_k 随论文总数递增：1000 篇内 30，每增加 1000 篇 +10，上限 120；
  - guaranteed_per_lane = lane_top_k 的 25%，限制在 [5, 20]；
  - global_rrf_top = lane_top_k * intent_query_count，限制在 [60, 300]。
  """
  total = max(int(total_papers or 0), 0)
  intent_count = max(int(intent_query_count or 0), 1)
  if total <= 0:
    lane_top_k = LANE_TOP_K_BASE
  else:
    blocks = (total - 1) // 1000
    lane_top_k = min(LANE_TOP_K_BASE + LANE_TOP_K_STEP * blocks, LANE_TOP_K_MAX)
  guaranteed_per_lane = _clamp_int(
    round(lane_top_k * 0.25),
    GLOBAL_POOL_GUARANTEED_MIN,
    GLOBAL_POOL_GUARANTEED_MAX,
  )
  global_rrf_top = _clamp_int(
    lane_top_k * intent_count,
    GLOBAL_POOL_RRF_MIN,
    GLOBAL_POOL_RRF_MAX,
  )
  return lane_top_k, guaranteed_per_lane, global_rrf_top


def build_global_candidate_ids(
  queries: List[Dict[str, Any]],
  *,
  guaranteed_per_lane: int,
  global_limit: int,
  enabled_tracks: set[str] | None = None,
  target_track: str | None = None,
) -> List[str]:
  """
  将所有 query lane 的候选论文合并成统一候选池。
  - 不区分 keyword / intent_query 来源；
  - 使用 rank-based RRF 做全局聚合，避免不同分数量纲直接混用；
  - 每条 lane 的前 guaranteed_per_lane 固定保留；
  - 再加入全局 RRF 前 global_limit 篇；
  - 最终按“固定保留 + 全局排序”去重合并。
  """
  score_map: Dict[str, float] = {}
  hit_count: Dict[str, int] = {}
  guaranteed_ids: List[str] = []

  for q in queries or []:
    q_track = normalize_query_track(q)
    if target_track and q_track != target_track:
      continue
    if enabled_tracks is not None and q_track not in enabled_tracks:
      continue
    if not query_track_enabled(q):
      continue
    top_ids = get_top_ids(q)
    if not top_ids:
      continue
    if guaranteed_per_lane > 0:
      guaranteed_ids.extend(top_ids[:guaranteed_per_lane])
    for rank_idx, pid in enumerate(top_ids, start=1):
      paper_id = str(pid or "").strip()
      if not paper_id:
        continue
      score_map[paper_id] = score_map.get(paper_id, 0.0) + 1.0 / (RRF_K + rank_idx)
      hit_count[paper_id] = hit_count.get(paper_id, 0) + 1

  ranked = sorted(
    score_map.items(),
    key=lambda item: (
      -item[1],
      -hit_count.get(item[0], 0),
      item[0],
    ),
  )
  global_ids = [pid for pid, _score in ranked]
  if global_limit > 0:
    global_ids = global_ids[:global_limit]
  return _unique_keep_order(list(guaranteed_ids) + list(global_ids))


def iter_batches(
  docs_with_idx: List[Tuple[int, str]],
  query_tokens: int,
  encoder,
) -> List[Tuple[List[int], List[str]]]:
  batches: List[Tuple[List[int], List[str]]] = []
  pos = 0
  while pos < len(docs_with_idx):
    total_tokens = query_tokens
    batch_docs: List[str] = []
    batch_indices: List[int] = []

    while pos < len(docs_with_idx) and len(batch_docs) < BATCH_SIZE:
      orig_idx, doc = docs_with_idx[pos]
      doc_tokens = estimate_tokens(doc, encoder)
      if total_tokens + doc_tokens > TOKEN_SAFETY and batch_docs:
        break
      batch_docs.append(doc)
      batch_indices.append(orig_idx)
      total_tokens += doc_tokens
      pos += 1

    if not batch_docs:
      pos += 1
      continue
    batches.append((batch_indices, batch_docs))
  return batches


def rrf_merge(scores: Dict[int, float], rank_idx: int, orig_idx: int) -> None:
  scores[orig_idx] = scores.get(orig_idx, 0.0) + 1.0 / (RRF_K + rank_idx)


def _extract_rerank_results(response: Any) -> List[Dict[str, Any]]:
  if isinstance(response, dict) and "output" in response:
    results = response.get("output", {}).get("results", [])
  elif isinstance(response, dict):
    results = response.get("results", [])
  else:
    results = []
  return [item for item in (results or []) if isinstance(item, dict)]


def _rerank_score(item: Dict[str, Any]) -> float:
  raw = item.get("relevance_score", item.get("score", 0.0))
  try:
    return float(raw)
  except Exception:
    return 0.0


def _normalize_ranked_scores(items: List[Tuple[int, float]]) -> List[Tuple[int, float]]:
  if not items:
    return []
  values = [score for _, score in items]
  min_score = min(values)
  max_score = max(values)
  denom = max_score - min_score
  if denom <= 0:
    return [(idx, 1.0) for idx, _score in items]
  return [(idx, (score - min_score) / denom) for idx, score in items]


def rerank_documents_two_pass(
  reranker: Any,
  *,
  query_text: str,
  documents: List[str],
  encoder: Any,
  rerank_model: str,
) -> List[Tuple[int, float]]:
  docs_with_idx = list(enumerate(documents))
  query_tokens = estimate_tokens(query_text, encoder)
  batches = iter_batches(docs_with_idx, query_tokens, encoder)
  if not batches:
    return []

  pass1: Dict[int, float] = {}
  for batch_idx, (batch_indices, batch_docs) in enumerate(batches, 1):
    log(f"[INFO] pass1 rerank batch {batch_idx}/{len(batches)} | docs={len(batch_docs)}")
    response = reranker.rerank(
      query=query_text,
      documents=batch_docs,
      top_n=len(batch_docs),
      model=rerank_model,
    )
    ranked = sorted(
      _extract_rerank_results(response),
      key=lambda item: _rerank_score(item),
      reverse=True,
    )
    keep_n = len(ranked) if len(batches) == 1 else min(len(ranked), RERANK_PASS1_KEEP_PER_BATCH)
    for item in ranked[:keep_n]:
      idx = int(item.get("index", -1))
      if idx < 0 or idx >= len(batch_indices):
        continue
      orig_idx = batch_indices[idx]
      pass1[orig_idx] = max(pass1.get(orig_idx, float("-inf")), _rerank_score(item))

  if not pass1:
    return []
  if len(batches) == 1:
    ranked_once = sorted(pass1.items(), key=lambda item: (-item[1], item[0]))
    return _normalize_ranked_scores(ranked_once)

  merged_indices = [
    idx
    for idx, _score in sorted(pass1.items(), key=lambda item: (-item[1], item[0]))
  ]
  merged_docs = [(idx, documents[idx]) for idx in merged_indices]
  pass2_batches = iter_batches(merged_docs, query_tokens, encoder)
  pass2_scores: Dict[int, float] = {}
  for batch_idx, (batch_indices, batch_docs) in enumerate(pass2_batches, 1):
    log(f"[INFO] pass2 rerank batch {batch_idx}/{len(pass2_batches)} | docs={len(batch_docs)}")
    response = reranker.rerank(
      query=query_text,
      documents=batch_docs,
      top_n=len(batch_docs),
      model=rerank_model,
    )
    ranked = sorted(
      _extract_rerank_results(response),
      key=lambda item: _rerank_score(item),
      reverse=True,
    )
    for rank_idx, item in enumerate(ranked, start=1):
      idx = int(item.get("index", -1))
      if idx < 0 or idx >= len(batch_indices):
        continue
      orig_idx = batch_indices[idx]
      if len(pass2_batches) == 1:
        pass2_scores[orig_idx] = _rerank_score(item)
      else:
        rrf_merge(pass2_scores, rank_idx, orig_idx)

  ranked_twice = sorted(pass2_scores.items(), key=lambda item: (-item[1], item[0]))
  return _normalize_ranked_scores(ranked_twice)


def update_paper_rerank_metadata(
  paper: Dict[str, Any],
  *,
  track: str,
  score: float,
  rank: int,
  query_text: str,
) -> None:
  if not isinstance(paper, dict):
    return
  track_key = "rerank_core_score" if track == TRACK_CORE else "rerank_inspiration_score"
  rank_key = "rerank_core_rank" if track == TRACK_CORE else "rerank_inspiration_rank"
  query_key = "rerank_core_query_text" if track == TRACK_CORE else "rerank_inspiration_query_text"
  old_track_score = paper.get(track_key)
  try:
    old_track_value = float(old_track_score)
  except Exception:
    old_track_value = -1.0
  if score > old_track_value:
    paper[track_key] = float(score)
    paper[rank_key] = int(rank)
    paper[query_key] = query_text

  try:
    old_best = float(paper.get("rerank_score"))
  except Exception:
    old_best = -1.0
  if score > old_best:
    paper["rerank_score"] = float(score)
    paper["rerank_best_query"] = query_text
    paper["rerank_track"] = track
    paper["rerank_rank"] = int(rank)


def process_file(
  reranker: Any | None,
  input_path: str,
  output_path: str,
  top_n: Optional[int],
  rerank_model: str,
) -> None:
  data = load_json(input_path)
  papers_list = data.get("papers") or []
  all_queries = data.get("queries") or []
  if not papers_list or not all_queries:
    log(f"[WARN] 文件 {os.path.basename(input_path)} 中缺少 papers 或 queries，跳过。")
    return

  # core/inspiration 双通路都可进入 rerank；比例为 0 的通路直接禁用。
  def _is_rerank_query(q: Dict[str, Any]) -> bool:
    q_type = str(q.get("type") or "").strip().lower()
    return q_type in {"intent_query", "llm_query", "keyword", "research_direction"}

  for q in all_queries:
    if isinstance(q, dict) and _is_rerank_query(q) and not query_track_enabled(q):
      q["ranked"] = []

  queries = [q for q in all_queries if _is_rerank_query(q) and query_track_enabled(q)]
  if not queries:
    log("[WARN] 当前输入中没有启用的 core/inspiration rerank 查询，跳过 rerank。")
    # 保持输出结构一致，避免后续步骤读不到文件
    meta_generated_at = data.get("generated_at") or ""
    data["reranked_at"] = datetime.now(timezone.utc).isoformat()
    data["generated_at"] = meta_generated_at
    save_rank_payload(data, output_path)
    return

  papers_by_id = {str(p.get("id")): p for p in papers_list if p.get("id")}
  lane_top_k, guaranteed_per_lane, global_rrf_top = resolve_global_pool_budget(
    len(papers_list),
    len(queries),
  )
  enabled_tracks = {
    normalize_query_track(q)
    for q in queries
    if normalize_query_track(q) in {TRACK_CORE, TRACK_INSPIRATION}
  }
  candidate_ids_by_track: Dict[str, List[str]] = {}
  for track in (TRACK_CORE, TRACK_INSPIRATION):
    if track not in enabled_tracks:
      candidate_ids_by_track[track] = []
      continue
    candidate_ids_by_track[track] = build_global_candidate_ids(
      all_queries,
      guaranteed_per_lane=guaranteed_per_lane,
      global_limit=global_rrf_top,
      enabled_tracks=enabled_tracks,
      target_track=track,
    )
  global_candidate_ids = _unique_keep_order(
    candidate_ids_by_track.get(TRACK_CORE, []) + candidate_ids_by_track.get(TRACK_INSPIRATION, [])
  )
  data["global_candidate_ids"] = global_candidate_ids
  data["global_candidate_ids_by_track"] = candidate_ids_by_track
  data["global_pool_lane_top_k"] = lane_top_k
  data["global_pool_limit"] = global_rrf_top
  data["global_pool_guaranteed_per_lane"] = guaranteed_per_lane
  if not global_candidate_ids:
    log("[WARN] 未能从任意 query 中构建统一候选池，跳过 rerank。")
    meta_generated_at = data.get("generated_at") or ""
    data["reranked_at"] = datetime.now(timezone.utc).isoformat()
    data["generated_at"] = meta_generated_at
    save_rank_payload(data, output_path)
    return

  if reranker is None:
    group_start(f"Step 3 - RRF fallback {os.path.basename(input_path)}")
    try:
      log("[INFO] 未配置 native rerank provider，使用 Step 2.3 的 sim_scores 生成 ranked。")
      for query in all_queries:
        if isinstance(query, dict):
          query["ranked"] = build_ranked_from_sim_scores(query) if query_track_enabled(query) else []
      meta_generated_at = data.get("generated_at") or ""
      data["reranked_at"] = datetime.now(timezone.utc).isoformat()
      data["generated_at"] = meta_generated_at
      save_rank_payload(data, output_path)
      return
    finally:
      group_end()

  encoder = build_token_encoder()
  group_start(f"Step 3 - rerank {os.path.basename(input_path)}")
  log(
    f"[INFO] 开始 rerank：queries={len(queries)}（core/inspiration 双通路），papers={len(papers_list)}，"
    f"global_pool={len(global_candidate_ids)}（lane_top_k={lane_top_k}, "
    f"guaranteed_per_lane={guaranteed_per_lane}, global_top={global_rrf_top}），"
    f"batch_size={BATCH_SIZE}，"
    f"max_chars={MAX_CHARS_PER_DOC}，token_safety={TOKEN_SAFETY}"
  )

  for q_idx, q in enumerate(queries, start=1):
    q_text = build_track_rerank_query_text(q)
    track = normalize_query_track(q)
    # Rerank must stay query-local. Reusing the whole track pool for every
    # broad query lets unrelated papers win a normalized score by chance.
    top_ids = _unique_keep_order(get_top_ids(q))
    if not top_ids:
      top_ids = list(candidate_ids_by_track.get(track) or [])
    if not q_text or not top_ids:
      continue

    group_start(f"Query {q_idx}/{len(queries)} track={track} tag={q.get('tag') or ''}")
    documents = build_documents(papers_by_id, top_ids)
    query_tokens = estimate_tokens(q_text, encoder)
    log(
      f"[INFO] Query {q_idx}/{len(queries)} tag={q.get('tag') or ''} | candidates={len(top_ids)} "
      f"| track={track} | query_tokens≈{query_tokens}"
    )

    try:
      ranked_scores = rerank_documents_two_pass(
        reranker,
        query_text=q_text,
        documents=documents,
        encoder=encoder,
        rerank_model=rerank_model,
      )
      if not ranked_scores:
        log("[WARN] 本次 query 未得到有效 rerank 结果，跳过。")
        continue
    finally:
      group_end()

    if not ranked_scores:
      continue

    sorted_items = sorted(ranked_scores, key=lambda x: (-x[1], x[0]))
    if top_n is not None:
      sorted_items = sorted_items[:top_n]

    ranked_for_query: List[Dict[str, Any]] = []
    for rank_idx, (idx, norm_score) in enumerate(sorted_items, start=1):
      paper_id = top_ids[idx]
      update_paper_rerank_metadata(
        papers_by_id.get(paper_id) or {},
        track=track,
        score=float(norm_score),
        rank=rank_idx,
        query_text=q_text,
      )
      ranked_for_query.append(
        {
          "paper_id": paper_id,
          "score": float(norm_score),
          "star_rating": score_to_stars(float(norm_score)),
          "query_track": track,
          "rerank_track": track,
          "rerank_rank": rank_idx,
        }
      )

    ranked_for_query.sort(key=lambda x: (-float(x["score"]), str(x.get("paper_id") or "")))
    q["ranked"] = ranked_for_query
    q["query_track"] = track
    q["rerank_query_text"] = q_text

  meta_generated_at = data.get("generated_at") or ""
  data["reranked_at"] = datetime.now(timezone.utc).isoformat()
  data["generated_at"] = meta_generated_at

  save_rank_payload(data, output_path)
  group_end()


def main() -> None:
  parser = argparse.ArgumentParser(
    description="步骤 3：使用 RRF fallback 生成候选论文 ranked 结构。",
  )
  parser.add_argument(
    "--input",
    type=str,
    default=os.path.join(FILTERED_DIR, f"arxiv_papers_{TODAY_STR}.json"),
    help="筛选结果 JSON 路径。",
  )
  parser.add_argument(
    "--output",
    type=str,
    default=os.path.join(RANKED_DIR, f"arxiv_papers_{TODAY_STR}.json"),
    help="打分后的输出 JSON 路径。",
  )
  parser.add_argument(
    "--top-n",
    type=int,
    default=None,
    help="最终保留的 Top N（默认保留全部候选）。",
  )
  parser.add_argument(
    "--rerank-model",
    type=str,
    default=os.getenv("DPR_RERANK_MODEL") or "",
    help="预留参数：native rerank provider 后续接入时使用。",
  )

  args = parser.parse_args()

  input_path = args.input
  if not os.path.isabs(input_path):
    input_path = os.path.abspath(os.path.join(ROOT_DIR, input_path))

  output_path = args.output
  if not os.path.isabs(output_path):
    output_path = os.path.abspath(os.path.join(ROOT_DIR, output_path))

  if not os.path.exists(input_path):
    log(f"[WARN] 输入文件不存在（今天可能没有新论文）：{input_path}，将跳过 Step 3。")
    return

  reranker, rerank_model = create_reranker_from_env(model=args.rerank_model, log=log)
  process_file(
    reranker=reranker,
    input_path=input_path,
    output_path=output_path,
    top_n=args.top_n,
    rerank_model=rerank_model,
  )


if __name__ == "__main__":
  main()
