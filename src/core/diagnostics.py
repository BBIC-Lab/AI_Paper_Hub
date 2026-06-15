"""Helpers for carrying per-paper ranking diagnostics through the pipeline."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List


def paper_id(item: Dict[str, Any] | None) -> str:
    if not isinstance(item, dict):
        return ""
    return str(item.get("id") or item.get("paper_id") or "").strip()


def _as_float(value: Any) -> float | None:
    try:
        return float(value)
    except Exception:
        return None


def _as_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except Exception:
        return None
    return parsed if parsed > 0 else None


def _stage_container(paper: Dict[str, Any]) -> Dict[str, Any]:
    diagnostics = paper.get("diagnostics")
    if not isinstance(diagnostics, dict):
        diagnostics = {}
        paper["diagnostics"] = diagnostics
    stage_ranks = diagnostics.get("stage_ranks")
    if not isinstance(stage_ranks, dict):
        stage_ranks = {}
        diagnostics["stage_ranks"] = stage_ranks
    return stage_ranks


def _query_text(query: Dict[str, Any]) -> str:
    return str(
        query.get("rerank_query_text")
        or query.get("query_text")
        or query.get("query")
        or ""
    ).strip()


def _query_tag(query: Dict[str, Any]) -> str:
    return str(query.get("paper_tag") or query.get("tag") or "").strip()


def _query_track(query: Dict[str, Any], item: Dict[str, Any] | None = None) -> str:
    if isinstance(item, dict):
        track = str(item.get("query_track") or item.get("rerank_track") or "").strip()
        if track:
            return track
    return str(query.get("query_track") or query.get("rerank_track") or "").strip()


def _make_hit(
    *,
    query: Dict[str, Any],
    rank: Any,
    score: Any,
    item: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    hit: Dict[str, Any] = {
        "rank": _as_int(rank) or 0,
        "score": _as_float(score),
        "query": _query_text(query),
        "tag": _query_tag(query),
        "track": _query_track(query, item),
    }
    return {k: v for k, v in hit.items() if v not in (None, "", 0)}


def _best_hit(hits: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not hits:
        return {}
    return sorted(
        hits,
        key=lambda item: (
            int(item.get("rank") or 10**9),
            -float(item.get("score") or 0.0),
            str(item.get("query") or ""),
        ),
    )[0]


def _stage_payload(hits: List[Dict[str, Any]]) -> Dict[str, Any]:
    best = _best_hit(hits)
    payload: Dict[str, Any] = {
        "best_rank": best.get("rank"),
        "best_score": best.get("score"),
        "best_query": best.get("query"),
        "best_tag": best.get("tag"),
        "best_track": best.get("track"),
        "hits": sorted(
            hits,
            key=lambda item: (
                int(item.get("rank") or 10**9),
                -float(item.get("score") or 0.0),
                str(item.get("query") or ""),
            ),
        ),
    }
    return {k: v for k, v in payload.items() if v not in (None, "", [])}


def annotate_stage_ranks(
    papers: List[Dict[str, Any]] | None,
    queries: Iterable[Dict[str, Any]] | None,
    stage: str,
) -> None:
    """Attach query-local rank/score hits for one pipeline stage."""
    if not papers or not queries:
        return
    id_to_paper = {paper_id(p): p for p in papers if paper_id(p)}
    hits_by_id: Dict[str, List[Dict[str, Any]]] = {}
    for query in queries:
        if not isinstance(query, dict):
            continue
        sim_scores = query.get("sim_scores")
        if isinstance(sim_scores, dict):
            for pid, meta in sim_scores.items():
                clean_pid = str(pid or "").strip()
                if clean_pid not in id_to_paper:
                    continue
                if isinstance(meta, dict):
                    hit = _make_hit(query=query, rank=meta.get("rank"), score=meta.get("score"))
                else:
                    hit = _make_hit(query=query, rank=None, score=meta)
                hits_by_id.setdefault(clean_pid, []).append(hit)

        ranked = query.get("ranked")
        if isinstance(ranked, list):
            for idx, item in enumerate(ranked, start=1):
                if not isinstance(item, dict):
                    continue
                clean_pid = str(item.get("paper_id") or item.get("id") or "").strip()
                if clean_pid not in id_to_paper:
                    continue
                hit = _make_hit(
                    query=query,
                    rank=item.get("rerank_rank") or item.get("rank") or idx,
                    score=item.get("score"),
                    item=item,
                )
                hits_by_id.setdefault(clean_pid, []).append(hit)

    for pid, hits in hits_by_id.items():
        _stage_container(id_to_paper[pid])[stage] = _stage_payload(hits)


def annotate_llm_ranks(
    papers: List[Dict[str, Any]] | None,
    llm_ranked: List[Dict[str, Any]] | None,
) -> None:
    if not papers or not llm_ranked:
        return
    id_to_paper = {paper_id(p): p for p in papers if paper_id(p)}
    for rank, item in enumerate(llm_ranked, start=1):
        if not isinstance(item, dict):
            continue
        pid = str(item.get("paper_id") or item.get("id") or "").strip()
        paper = id_to_paper.get(pid)
        if not paper:
            continue
        _stage_container(paper)["llm"] = {
            "rank": rank,
            "score": _as_float(item.get("score")),
            "core_relevance_score": _as_float(item.get("core_relevance_score")),
            "inspiration_score": _as_float(item.get("inspiration_score")),
            "method_substance_score": _as_float(item.get("method_substance_score")),
            "domain_breadth_score": _as_float(item.get("domain_breadth_score")),
            "transfer_specificity_score": _as_float(item.get("transfer_specificity_score")),
            "track": str(item.get("relevance_track") or "").strip(),
            "query": str(item.get("matched_query_text") or "").strip(),
            "tag": str(item.get("matched_query_tag") or "").strip(),
        }
        _stage_container(paper)["llm"] = {
            k: v for k, v in _stage_container(paper)["llm"].items() if v not in (None, "")
        }


def set_selection_rank(
    paper: Dict[str, Any],
    *,
    candidate_rank: int,
    selected: bool,
    section: str = "",
    section_rank: int | None = None,
    downgrade_reason: str = "",
) -> None:
    payload: Dict[str, Any] = {
        "candidate_rank": candidate_rank,
        "selected": bool(selected),
        "section": section,
        "rank": section_rank,
        "selection_score": _as_float(paper.get("selection_score") or paper.get("llm_score")),
        "llm_score": _as_float(paper.get("llm_score")),
        "downgrade_reason": downgrade_reason or str(paper.get("selection_downgrade_reason") or "").strip(),
    }
    _stage_container(paper)["selection"] = {
        k: v for k, v in payload.items() if v not in (None, "")
    }


def merge_paper_diagnostics(target: Dict[str, Any], source: Dict[str, Any]) -> None:
    src_diag = source.get("diagnostics")
    if not isinstance(src_diag, dict):
        return
    src_stages = src_diag.get("stage_ranks")
    if not isinstance(src_stages, dict):
        return
    target_stages = _stage_container(target)
    for stage, payload in src_stages.items():
        if not isinstance(payload, dict):
            continue
        if stage not in target_stages:
            target_stages[stage] = payload
            continue
        existing_hits = target_stages.get(stage, {}).get("hits") or []
        incoming_hits = payload.get("hits") or []
        if existing_hits or incoming_hits:
            target_stages[stage] = _stage_payload(
                [h for h in [*existing_hits, *incoming_hits] if isinstance(h, dict)]
            )
