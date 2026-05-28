from __future__ import annotations

import re
from typing import Any, Dict, List


MAX_RESEARCH_DIRECTIONS = 8
_DIRECTION_SPLIT_RE = re.compile(r"[、，,；;\r\n]+")


def _norm_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def split_research_direction_text(value: Any) -> List[str]:
    return [_norm_text(item) for item in _DIRECTION_SPLIT_RE.split(str(value or "")) if _norm_text(item)]


def normalize_research_directions(value: Any, limit: int = MAX_RESEARCH_DIRECTIONS) -> List[str]:
    if isinstance(value, list):
        raw_items: List[str] = []
        for item in value:
            raw_items.extend(split_research_direction_text(item))
    else:
        raw_items = split_research_direction_text(value)

    out: List[str] = []
    seen = set()
    for item in raw_items:
        key = item.casefold()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(item)
        if len(out) >= max(0, int(limit or 0)):
            break
    return out


def _keyword_text(item: Any) -> str:
    if isinstance(item, str):
        return _norm_text(item)
    if not isinstance(item, dict):
        return ""
    return _norm_text(item.get("keyword") or item.get("text") or item.get("expr") or item.get("query") or "")


def fallback_research_directions_from_subscriptions(
    config: Dict[str, Any],
    limit: int = MAX_RESEARCH_DIRECTIONS,
) -> List[str]:
    subs = (config or {}).get("subscriptions") or {}
    profiles = subs.get("intent_profiles") or []
    if not isinstance(profiles, list):
        return []

    raw: List[str] = []
    for profile in profiles:
        if not isinstance(profile, dict):
            continue
        if profile.get("enabled") is False or profile.get("paused") is True:
            continue
        keywords = profile.get("keywords") or []
        if not isinstance(keywords, list):
            continue
        for item in keywords:
            text = _keyword_text(item)
            if text:
                raw.append(text)
    return normalize_research_directions(raw, limit=limit)


def resolve_research_directions(config: Dict[str, Any]) -> Dict[str, Any]:
    reader_profile = (config or {}).get("reader_profile") or {}
    configured = normalize_research_directions(
        reader_profile.get("research_directions") if isinstance(reader_profile, dict) else []
    )
    if configured:
        return {"directions": configured, "source": "configured"}
    fallback = fallback_research_directions_from_subscriptions(config or {})
    return {"directions": fallback, "source": "fallback" if fallback else "empty"}


def format_research_directions_for_prompt(context: Dict[str, Any]) -> str:
    directions = normalize_research_directions((context or {}).get("directions") or [])
    if not directions:
        return "未配置明确研究方向，也未能从检索关键词中回退。"
    source = str((context or {}).get("source") or "").strip()
    source_label = "用户手动配置" if source == "configured" else "检索配置关键词回退"
    body = "\n".join(f"- {item}" for item in directions)
    return f"来源：{source_label}\n研究方向关键词：\n{body}"
