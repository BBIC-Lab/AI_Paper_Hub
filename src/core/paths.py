"""Repository paths and run-date helpers for the paper pipeline."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import List

from .artifacts import paper_artifact_filename


BEIJING_TZ = timezone(timedelta(hours=8))
DEFAULT_LONG_RANGE_DAYS_THRESHOLD = 10
DEFAULT_MAIN_DAYS = 5


@dataclass(frozen=True)
class RunArtifactPaths:
    archive: Path
    raw: Path
    bm25: Path
    embedding: Path
    rrf: Path
    rerank: Path
    llm: Path
    recommend: Path


def repo_root(anchor: str | os.PathLike[str] | None = None) -> Path:
    if anchor is None:
        return Path(__file__).resolve().parents[2]
    return Path(anchor).resolve()


def config_path(root: str | os.PathLike[str] | None = None) -> Path:
    return repo_root(root) / "config.yaml"


def docs_root(root: str | os.PathLike[str] | None = None) -> Path:
    return repo_root(root) / "docs"


def archive_root(root: str | os.PathLike[str] | None = None) -> Path:
    return repo_root(root) / "archive"


def archive_dir(root: str | os.PathLike[str] | None, run_date_token: str) -> Path:
    return archive_root(root) / str(run_date_token)


def raw_dir(root: str | os.PathLike[str] | None, run_date_token: str) -> Path:
    return archive_dir(root, run_date_token) / "raw"


def filtered_dir(root: str | os.PathLike[str] | None, run_date_token: str) -> Path:
    return archive_dir(root, run_date_token) / "filtered"


def rank_dir(root: str | os.PathLike[str] | None, run_date_token: str) -> Path:
    return archive_dir(root, run_date_token) / "rank"


def recommend_dir(root: str | os.PathLike[str] | None, run_date_token: str) -> Path:
    return archive_dir(root, run_date_token) / "recommend"


def carryover_path(root: str | os.PathLike[str] | None = None) -> Path:
    return archive_root(root) / "carryover.json"


def raw_artifact_path(root: str | os.PathLike[str] | None, run_date_token: str) -> Path:
    return raw_dir(root, run_date_token) / paper_artifact_filename(run_date_token)


def filtered_artifact_path(
    root: str | os.PathLike[str] | None,
    run_date_token: str,
    variant: str | None = None,
) -> Path:
    return filtered_dir(root, run_date_token) / paper_artifact_filename(run_date_token, variant)


def rank_artifact_path(
    root: str | os.PathLike[str] | None,
    run_date_token: str,
    variant: str | None = None,
) -> Path:
    return rank_dir(root, run_date_token) / paper_artifact_filename(run_date_token, variant)


def recommend_artifact_path(
    root: str | os.PathLike[str] | None,
    run_date_token: str,
    mode: str,
) -> Path:
    return recommend_dir(root, run_date_token) / paper_artifact_filename(run_date_token, mode)


def run_artifact_paths(
    root: str | os.PathLike[str] | None,
    run_date_token: str,
    recommend_mode: str = "standard",
) -> RunArtifactPaths:
    return RunArtifactPaths(
        archive=archive_dir(root, run_date_token),
        raw=raw_artifact_path(root, run_date_token),
        bm25=filtered_artifact_path(root, run_date_token, "bm25"),
        embedding=filtered_artifact_path(root, run_date_token, "embedding"),
        rrf=filtered_artifact_path(root, run_date_token),
        rerank=rank_artifact_path(root, run_date_token),
        llm=rank_artifact_path(root, run_date_token, "llm"),
        recommend=recommend_artifact_path(root, run_date_token, recommend_mode),
    )


def resolve_repo_path(path: str | os.PathLike[str], root: str | os.PathLike[str] | None = None) -> Path:
    candidate = Path(path)
    if candidate.is_absolute():
        return candidate.resolve()
    return (repo_root(root) / candidate).resolve()


def run_date_from_env(now: datetime | None = None) -> str:
    token = str(os.getenv("DPR_RUN_DATE") or "").strip()
    if token:
        return token
    current = now or datetime.now(timezone.utc)
    return current.strftime("%Y%m%d")


def beijing_today(now: datetime | None = None) -> date:
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current.astimezone(BEIJING_TZ).date()


def beijing_today_token(now: datetime | None = None) -> str:
    return beijing_today(now).strftime("%Y%m%d")


def build_sidebar_date_label(days: int, now: datetime | None = None) -> str:
    safe_days = max(int(days), 1)
    end_date = beijing_today(now)
    start_date = end_date - timedelta(days=safe_days - 1)
    return f"{start_date:%Y-%m-%d} ~ {end_date:%Y-%m-%d}"


def build_run_date_token(days: int, now: datetime | None = None) -> str:
    safe_days = max(int(days), 1)
    end_date = beijing_today(now)
    start_date = end_date - timedelta(days=safe_days - 1)
    return f"{start_date:%Y%m%d}-{end_date:%Y%m%d}"


def resolve_run_date_token(
    fetch_days: int | None,
    *,
    days_window: int | None = None,
    now: datetime | None = None,
    long_range_days_threshold: int = DEFAULT_LONG_RANGE_DAYS_THRESHOLD,
    default_days: int = DEFAULT_MAIN_DAYS,
) -> str:
    if fetch_days is not None:
        if fetch_days >= long_range_days_threshold:
            return build_run_date_token(fetch_days, now=now)
        return beijing_today_token(now)

    try:
        resolved_window = int(days_window if days_window is not None else default_days)
    except Exception:
        resolved_window = default_days
    if resolved_window >= long_range_days_threshold:
        return build_run_date_token(resolved_window, now=now)
    return beijing_today_token(now)


def parse_run_date_token(date_str: str) -> date:
    text = str(date_str or "").strip()
    if re.fullmatch(r"\d{8}-\d{8}", text):
        text = text.split("-", 1)[1]
    return datetime.strptime(text, "%Y%m%d").date()


def list_archive_date_dirs(root: str | os.PathLike[str]) -> List[str]:
    archive = Path(root)
    if not archive.is_dir():
        return []
    result: List[str] = []
    for child in archive.iterdir():
        name = child.name
        if child.is_dir() and (re.match(r"^\d{8}$", name) or re.match(r"^\d{8}-\d{8}$", name)):
            result.append(name)
    return sorted(result)
