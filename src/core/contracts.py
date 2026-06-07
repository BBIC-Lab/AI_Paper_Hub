"""Shared data shapes for the paper recommendation pipeline."""

from __future__ import annotations

from typing import Any, Dict, List, TypedDict


class PaperRecord(TypedDict, total=False):
    id: str
    source: str
    source_id: str
    title: str
    abstract: str
    authors: List[str]
    tags: List[str]
    published: str
    updated: str
    url: str
    abs_url: str
    pdf_url: str


class QuerySpec(TypedDict, total=False):
    type: str
    tag: str
    paper_tag: str
    query_text: str
    keyword: str
    description_en: str


class RankedHit(TypedDict, total=False):
    paper_id: str
    score: float
    rank: int
    star_rating: int


class RecallQuery(QuerySpec, total=False):
    sim_scores: Dict[str, Any]
    ranked: List[RankedHit]


class RecallPayload(TypedDict, total=False):
    top_k: int
    generated_at: str
    reranked_at: str
    llm_ranked_at: str
    papers: List[PaperRecord]
    queries: List[RecallQuery]
    llm_ranked: List[Dict[str, Any]]


class RecommendationItem(PaperRecord, total=False):
    paper_id: str
    llm_score: float
    matched_query_tag: str
    matched_requirement_index: int
    selection_source: str
    tldr_en: str
    tldr_cn: str
    evidence_en: str
    evidence_cn: str


class RecommendationPayload(TypedDict, total=False):
    mode: str
    generated_at: str
    stats: Dict[str, Any]
    deep_dive: List[RecommendationItem]
    quick_skim: List[RecommendationItem]
