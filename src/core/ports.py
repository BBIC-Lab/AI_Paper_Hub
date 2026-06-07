"""Protocol interfaces for future adapter replacement."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Iterable, List, Protocol, Sequence, runtime_checkable

from .contracts import PaperRecord, QuerySpec, RecommendationPayload, RecallPayload


@runtime_checkable
class LLMPort(Protocol):
    def chat_structured(
        self,
        messages: Sequence[Dict[str, str]],
        schema_name: str,
        schema: Dict[str, Any],
        strict: bool,
        allow_json_object_fallback: bool,
    ) -> Dict[str, Any]:
        ...


@runtime_checkable
class EmbeddingPort(Protocol):
    def embed_texts(self, texts: Sequence[str]) -> List[List[float]]:
        ...


@runtime_checkable
class PaperSourcePort(Protocol):
    def fetch(self, queries: Sequence[QuerySpec], *, run_date_token: str) -> List[PaperRecord]:
        ...


@runtime_checkable
class VectorStorePort(Protocol):
    def bm25_search(self, query: QuerySpec, *, top_k: int) -> RecallPayload:
        ...

    def vector_search(self, query: QuerySpec, embedding: Sequence[float], *, top_k: int) -> RecallPayload:
        ...

    def upsert_papers(self, papers: Iterable[PaperRecord]) -> None:
        ...


@runtime_checkable
class RendererPort(Protocol):
    def render(self, payload: RecommendationPayload, output_dir: str | Path) -> None:
        ...
