"""JSON artifact naming and IO helpers for the paper pipeline."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable, Dict, List


JsonObject = Dict[str, Any]


def paper_artifact_filename(run_date_token: str, variant: str | None = None) -> str:
    """Return the stable arxiv artifact filename used by existing steps."""
    token = str(run_date_token or "").strip()
    suffix = str(variant or "").strip()
    if not token:
        raise ValueError("run_date_token is required")
    if suffix:
        return f"arxiv_papers_{token}.{suffix}.json"
    return f"arxiv_papers_{token}.json"


def read_json(path: str | os.PathLike[str]) -> Any:
    with Path(path).open("r", encoding="utf-8") as f:
        return json.load(f)


def read_json_object(
    path: str | os.PathLike[str],
    *,
    missing_message: str | None = None,
) -> JsonObject:
    json_path = Path(path)
    if not json_path.exists():
        raise FileNotFoundError(missing_message or f"missing file: {json_path}")
    payload = read_json(json_path)
    if not isinstance(payload, dict):
        raise ValueError(f"JSON artifact must be an object: {json_path}")
    return payload


def read_json_safe(
    path: str | os.PathLike[str],
    *,
    default: Any = None,
    on_error: Callable[[Exception], None] | None = None,
) -> Any:
    try:
        return read_json(path)
    except Exception as exc:
        if on_error:
            on_error(exc)
        return default


def write_json(path: str | os.PathLike[str], data: Any, *, indent: int = 2) -> None:
    json_path = Path(path)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    with json_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=indent)


def validate_recall_payload(payload: Any) -> List[str]:
    errors: List[str] = []
    if not isinstance(payload, dict):
        return ["payload must be an object"]
    if "papers" in payload and not isinstance(payload.get("papers"), list):
        errors.append("papers must be a list")
    if "queries" in payload and not isinstance(payload.get("queries"), list):
        errors.append("queries must be a list")
    return errors

def validate_recommendation_payload(payload: Any) -> List[str]:
    errors: List[str] = []
    if not isinstance(payload, dict):
        return ["payload must be an object"]
    for key in ("deep_dive", "quick_skim"):
        if key in payload and not isinstance(payload.get(key), list):
            errors.append(f"{key} must be a list")
    stats = payload.get("stats")
    if stats is not None and not isinstance(stats, dict):
        errors.append("stats must be an object")
    return errors
