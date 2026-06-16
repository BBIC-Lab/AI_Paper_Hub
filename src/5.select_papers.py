#!/usr/bin/env python
# Step 5：基于 LLM 评分结果，生成“精读区 + 速览区”的三种模式输出。

import argparse
import json
import os
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Tuple

try:
    from core import artifacts as core_artifacts
    from core.diagnostics import (
        PIPELINE_STAGE_NAMES,
        diagnostics_stage_coverage,
        finalize_paper_diagnostics,
        set_selection_rank,
    )
    from core import paths as core_paths
except Exception:  # pragma: no cover - package import fallback
    from src.core import artifacts as core_artifacts
    from src.core.diagnostics import (
        PIPELINE_STAGE_NAMES,
        diagnostics_stage_coverage,
        finalize_paper_diagnostics,
        set_selection_rank,
    )
    from src.core import paths as core_paths

from subscription_plan import count_subscription_tags, get_profile_daily_paper_limits, get_profile_recommend_mix

SCRIPT_DIR = os.path.dirname(__file__)
ROOT_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
ARCHIVE_ROOT = str(core_paths.archive_root(ROOT_DIR))
TODAY_STR = core_paths.run_date_from_env()
ARCHIVE_DIR = str(core_paths.archive_dir(ROOT_DIR, TODAY_STR))
RANKED_DIR = str(core_paths.rank_dir(ROOT_DIR, TODAY_STR))
RECOMMEND_DIR = str(core_paths.recommend_dir(ROOT_DIR, TODAY_STR))
CARRYOVER_PATH = str(core_paths.carryover_path(ROOT_DIR))
CONFIG_FILE = str(core_paths.config_path(ROOT_DIR))

MODES = {
    "standard": {
        "quick_base": 10,
        "quick_strategy": "uniform",
        "deep_unlimited": False,
        "deep_base": 5,
        "deep_strategy": "round_robin",
    },
    "extend": {
        "quick_base": 15,
        "quick_strategy": "uniform",
        "deep_unlimited": False,
        "deep_base": 10,
        "deep_strategy": "round_robin",
    },
    "spark": {
        "quick_base": 10,
        "quick_strategy": "low_bias",
        "deep_unlimited": False,
        "deep_base": 5,
        "deep_strategy": "round_robin",
    },
    # 回溯窗口（days）专用：>=8 分全量输出，全部进入速览区
    "skims": {
        "all_quick_min_score": 8.0,
    },
}

DEFAULT_LOOKBACK_DAYS = 5
CARRYOVER_DAYS = 7
CARRYOVER_RATIO = 0.5
SOURCE_FRESH_FETCH = "fresh_fetch"
SOURCE_CARRYOVER_CACHE = "carryover_cache"
CARRYOVER_MIN_SCORE = 8.0
CARRYOVER_UNTAGGED = "untagged"
ARXIV_VERSIONED_ID_RE = re.compile(r"^(\d{4}\.\d{4,5})(?:v(\d+))?$", re.IGNORECASE)
DEFAULT_RECOMMEND_MIX = {"core_ratio": 2, "inspiration_ratio": 3}
TRACK_CORE = "core"
TRACK_INSPIRATION = "inspiration"
TRACK_BRIDGE = "bridge"
TRACK_LABELS = {
    TRACK_CORE: "强相关",
    TRACK_INSPIRATION: "通用启发",
    TRACK_BRIDGE: "桥接方法",
}
BRIDGE_SELECTION_BONUS = 0.5
DEEP_METHOD_SUBSTANCE_MIN = 7.0
DEEP_DOMAIN_BREADTH_MIN = 7.0
BRIDGE_TRANSFER_SPECIFICITY_MIN = 7.0
CORE_DIRECT_RELEVANCE_EXCEPTION_MIN = 9.0
CORE_DIRECT_METHOD_EXCEPTION_MIN = 8.0
CORE_DIRECT_DOMAIN_EXCEPTION_FLOOR = 5.0
CORE_DIRECT_TRANSFER_EXCEPTION_MIN = 7.0
GENERIC_RERANK_QUALITY_MIN = 8.0
GENERIC_RERANK_QUERY_TERMS = (
    "online adaptation",
    "domain adaptation",
    "time series modeling",
    "representation learning",
)
METHOD_ENTITY_RE = re.compile(
    r"\b(model|framework|algorithm|method|architecture|transformer|encoder|decoder|"
    r"training|benchmark|dataset|protocol|analysis|pipeline|retrieval|rerank|"
    r"classifier|regression|adaptation|alignment|embedding|pca|nvar|conformer)\b",
    re.IGNORECASE,
)
try:
    RERANK_SELECTION_WEIGHT = max(float(os.getenv("DPR_RERANK_SELECTION_WEIGHT") or "0.6"), 0.0)
except Exception:
    RERANK_SELECTION_WEIGHT = 0.6
try:
    RERANK_SELECTION_RANK_WINDOW = max(int(os.getenv("DPR_RERANK_SELECTION_RANK_WINDOW") or "30"), 1)
except Exception:
    RERANK_SELECTION_RANK_WINDOW = 30


def log(message: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {message}", flush=True)


def resolve_positive_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)
    except Exception:
        return max(int(fallback or 1), 1)
    return parsed if parsed > 0 else max(int(fallback or 1), 1)


def resolve_carryover_days(setting: Dict[str, Any]) -> int:
    safe_setting = setting if isinstance(setting, dict) else {}
    days_window = resolve_positive_int(safe_setting.get("days_window"), CARRYOVER_DAYS)
    return resolve_positive_int(safe_setting.get("carryover_days"), days_window)


def log_substep(code: str, name: str, phase: str) -> None:
    """
    用于前端解析的子步骤标记。
    格式： [SUBSTEP] 5.1 - xxx START/END
    """
    phase = str(phase or "").strip().upper()
    if phase not in ("START", "END"):
        phase = "INFO"
    log(f"[SUBSTEP] {code} - {name} {phase}")


def group_start(title: str) -> None:
    print(f"::group::{title}", flush=True)


def group_end() -> None:
    print("::endgroup::", flush=True)


def load_json(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        raise FileNotFoundError(f"missing file: {path}")
    return core_artifacts.read_json_object(path)


def save_json(data: Dict[str, Any], path: str) -> None:
    core_artifacts.write_json(path, data)
    log(f"[INFO] saved: {path}")


def selected_items(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for section_key in ("deep_dive", "quick_skim"):
        items.extend([item for item in (result.get(section_key) or []) if isinstance(item, dict)])
    return items


def parse_date_str(date_str: str) -> date:
    return core_paths.parse_run_date_token(date_str)


def list_date_dirs(archive_root: str) -> List[str]:
    return core_paths.list_archive_date_dirs(archive_root)


def parse_payload_date(payload: Dict[str, Any]) -> date | None:
    date_str = str(payload.get("updated_date") or "").strip()
    if date_str:
        try:
            return parse_date_str(date_str)
        except Exception:
            return None
    generated_at = str(payload.get("generated_at") or "").strip()
    if generated_at:
        try:
            return datetime.fromisoformat(generated_at.replace("Z", "+00:00")).date()
        except Exception:
            return None
    return None


def load_carryover_payload(carryover_path: str) -> Dict[str, Any]:
    if not os.path.exists(carryover_path):
        return {}
    try:
        payload = load_json(carryover_path)
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def normalize_carryover_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        return {"tag_states": {}}

    raw_states = payload.get("tag_states")
    if isinstance(raw_states, dict):
        normalized_states: Dict[str, Dict[str, Any]] = {}
        for raw_tag, raw_state in raw_states.items():
            tag_key = normalize_carryover_tag(raw_tag) or CARRYOVER_UNTAGGED
            state = raw_state if isinstance(raw_state, dict) else {}
            items = state.get("items") if isinstance(state.get("items"), list) else []
            normalized_states[tag_key] = {
                "updated_date": str(state.get("updated_date") or payload.get("updated_date") or "").strip(),
                "carryover_days": int(state.get("carryover_days") or payload.get("carryover_days") or CARRYOVER_DAYS),
                "items": [dict(item) for item in items if isinstance(item, dict)],
            }
        return {
            "generated_at": str(payload.get("generated_at") or "").strip(),
            "updated_date": str(payload.get("updated_date") or "").strip(),
            "carryover_days": int(payload.get("carryover_days") or CARRYOVER_DAYS),
            "tag_states": normalized_states,
        }

    items = payload.get("items") if isinstance(payload.get("items"), list) else []
    tag_states: Dict[str, Dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        for tag_key in resolve_carryover_tags(item):
            state = tag_states.setdefault(
                tag_key,
                {
                    "updated_date": str(payload.get("updated_date") or "").strip(),
                    "carryover_days": int(payload.get("carryover_days") or CARRYOVER_DAYS),
                    "items": [],
                },
            )
            state["items"].append(dict(item))

    return {
        "generated_at": str(payload.get("generated_at") or "").strip(),
        "updated_date": str(payload.get("updated_date") or "").strip(),
        "carryover_days": int(payload.get("carryover_days") or CARRYOVER_DAYS),
        "tag_states": tag_states,
    }


def merge_carryover_item(existing: Dict[str, Any], incoming: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(existing)
    merged["llm_tags"] = normalize_tags(
        normalize_tags(existing.get("llm_tags")) + normalize_tags(incoming.get("llm_tags"))
    )
    if incoming.get("matched_query_tag") and not merged.get("matched_query_tag"):
        merged["matched_query_tag"] = incoming.get("matched_query_tag")
    if incoming.get("matched_requirement_id") and not merged.get("matched_requirement_id"):
        merged["matched_requirement_id"] = incoming.get("matched_requirement_id")
    if incoming.get("matched_query_text") and not merged.get("matched_query_text"):
        merged["matched_query_text"] = incoming.get("matched_query_text")
    try:
        merged["carry_days"] = min(int(existing.get("carry_days") or 1), int(incoming.get("carry_days") or 1))
    except Exception:
        merged["carry_days"] = int(existing.get("carry_days") or incoming.get("carry_days") or 1)
    return merged


def load_recent_carryover(
    carryover_path: str,
    today_date: date,
    max_days: int,
    active_tags: List[str] | None = None,
) -> Tuple[List[Dict[str, Any]], int]:
    payload = normalize_carryover_payload(load_carryover_payload(carryover_path))
    tag_states = payload.get("tag_states") or {}
    if not isinstance(tag_states, dict):
        return [], 0

    normalized_active_tags = [
        normalize_carryover_tag(tag)
        for tag in (active_tags or [])
        if normalize_carryover_tag(tag)
    ]
    target_tags = normalized_active_tags or list(tag_states.keys())

    merged_by_id: Dict[str, Dict[str, Any]] = {}
    max_delta = 0
    for tag_key in target_tags:
        state = tag_states.get(tag_key)
        if not isinstance(state, dict):
            continue
        base_date = parse_payload_date(state)
        delta = 0
        if base_date:
            delta = (today_date - base_date).days
            if delta < 0:
                delta = 0
        max_delta = max(max_delta, delta)

        items = state.get("items") if isinstance(state.get("items"), list) else []
        for item in items:
            if not isinstance(item, dict):
                continue
            carry_days = int(item.get("carry_days") or 1)
            if delta > 0:
                carry_days += delta
            if carry_days > max_days:
                continue
            copied = dict(item)
            copied["carry_days"] = carry_days
            pid = str(copied.get("id") or copied.get("paper_id") or "").strip()
            if not pid:
                continue
            if pid in merged_by_id:
                merged_by_id[pid] = merge_carryover_item(merged_by_id[pid], copied)
            else:
                merged_by_id[pid] = copied

    return list(merged_by_id.values()), max_delta


def load_config_tag_count() -> Tuple[int, List[str]]:
    """读取订阅配置中的 tag 数量（优先新结构 intent_profiles）。"""
    if not os.path.exists(CONFIG_FILE):
        return 0, []
    try:
        import yaml  # type: ignore
    except Exception:
        log("[WARN] PyYAML not installed, tag count fallback to 0.")
        return 0, []

    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except Exception as exc:
        log(f"[WARN] failed to read config.yaml: {exc}")
        return 0, []
    return count_subscription_tags(data if isinstance(data, dict) else {})


def load_config_profile_daily_limits() -> Dict[str, Dict[str, int]]:
    """读取每个查询词条的每日推荐上限；缺省由 subscription_plan 统一回填。"""
    if not os.path.exists(CONFIG_FILE):
        return {}
    try:
        import yaml  # type: ignore
    except Exception:
        log("[WARN] PyYAML not installed, skip profile daily paper limits.")
        return {}

    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except Exception as exc:
        log(f"[WARN] failed to read config.yaml for daily limits: {exc}")
        return {}
    try:
        return get_profile_daily_paper_limits(data if isinstance(data, dict) else {})
    except Exception as exc:
        log(f"[WARN] failed to parse profile daily limits: {exc}")
        return {}


def load_config_profile_recommend_mix() -> Dict[str, Dict[str, int]]:
    """读取每个 profile 的强相关/通用启发配比。"""
    if not os.path.exists(CONFIG_FILE):
        return {}
    try:
        import yaml  # type: ignore
    except Exception:
        log("[WARN] PyYAML not installed, skip profile recommend mix.")
        return {}

    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except Exception as exc:
        log(f"[WARN] failed to read config.yaml for recommend mix: {exc}")
        return {}
    try:
        return get_profile_recommend_mix(data if isinstance(data, dict) else {})
    except Exception as exc:
        log(f"[WARN] failed to parse profile recommend mix: {exc}")
        return {}


def load_arxiv_paper_setting() -> Dict[str, Any]:
    if not os.path.exists(CONFIG_FILE):
        return {}
    try:
        import yaml  # type: ignore
    except Exception:
        log("[WARN] PyYAML not installed, skip arxiv_paper_setting.")
        return {}
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except Exception as exc:
        log(f"[WARN] failed to read config.yaml: {exc}")
        return {}
    setting = (data or {}).get("arxiv_paper_setting") or {}
    return setting if isinstance(setting, dict) else {}


def normalize_tags(raw: Any) -> List[str]:
    if not isinstance(raw, list):
        return []
    cleaned: List[str] = []
    seen = set()
    for item in raw:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        cleaned.append(text)
    return cleaned


def normalize_carryover_tag(tag: Any) -> str:
    text = str(tag or "").strip()
    if not text:
        return ""
    if ":" in text:
        prefix, suffix = text.split(":", 1)
        if prefix in {"query", "keyword"} and suffix.strip():
            text = suffix.strip()
    return text


def resolve_carryover_tags(item: Dict[str, Any], fallback_tags: List[str] | None = None) -> List[str]:
    collected: List[str] = []

    matched_query_tag = normalize_carryover_tag(item.get("matched_query_tag"))
    if matched_query_tag:
        collected.append(matched_query_tag)

    for raw_tag in normalize_tags(item.get("llm_tags")):
        normalized = normalize_carryover_tag(raw_tag)
        if normalized:
            collected.append(normalized)

    if not collected and fallback_tags:
        for raw_tag in fallback_tags:
            normalized = normalize_carryover_tag(raw_tag)
            if normalized:
                collected.append(normalized)

    cleaned: List[str] = []
    seen = set()
    for tag in collected:
        if not tag or tag in seen:
            continue
        seen.add(tag)
        cleaned.append(tag)
    return cleaned or [CARRYOVER_UNTAGGED]


def collect_seen_ids(
    archive_root: str,
    today_str: str,
    active_tags: List[str] | None = None,
) -> set:
    active_tag_keys = {
        normalize_carryover_tag(tag).lower()
        for tag in (active_tags or [])
        if normalize_carryover_tag(tag)
    }

    seen = set()
    for day in list_date_dirs(archive_root):
        if day == today_str:
            continue
        rec_dir = os.path.join(archive_root, day, "recommend")
        if not os.path.isdir(rec_dir):
            continue
        for name in os.listdir(rec_dir):
            if not name.endswith(".json"):
                continue
            if not name.startswith(f"arxiv_papers_{day}."):
                continue
            rec_path = os.path.join(rec_dir, name)
            try:
                payload = load_json(rec_path)
            except Exception:
                continue
            for section_key in ("deep_dive", "quick_skim"):
                for item in payload.get(section_key) or []:
                    if not isinstance(item, dict):
                        continue
                    dedup_key = paper_dedup_key(item)
                    if not dedup_key:
                        continue
                    if active_tag_keys:
                        item_tag_keys = {
                            normalize_carryover_tag(tag).lower()
                            for tag in resolve_carryover_tags(item)
                            if normalize_carryover_tag(tag)
                        }
                        if not item_tag_keys.intersection(active_tag_keys):
                            continue
                    seen.add(dedup_key)
    return seen


def parse_score(value: Any) -> float:
    try:
        return float(value)
    except Exception:
        return 0.0


def parse_quality_score(item: Dict[str, Any], key: str, fallback: Any = None) -> float:
    if key not in item or item.get(key) is None:
        return max(parse_score(fallback), 0.0)
    return max(min(parse_score(item.get(key)), 10.0), 0.0)


def quality_scores_for_item(item: Dict[str, Any]) -> Tuple[float, float, float]:
    fallback = item.get("llm_score") or item.get("score") or item.get("selection_score") or 0
    return (
        parse_quality_score(item, "method_substance_score", fallback),
        parse_quality_score(item, "domain_breadth_score", fallback),
        parse_quality_score(item, "transfer_specificity_score", fallback),
    )


def core_score_for_item(item: Dict[str, Any]) -> float:
    fallback = item.get("llm_score") or item.get("score") or item.get("selection_score") or 0
    return parse_quality_score(item, "core_relevance_score", fallback)


def passes_general_method_quality(item: Dict[str, Any]) -> bool:
    method_score, domain_score, _transfer_score = quality_scores_for_item(item)
    return method_score >= DEEP_METHOD_SUBSTANCE_MIN and domain_score >= DEEP_DOMAIN_BREADTH_MIN


def passes_direct_core_exception(item: Dict[str, Any]) -> bool:
    method_score, domain_score, transfer_score = quality_scores_for_item(item)
    return (
        core_score_for_item(item) >= CORE_DIRECT_RELEVANCE_EXCEPTION_MIN
        and method_score >= CORE_DIRECT_METHOD_EXCEPTION_MIN
        and domain_score >= CORE_DIRECT_DOMAIN_EXCEPTION_FLOOR
        and transfer_score >= CORE_DIRECT_TRANSFER_EXCEPTION_MIN
    )


def passes_bridge_quality(item: Dict[str, Any]) -> bool:
    method_score, domain_score, transfer_score = quality_scores_for_item(item)
    return (
        method_score >= DEEP_METHOD_SUBSTANCE_MIN
        and domain_score >= DEEP_DOMAIN_BREADTH_MIN
        and transfer_score >= BRIDGE_TRANSFER_SPECIFICITY_MIN
    )


def deep_quality_downgrade_reason(item: Dict[str, Any]) -> str:
    track = normalize_relevance_track(item.get("relevance_track"), TRACK_CORE)
    if track == TRACK_CORE:
        method_score, domain_score, _transfer_score = quality_scores_for_item(item)
        if passes_direct_core_exception(item):
            return ""
        if domain_score < DEEP_DOMAIN_BREADTH_MIN:
            return "core_domain_breadth_below_threshold"
        if method_score < DEEP_METHOD_SUBSTANCE_MIN:
            return "core_method_substance_below_threshold"
        if has_generic_rerank_quality_risk(item, TRACK_CORE):
            return "generic_query_quality_below_threshold"
        return ""
    if track == TRACK_BRIDGE and not passes_bridge_quality(item):
        return "bridge_quality_below_threshold"
    if not passes_general_method_quality(item):
        return "general_method_quality_below_threshold"
    if track == TRACK_INSPIRATION and has_generic_rerank_quality_risk(item, TRACK_INSPIRATION):
        return "generic_query_quality_below_threshold"
    if track == TRACK_BRIDGE:
        lane = item.get("selection_lane") if item.get("selection_lane") in {TRACK_CORE, TRACK_INSPIRATION} else TRACK_INSPIRATION
        if has_generic_rerank_quality_risk(item, lane):
            return "generic_query_quality_below_threshold"
    return ""


def is_deep_quality_eligible(item: Dict[str, Any]) -> bool:
    return not deep_quality_downgrade_reason(item)


def parse_rank(value: Any) -> int:
    try:
        rank = int(value)
    except Exception:
        return 0
    return rank if rank > 0 else 0


def rerank_score_for_track(item: Dict[str, Any], track: str) -> float:
    track = normalize_relevance_track(track, "")
    score_key = "rerank_core_score" if track == TRACK_CORE else "rerank_inspiration_score"
    score = parse_score(item.get(score_key))
    if score <= 0 and normalize_relevance_track(item.get("rerank_track"), "") == track:
        score = parse_score(item.get("rerank_score"))
    return max(score, 0.0)


def rerank_rank_for_track(item: Dict[str, Any], track: str) -> int:
    track = normalize_relevance_track(track, "")
    rank_key = "rerank_core_rank" if track == TRACK_CORE else "rerank_inspiration_rank"
    rank = parse_rank(item.get(rank_key))
    if rank <= 0 and normalize_relevance_track(item.get("rerank_track"), "") == track:
        rank = parse_rank(item.get("rerank_rank"))
    return rank


def rerank_query_text_for_track(item: Dict[str, Any], track: str) -> str:
    track = normalize_relevance_track(track, "")
    query_key = "rerank_core_query_text" if track == TRACK_CORE else "rerank_inspiration_query_text"
    query_text = str(item.get(query_key) or "").strip()
    if not query_text and normalize_relevance_track(item.get("rerank_track"), "") == track:
        query_text = str(item.get("rerank_best_query") or "").strip()
    if not query_text:
        query_text = str(item.get("rerank_best_query") or item.get("matched_query_text") or "").strip()
    return query_text


def is_generic_rerank_query_text(query_text: str) -> bool:
    normalized = re.sub(r"\s+", " ", str(query_text or "").lower())
    return any(term in normalized for term in GENERIC_RERANK_QUERY_TERMS)


def has_specific_method_entity(item: Dict[str, Any]) -> bool:
    text = " ".join(
        str(item.get(key) or "")
        for key in (
            "title",
            "abstract",
            "summary",
            "track_evidence_en",
            "track_evidence_cn",
            "llm_evidence_en",
            "llm_evidence_cn",
            "llm_tldr_en",
            "llm_tldr_cn",
        )
    )
    return bool(METHOD_ENTITY_RE.search(text))


def active_rerank_selection_signal(item: Dict[str, Any], track: str) -> bool:
    score = rerank_score_for_track(item, track)
    rank = rerank_rank_for_track(item, track)
    window = max(int(RERANK_SELECTION_RANK_WINDOW or 1), 1)
    return score > 0 and 0 < rank <= window


def generic_rerank_quality_passes(item: Dict[str, Any]) -> bool:
    method_score, domain_score, transfer_score = quality_scores_for_item(item)
    return (
        method_score >= GENERIC_RERANK_QUALITY_MIN
        and domain_score >= GENERIC_RERANK_QUALITY_MIN
        and transfer_score >= GENERIC_RERANK_QUALITY_MIN
        and has_specific_method_entity(item)
    )


def allows_generic_rerank_bonus(item: Dict[str, Any], track: str) -> bool:
    query_text = rerank_query_text_for_track(item, track)
    if not is_generic_rerank_query_text(query_text):
        return True
    return generic_rerank_quality_passes(item)


def has_generic_rerank_quality_risk(item: Dict[str, Any], track: str) -> bool:
    query_text = rerank_query_text_for_track(item, track)
    return (
        active_rerank_selection_signal(item, track)
        and is_generic_rerank_query_text(query_text)
        and not generic_rerank_quality_passes(item)
    )


def rerank_selection_bonus(item: Dict[str, Any], track: str) -> float:
    score = rerank_score_for_track(item, track)
    if score <= 0:
        return 0.0
    rank = rerank_rank_for_track(item, track)
    if rank <= 0:
        return 0.0
    window = max(int(RERANK_SELECTION_RANK_WINDOW or 1), 1)
    rank_factor = max(0.0, (window - rank + 1) / window)
    if rank_factor <= 0:
        return 0.0
    if not allows_generic_rerank_bonus(item, track):
        return 0.0
    return float(RERANK_SELECTION_WEIGHT) * score * rank_factor


def normalize_recommend_mix(value: Any) -> Dict[str, int]:
    raw = value if isinstance(value, dict) else {}
    try:
        core = int(raw.get("core_ratio"))
    except Exception:
        core = DEFAULT_RECOMMEND_MIX["core_ratio"]
    try:
        inspiration = int(raw.get("inspiration_ratio"))
    except Exception:
        inspiration = DEFAULT_RECOMMEND_MIX["inspiration_ratio"]
    core = core if core >= 0 else DEFAULT_RECOMMEND_MIX["core_ratio"]
    inspiration = inspiration if inspiration >= 0 else DEFAULT_RECOMMEND_MIX["inspiration_ratio"]
    if core <= 0 and inspiration <= 0:
        return dict(DEFAULT_RECOMMEND_MIX)
    return {"core_ratio": core, "inspiration_ratio": inspiration}


def normalize_relevance_track(value: Any, default: str = TRACK_CORE) -> str:
    text = str(value or "").strip().lower()
    if text in {TRACK_CORE, TRACK_INSPIRATION, TRACK_BRIDGE}:
        return text
    return default


def item_paper_id(item: Dict[str, Any]) -> str:
    return str(item.get("id") or item.get("paper_id") or "").strip()


def parse_arxiv_versioned_id(item: Dict[str, Any]) -> Tuple[str, int] | None:
    pid = item_paper_id(item)
    if not pid:
        return None
    match = ARXIV_VERSIONED_ID_RE.match(pid)
    if not match:
        return None
    source = str(item.get("source") or "").strip().lower()
    if source and source != "arxiv":
        return None
    try:
        version = int(match.group(2) or 0)
    except Exception:
        version = 0
    return match.group(1), version


def paper_dedup_key(item: Dict[str, Any]) -> str:
    arxiv_key = parse_arxiv_versioned_id(item)
    if arxiv_key:
        return f"arxiv:{arxiv_key[0]}"
    return item_paper_id(item)


def is_fresh_item(item: Dict[str, Any]) -> bool:
    return item.get("_source") == "new" or item.get("selection_source") == SOURCE_FRESH_FETCH


def prefer_dedup_candidate(candidate: Dict[str, Any], existing: Dict[str, Any]) -> bool:
    candidate_arxiv = parse_arxiv_versioned_id(candidate)
    existing_arxiv = parse_arxiv_versioned_id(existing)
    if candidate_arxiv and existing_arxiv and candidate_arxiv[0] == existing_arxiv[0]:
        if candidate_arxiv[1] != existing_arxiv[1]:
            return candidate_arxiv[1] > existing_arxiv[1]

    if is_fresh_item(candidate) != is_fresh_item(existing):
        return is_fresh_item(candidate)

    candidate_score = parse_score(candidate.get("selection_score") or candidate.get("llm_score"))
    existing_score = parse_score(existing.get("selection_score") or existing.get("llm_score"))
    if candidate_score != existing_score:
        return candidate_score > existing_score

    return False


def dedupe_papers_by_key(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    merged: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        key = paper_dedup_key(item)
        if not key:
            continue
        existing = merged.get(key)
        if existing is None:
            merged[key] = item
            order.append(key)
        elif prefer_dedup_candidate(item, existing):
            merged[key] = item
    return [merged[key] for key in order if key in merged]


def build_scored_papers(papers: List[Dict[str, Any]], llm_ranked: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    paper_map = {}
    for p in papers:
        pid = str(p.get("id") or "").strip()
        if not pid:
            continue
        paper_map[pid] = p

    merged: Dict[str, Dict[str, Any]] = {}
    for item in llm_ranked:
        pid = str(item.get("paper_id") or item.get("id") or "").strip()
        if not pid or pid not in paper_map:
            continue
        score = parse_score(item.get("score"))
        prev = merged.get(pid)
        if prev is not None and score <= float(prev.get("llm_score", 0)):
            continue
        paper = dict(paper_map[pid])
        core_score = parse_score(item.get("core_relevance_score"))
        inspiration_score = parse_score(item.get("inspiration_score"))
        method_score = parse_quality_score(item, "method_substance_score", score)
        domain_score = parse_quality_score(item, "domain_breadth_score", score)
        transfer_score = parse_quality_score(item, "transfer_specificity_score", score)
        relevance_track = normalize_relevance_track(item.get("relevance_track"), TRACK_CORE)
        has_core_score = "core_relevance_score" in item
        has_inspiration_score = "inspiration_score" in item
        has_dual_scores = has_core_score or has_inspiration_score
        if has_dual_scores:
            # 兼容旧/半结构化 LLM 结果：只给总分和 track 时补齐对应 lane。
            if not has_core_score and relevance_track in {TRACK_CORE, TRACK_BRIDGE}:
                core_score = score
            if not has_inspiration_score and relevance_track in {TRACK_INSPIRATION, TRACK_BRIDGE}:
                inspiration_score = score
        if inspiration_score >= 8.0 and (
            method_score < DEEP_METHOD_SUBSTANCE_MIN
            or domain_score < DEEP_DOMAIN_BREADTH_MIN
            or transfer_score < BRIDGE_TRANSFER_SPECIFICITY_MIN
        ):
            inspiration_score = 7.0
        if has_dual_scores:
            score = max(core_score, inspiration_score)
        if has_dual_scores:
            if (
                core_score >= 8.0
                and inspiration_score >= 8.0
                and method_score >= DEEP_METHOD_SUBSTANCE_MIN
                and domain_score >= DEEP_DOMAIN_BREADTH_MIN
                and transfer_score >= BRIDGE_TRANSFER_SPECIFICITY_MIN
            ):
                relevance_track = TRACK_BRIDGE
            elif inspiration_score > core_score:
                relevance_track = TRACK_INSPIRATION
            else:
                relevance_track = TRACK_CORE
        elif relevance_track == TRACK_INSPIRATION:
            inspiration_score = score
        else:
            core_score = score

        paper["core_relevance_score"] = core_score
        paper["inspiration_score"] = inspiration_score
        paper["method_substance_score"] = method_score
        paper["domain_breadth_score"] = domain_score
        paper["transfer_specificity_score"] = transfer_score

        if relevance_track == TRACK_INSPIRATION:
            selection_score = inspiration_score + rerank_selection_bonus(paper, TRACK_INSPIRATION)
            selection_lane = TRACK_INSPIRATION
        elif relevance_track == TRACK_BRIDGE:
            core_selection = core_score + rerank_selection_bonus(paper, TRACK_CORE)
            inspiration_selection = inspiration_score + rerank_selection_bonus(paper, TRACK_INSPIRATION)
            selection_score = max(core_selection, inspiration_selection) + BRIDGE_SELECTION_BONUS
            selection_lane = TRACK_CORE if core_selection >= inspiration_selection else TRACK_INSPIRATION
        else:
            selection_score = core_score + rerank_selection_bonus(paper, TRACK_CORE)
            selection_lane = TRACK_CORE

        paper["llm_score"] = score
        paper["core_relevance_score"] = core_score
        paper["inspiration_score"] = inspiration_score
        paper["method_substance_score"] = method_score
        paper["domain_breadth_score"] = domain_score
        paper["transfer_specificity_score"] = transfer_score
        paper["relevance_track"] = relevance_track
        paper["relevance_track_label"] = TRACK_LABELS.get(relevance_track, TRACK_LABELS[TRACK_CORE])
        paper["selection_score"] = float(selection_score)
        paper["selection_lane"] = selection_lane
        paper["track_evidence_en"] = str(item.get("track_evidence_en") or "").strip()
        paper["track_evidence_cn"] = str(item.get("track_evidence_cn") or "").strip()
        evidence_cn = str(item.get("evidence_cn") or "").strip()
        evidence_en = str(item.get("evidence_en") or "").strip()
        tldr_cn = str(item.get("tldr_cn") or "").strip()
        tldr_en = str(item.get("tldr_en") or "").strip()
        legacy = str(item.get("evidence") or "").strip()
        canonical_evidence = evidence_cn or evidence_en or legacy
        # 优先保存中英双语；同时保留 llm_evidence 作为“默认展示”字段（优先中文）
        paper["llm_evidence_en"] = evidence_en or legacy
        paper["llm_evidence_cn"] = evidence_cn or (evidence_en or legacy)
        paper["llm_evidence"] = paper["llm_evidence_cn"]
        paper["canonical_evidence"] = canonical_evidence
        paper["llm_tldr_en"] = tldr_en
        paper["llm_tldr_cn"] = tldr_cn or tldr_en
        paper["llm_tldr"] = paper["llm_tldr_cn"]
        tags = normalize_tags(item.get("tags"))
        matched_query_tag = str(item.get("matched_query_tag") or "").strip()
        if matched_query_tag and matched_query_tag not in tags:
            tags.append(matched_query_tag)
        track_tag = f"paper:{TRACK_LABELS.get(relevance_track, TRACK_LABELS[TRACK_CORE])}"
        if track_tag not in tags:
            tags.append(track_tag)
        paper["llm_tags"] = tags
        paper["matched_query_tag"] = matched_query_tag
        paper["matched_query_text"] = str(item.get("matched_query_text") or "").strip()
        paper["matched_requirement_id"] = str(item.get("matched_requirement_id") or "").strip()
        merged[pid] = paper

    return list(merged.values())


def build_candidates(
    scored_papers: List[Dict[str, Any]],
    carryover_items: List[Dict[str, Any]],
    seen_ids: set,
) -> List[Dict[str, Any]]:
    merged: Dict[str, Dict[str, Any]] = {}

    for item in carryover_items:
        pid = str(item.get("id") or item.get("paper_id") or "").strip()
        if float(item.get("llm_score", 0)) < CARRYOVER_MIN_SCORE:
            continue
        key = paper_dedup_key(item)
        if not pid or not key or pid in seen_ids or key in seen_ids:
            continue
        copied = dict(item)
        copied["id"] = pid
        copied["_source"] = "carryover"
        copied["selection_source"] = SOURCE_CARRYOVER_CACHE
        existing = merged.get(key)
        if existing is None or prefer_dedup_candidate(copied, existing):
            merged[key] = copied

    for item in scored_papers:
        pid = str(item.get("id") or "").strip()
        key = paper_dedup_key(item)
        if not pid or not key or pid in seen_ids or key in seen_ids:
            continue
        copied = dict(item)
        copied["_source"] = "new"
        copied["selection_source"] = SOURCE_FRESH_FETCH
        existing = merged.get(key)
        if existing is None or prefer_dedup_candidate(copied, existing):
            merged[key] = copied

    return list(merged.values())


def sort_by_score(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(
        items,
        key=lambda x: (
            -float(x.get("selection_score", x.get("llm_score", 0)) or 0),
            -float(x.get("llm_score", 0) or 0),
            str(x.get("id") or ""),
        ),
    )


def select_deep_with_quality_backfill(
    ranked_candidates: List[Dict[str, Any]],
    cap: int,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], int]:
    if cap <= 0:
        return [], list(ranked_candidates), 0

    initial_deep = list(ranked_candidates[:cap])
    tail = list(ranked_candidates[cap:])
    deep_selected: List[Dict[str, Any]] = []
    downgraded: List[Dict[str, Any]] = []
    selected_keys = set()
    downgraded_keys = set()

    for item in initial_deep:
        reason = deep_quality_downgrade_reason(item)
        key = paper_dedup_key(item)
        if reason:
            item["selection_downgrade_reason"] = reason
            copied = dict(item)
            downgraded.append(copied)
            if key:
                downgraded_keys.add(key)
            continue
        deep_selected.append(item)
        if key:
            selected_keys.add(key)

    for item in tail:
        if len(deep_selected) >= cap:
            break
        key = paper_dedup_key(item)
        if not key or key in selected_keys:
            continue
        if is_deep_quality_eligible(item):
            deep_selected.append(item)
            selected_keys.add(key)

    remaining_after_deep = list(downgraded)
    for item in ranked_candidates:
        key = paper_dedup_key(item)
        if not key or key in selected_keys or key in downgraded_keys:
            continue
        remaining_after_deep.append(item)

    return deep_selected, remaining_after_deep, len(downgraded)


def refresh_selection_diagnostics(result: Dict[str, Any]) -> Dict[str, Any]:
    papers = [item for item in (result.get("papers") or []) if isinstance(item, dict)]
    selected: Dict[str, Tuple[str, int]] = {}
    for section_key, label in (("deep_dive", "deep"), ("quick_skim", "quick")):
        for idx, item in enumerate(result.get(section_key) or [], start=1):
            if not isinstance(item, dict):
                continue
            key = paper_dedup_key(item)
            if key:
                selected[key] = (label, idx)
            set_selection_rank(
                item,
                candidate_rank=idx,
                selected=True,
                section=label,
                section_rank=idx,
            )

    for idx, paper in enumerate(papers, start=1):
        key = paper_dedup_key(paper)
        section, section_rank = selected.get(key, ("", None))
        set_selection_rank(
            paper,
            candidate_rank=idx,
            selected=bool(section),
            section=section,
            section_rank=section_rank,
            downgrade_reason=str(paper.get("selection_downgrade_reason") or ""),
        )
    finalize_paper_diagnostics(papers)
    for section_key in ("deep_dive", "quick_skim"):
        finalize_paper_diagnostics([item for item in (result.get(section_key) or []) if isinstance(item, dict)])
    stats = dict(result.get("stats") or {})
    stats["diagnostics_stage_coverage"] = diagnostics_stage_coverage(papers)
    result["stats"] = stats
    result["papers"] = papers
    return result


def validate_recommend_payload(result: Dict[str, Any], *, output_path: str = "") -> None:
    papers = [item for item in (result.get("papers") or []) if isinstance(item, dict)]
    selected = selected_items(result)
    context = f" ({output_path})" if output_path else ""
    if selected and not papers:
        raise RuntimeError(f"recommend 诊断快照缺失 papers 列表{context}")

    paper_by_key = {
        paper_dedup_key(item): item
        for item in papers
        if paper_dedup_key(item)
    }
    for item in selected:
        key = paper_dedup_key(item)
        if not key or key not in paper_by_key:
            raise RuntimeError(f"recommend 诊断快照缺少入选论文：{item_paper_id(item) or key}{context}")

    missing_selection = []
    missing_stage_keys = []
    for paper in papers:
        pid = item_paper_id(paper)
        stage_ranks = ((paper.get("diagnostics") or {}).get("stage_ranks") or {})
        if "selection" not in stage_ranks:
            missing_selection.append(pid)
        for stage in PIPELINE_STAGE_NAMES:
            if stage not in stage_ranks:
                missing_stage_keys.append(f"{pid}:{stage}")
                break
    if missing_selection:
        raise RuntimeError(f"recommend 诊断快照缺少 selection 阶段：{missing_selection[:5]}{context}")
    if missing_stage_keys:
        raise RuntimeError(f"recommend 诊断快照缺少阶段槽位：{missing_stage_keys[:5]}{context}")

    coverage = diagnostics_stage_coverage(papers)
    selected_count = len(selected)
    if selected_count:
        for stage in PIPELINE_STAGE_NAMES:
            if int((coverage.get(stage) or {}).get("present") or 0) <= 0:
                raise RuntimeError(f"recommend 诊断快照缺少可比较的 {stage} rank/score{context}")


def profile_limit_key(tag: Any) -> str:
    return normalize_carryover_tag(tag).lower()


def resolve_profile_limit_key(raw_key: str, known_keys: set) -> str:
    if raw_key in known_keys:
        return raw_key
    for known_key in sorted(known_keys, key=len, reverse=True):
        if raw_key.startswith(f"{known_key}:"):
            return known_key
    return ""


def item_profile_limit_keys(item: Dict[str, Any], profile_limits: Dict[str, Dict[str, int]]) -> List[str]:
    known = {profile_limit_key(tag) for tag in profile_limits.keys() if profile_limit_key(tag)}
    keys: List[str] = []
    seen = set()
    for tag in resolve_carryover_tags(item):
        key = resolve_profile_limit_key(profile_limit_key(tag), known)
        if not key or key not in known or key in seen:
            continue
        seen.add(key)
        keys.append(key)
    return keys


def normalize_profile_section_limits(raw_limit: Any) -> Tuple[int, int]:
    def as_positive_int(value: Any, default: int = 10) -> int:
        try:
            parsed = int(value)
        except Exception:
            return default
        return parsed if parsed > 0 else default

    if isinstance(raw_limit, dict):
        legacy = raw_limit.get("daily_paper_limit") or raw_limit.get("daily_candidate_limit") or raw_limit.get("daily_limit")
        deep_default = as_positive_int(legacy, 10)
        quick_default = as_positive_int(legacy, 10)
        deep_limit = as_positive_int(
            raw_limit.get("deep") or raw_limit.get("deep_daily_paper_limit"),
            deep_default,
        )
        quick_limit = as_positive_int(
            raw_limit.get("quick") or raw_limit.get("quick_daily_paper_limit"),
            quick_default,
        )
        return deep_limit, quick_limit

    legacy_limit = as_positive_int(raw_limit, 10)
    return legacy_limit, legacy_limit


def ensure_selection_fields(item: Dict[str, Any]) -> Dict[str, Any]:
    copied = dict(item)
    track = normalize_relevance_track(copied.get("relevance_track"), TRACK_CORE)
    core_score = parse_score(copied.get("core_relevance_score"))
    inspiration_score = parse_score(copied.get("inspiration_score"))
    llm_score = parse_score(copied.get("llm_score"))
    if core_score <= 0 and inspiration_score <= 0 and llm_score > 0:
        if track == TRACK_INSPIRATION:
            inspiration_score = llm_score
        else:
            core_score = llm_score
    if track == TRACK_INSPIRATION:
        selection_score = inspiration_score + rerank_selection_bonus(copied, TRACK_INSPIRATION)
        lane = TRACK_INSPIRATION
    elif track == TRACK_BRIDGE:
        core_selection = core_score + rerank_selection_bonus(copied, TRACK_CORE)
        inspiration_selection = inspiration_score + rerank_selection_bonus(copied, TRACK_INSPIRATION)
        selection_score = max(core_selection, inspiration_selection) + BRIDGE_SELECTION_BONUS
        lane = copied.get("selection_lane")
        lane = (
            lane
            if lane in {TRACK_CORE, TRACK_INSPIRATION}
            else (TRACK_CORE if core_selection >= inspiration_selection else TRACK_INSPIRATION)
        )
    else:
        selection_score = core_score + rerank_selection_bonus(copied, TRACK_CORE)
        lane = TRACK_CORE
    copied["core_relevance_score"] = core_score
    copied["inspiration_score"] = inspiration_score
    copied["relevance_track"] = track
    copied["relevance_track_label"] = TRACK_LABELS.get(track, TRACK_LABELS[TRACK_CORE])
    copied["selection_score"] = float(selection_score)
    copied["selection_lane"] = lane
    tags = normalize_tags(copied.get("llm_tags"))
    track_tag = f"paper:{TRACK_LABELS.get(track, TRACK_LABELS[TRACK_CORE])}"
    if track_tag not in tags:
        tags.append(track_tag)
    copied["llm_tags"] = tags
    return copied


def allocate_mix_quota(target: int, mix: Dict[str, int]) -> Dict[str, int]:
    safe_target = max(int(target or 0), 0)
    normalized = normalize_recommend_mix(mix)
    core_ratio = int(normalized.get("core_ratio") or 0)
    inspiration_ratio = int(normalized.get("inspiration_ratio") or 0)
    if safe_target <= 0:
        return {TRACK_CORE: 0, TRACK_INSPIRATION: 0}
    if core_ratio <= 0:
        return {TRACK_CORE: 0, TRACK_INSPIRATION: safe_target}
    if inspiration_ratio <= 0:
        return {TRACK_CORE: safe_target, TRACK_INSPIRATION: 0}
    total = core_ratio + inspiration_ratio
    core_float = safe_target * core_ratio / total
    core_quota = int(core_float)
    inspiration_quota = safe_target - core_quota
    # 余数优先给小数部分更大的通路；2:3, target=5 会得到 2/3。
    if core_quota + inspiration_quota < safe_target:
        core_quota += 1
    return {TRACK_CORE: core_quota, TRACK_INSPIRATION: inspiration_quota}


def aggregate_recommend_mix(profile_mixes: Dict[str, Dict[str, int]] | None) -> Dict[str, int]:
    if not profile_mixes:
        return dict(DEFAULT_RECOMMEND_MIX)
    core = 0
    inspiration = 0
    for raw in profile_mixes.values():
        mix = normalize_recommend_mix(raw)
        core += int(mix.get("core_ratio") or 0)
        inspiration += int(mix.get("inspiration_ratio") or 0)
    return normalize_recommend_mix({"core_ratio": core, "inspiration_ratio": inspiration})


def lookup_profile_mix(
    profile_recommend_mix: Dict[str, Dict[str, int]] | None,
    *keys: str,
) -> Dict[str, int]:
    mixes = profile_recommend_mix or {}
    lowered = {str(k).lower(): v for k, v in mixes.items()}
    for key in keys:
        if key in mixes:
            return normalize_recommend_mix(mixes[key])
        lowered_value = lowered.get(str(key).lower())
        if lowered_value is not None:
            return normalize_recommend_mix(lowered_value)
    return dict(DEFAULT_RECOMMEND_MIX)


def select_by_recommend_mix(
    candidates: List[Dict[str, Any]],
    target: int,
    mix: Dict[str, int] | None = None,
) -> List[Dict[str, Any]]:
    if target <= 0:
        return []
    normalized_mix = normalize_recommend_mix(mix or DEFAULT_RECOMMEND_MIX)
    quotas = allocate_mix_quota(target, normalized_mix)
    enabled = {
        lane
        for lane, ratio in (
            (TRACK_CORE, int(normalized_mix.get("core_ratio") or 0)),
            (TRACK_INSPIRATION, int(normalized_mix.get("inspiration_ratio") or 0)),
        )
        if ratio > 0
    }
    if not enabled:
        return []

    prepared = [ensure_selection_fields(item) for item in candidates if isinstance(item, dict)]
    selected: List[Dict[str, Any]] = []
    selected_keys = set()

    def eligible_for_lane(item: Dict[str, Any], lane: str) -> bool:
        track = normalize_relevance_track(item.get("relevance_track"), TRACK_CORE)
        item_lane = item.get("selection_lane")
        if track == TRACK_BRIDGE:
            return lane in enabled
        return (item_lane or track) == lane

    def lane_score(item: Dict[str, Any], lane: str) -> float:
        bonus = (
            BRIDGE_SELECTION_BONUS
            if normalize_relevance_track(item.get("relevance_track"), TRACK_CORE) == TRACK_BRIDGE
            else 0.0
        )
        if lane == TRACK_INSPIRATION:
            return (
                parse_score(item.get("inspiration_score"))
                + rerank_selection_bonus(item, TRACK_INSPIRATION)
                + bonus
            )
        return (
            parse_score(item.get("core_relevance_score"))
            + rerank_selection_bonus(item, TRACK_CORE)
            + bonus
        )

    def pick_for_lane(lane: str, need: int, allow_bridge: bool) -> None:
        if need <= 0:
            return
        pool = []
        for item in prepared:
            key = paper_dedup_key(item)
            if not key or key in selected_keys:
                continue
            track = normalize_relevance_track(item.get("relevance_track"), TRACK_CORE)
            if not allow_bridge and track == TRACK_BRIDGE:
                continue
            if eligible_for_lane(item, lane):
                pool.append(item)
        pool = sorted(pool, key=lambda item: (-lane_score(item, lane), -parse_score(item.get("llm_score")), str(item.get("id") or "")))
        for item in pool[:need]:
            copied = dict(item)
            copied["selection_lane"] = lane
            selected.append(copied)
            key = paper_dedup_key(copied)
            if key:
                selected_keys.add(key)

    for lane in (TRACK_CORE, TRACK_INSPIRATION):
        pick_for_lane(lane, quotas.get(lane, 0), allow_bridge=True)

    lane_order = [lane for lane in (TRACK_CORE, TRACK_INSPIRATION) if lane in enabled]
    while len(selected) < target:
        shortages = {
            lane: max(quotas.get(lane, 0) - sum(1 for item in selected if item.get("selection_lane") == lane), 0)
            for lane in lane_order
        }
        lane = max(lane_order, key=lambda key: (shortages.get(key, 0), quotas.get(key, 0), -lane_order.index(key)), default="")
        if not lane or shortages.get(lane, 0) <= 0:
            break
        before = len(selected)
        pick_for_lane(lane, 1, allow_bridge=True)
        if len(selected) == before:
            break

    if len(selected) < target:
        remaining = [
            item
            for item in prepared
            if paper_dedup_key(item)
            and paper_dedup_key(item) not in selected_keys
            and (item.get("selection_lane") in enabled or normalize_relevance_track(item.get("relevance_track"), TRACK_CORE) == TRACK_BRIDGE)
        ]
        for item in sort_by_score(remaining):
            if len(selected) >= target:
                break
            fallback_lane = TRACK_CORE if TRACK_CORE in enabled else TRACK_INSPIRATION
            lane = item.get("selection_lane") if item.get("selection_lane") in enabled else fallback_lane
            copied = dict(item)
            copied["selection_lane"] = lane
            selected.append(copied)
            selected_keys.add(paper_dedup_key(copied))

    return selected[:target]


def apply_profile_daily_limits(
    result: Dict[str, Any],
    profile_limits: Dict[str, Dict[str, int]] | None,
    profile_recommend_mix: Dict[str, Dict[str, int]] | None = None,
) -> Dict[str, Any]:
    if not profile_limits:
        return result

    normalized_limits: Dict[str, Tuple[str, int, int]] = {}
    for tag, raw_limit in profile_limits.items():
        key = profile_limit_key(tag)
        if not key:
            continue
        deep_limit, quick_limit = normalize_profile_section_limits(raw_limit)
        if deep_limit <= 0 or quick_limit <= 0:
            continue
        normalized_limits[key] = (str(tag), deep_limit, quick_limit)
    if not normalized_limits:
        return result

    deep_items = dedupe_papers_by_key([item for item in (result.get("deep_dive") or []) if isinstance(item, dict)])
    quick_items = dedupe_papers_by_key([item for item in (result.get("quick_skim") or []) if isinstance(item, dict)])
    allowed_deep_ids_by_key: Dict[str, set] = {}
    allowed_quick_ids_by_key: Dict[str, set] = {}
    dropped_by_tag: Dict[str, Dict[str, int]] = {}

    for key, (tag, deep_limit, quick_limit) in normalized_limits.items():
        deep_for_tag = [
            item
            for item in deep_items
            if key in item_profile_limit_keys(item, profile_limits)
        ]
        quick_for_tag = [
            item
            for item in quick_items
            if key in item_profile_limit_keys(item, profile_limits)
        ]
        picked_deep = sort_by_score(deep_for_tag)[:deep_limit]
        picked_quick = sort_by_score(quick_for_tag)[:quick_limit]
        allowed_deep_ids = {
            item_paper_id(item)
            for item in picked_deep
            if item_paper_id(item)
        }
        allowed_quick_ids = {
            item_paper_id(item)
            for item in picked_quick
            if item_paper_id(item)
        }
        all_deep_ids = {
            item_paper_id(item)
            for item in deep_for_tag
            if item_paper_id(item)
        }
        all_quick_ids = {
            item_paper_id(item)
            for item in quick_for_tag
            if item_paper_id(item)
        }
        allowed_deep_ids_by_key[key] = allowed_deep_ids
        allowed_quick_ids_by_key[key] = allowed_quick_ids
        dropped_by_tag[tag] = {
            "deep": max(len(all_deep_ids - allowed_deep_ids), 0),
            "quick": max(len(all_quick_ids - allowed_quick_ids), 0),
        }

    def keep_item(item: Dict[str, Any], section: str) -> bool:
        pid = item_paper_id(item)
        if not pid:
            return False
        keys = item_profile_limit_keys(item, profile_limits)
        if not keys:
            return True
        allowed_map = allowed_deep_ids_by_key if section == "deep" else allowed_quick_ids_by_key
        return all(pid in allowed_map.get(key, set()) for key in keys)

    filtered_deep = [item for item in deep_items if keep_item(item, "deep")]
    filtered_quick = [item for item in quick_items if keep_item(item, "quick")]

    copied = dict(result)
    copied["deep_dive"] = filtered_deep
    copied["quick_skim"] = filtered_quick
    stats = dict(copied.get("stats") or {})
    stats["deep_selected_before_profile_limit"] = int(stats.get("deep_selected") or len(deep_items))
    stats["quick_selected_before_profile_limit"] = int(stats.get("quick_selected") or len(quick_items))
    stats["deep_selected"] = len(filtered_deep)
    stats["quick_selected"] = len(filtered_quick)
    stats["profile_daily_limits"] = {
        tag: {"deep": deep_limit, "quick": quick_limit}
        for _key, (tag, deep_limit, quick_limit) in normalized_limits.items()
    }
    stats["profile_recommend_mix"] = {
        tag: lookup_profile_mix(profile_recommend_mix, tag, _key)
        for _key, (tag, _deep_limit, _quick_limit) in normalized_limits.items()
    }
    stats["profile_limit_dropped_by_tag"] = dropped_by_tag
    stats["profile_limit_dropped"] = max(
        (len(deep_items) + len(quick_items)) - (len(filtered_deep) + len(filtered_quick)),
        0,
    )
    copied["stats"] = stats
    return copied


def build_tag_map(candidates: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    tag_map: Dict[str, List[Dict[str, Any]]] = {}
    for item in candidates:
        tags = item.get("llm_tags") or []
        if not tags:
            tags = ["untagged"]
        for tag in tags:
            tag_map.setdefault(str(tag), []).append(item)

    for tag, items in tag_map.items():
        tag_map[tag] = sort_by_score(items)
    return tag_map


def round_robin_select(candidates: List[Dict[str, Any]], cap: int) -> List[Dict[str, Any]]:
    if cap <= 0:
        return []
    tag_map = build_tag_map(candidates)
    if not tag_map:
        return []

    tag_order = sorted(
        tag_map.keys(),
        key=lambda t: (-float(tag_map[t][0].get("llm_score", 0)), t),
    )

    selected: List[Dict[str, Any]] = []
    selected_keys = set()
    indices = {tag: 0 for tag in tag_order}

    while len(selected) < cap:
        added = False
        for tag in tag_order:
            items = tag_map[tag]
            idx = indices[tag]
            while idx < len(items) and paper_dedup_key(items[idx]) in selected_keys:
                idx += 1
            if idx < len(items):
                item = items[idx]
                selected.append(item)
                selected_keys.add(paper_dedup_key(item))
                indices[tag] = idx + 1
                added = True
                if len(selected) >= cap:
                    break
            else:
                indices[tag] = idx
        if not added:
            break
    return selected


def split_layers(candidates: List[Dict[str, Any]]) -> List[Tuple[str, List[Dict[str, Any]]]]:
    results: List[Tuple[str, List[Dict[str, Any]]]] = []

    high_bucket = [p for p in candidates if float(p.get("llm_score", 0)) >= 8.0]
    if high_bucket:
        results.append(("8plus", sort_by_score(high_bucket)))

    mid_bucket = [p for p in candidates if 7.0 <= float(p.get("llm_score", 0)) < 8.0]
    results.append(("7", sort_by_score(mid_bucket)))

    low_bucket = [p for p in candidates if 6.0 <= float(p.get("llm_score", 0)) < 7.0]
    results.append(("6", sort_by_score(low_bucket)))

    return results


def allocate_uniform(layers: List[Tuple[str, List[Dict[str, Any]]]], target: int) -> Dict[str, List[Dict[str, Any]]]:
    if target <= 0:
        return {name: [] for name, _ in layers}
    num_layers = len(layers)
    base = target // num_layers if num_layers else 0
    remainder = target % num_layers if num_layers else 0

    quotas: Dict[str, int] = {}
    for idx, (name, _items) in enumerate(layers):
        quotas[name] = base + (1 if idx < remainder else 0)

    selected: Dict[str, List[Dict[str, Any]]] = {name: [] for name, _ in layers}
    remaining = target
    for name, items in layers:
        take = min(len(items), quotas[name])
        selected[name] = items[:take]
        remaining -= take

    if remaining > 0:
        for name, items in layers:
            if remaining <= 0:
                break
            extra = items[len(selected[name]) :]
            if not extra:
                continue
            take = min(len(extra), remaining)
            selected[name].extend(extra[:take])
            remaining -= take

    return selected


def allocate_low_bias(
    layers: List[Tuple[str, List[Dict[str, Any]]]],
    target: int,
    low_ratio: float = 0.7,
) -> Dict[str, List[Dict[str, Any]]]:
    if target <= 0:
        return {name: [] for name, _ in layers}

    tier_names = [name for name, _ in layers]
    quotas: Dict[str, int] = {name: 0 for name in tier_names}

    if "6" in tier_names:
        low_quota = int(round(target * low_ratio))
        quotas["6"] = low_quota
        remaining = max(target - low_quota, 0)
        others = [n for n in tier_names if n != "6"]
    else:
        remaining = target
        others = tier_names[:]

    if others:
        base = remaining // len(others)
        rem = remaining % len(others)
        for idx, name in enumerate(others):
            quotas[name] += base + (1 if idx < rem else 0)

    selected: Dict[str, List[Dict[str, Any]]] = {name: [] for name, _ in layers}
    remaining = target
    for name, items in layers:
        take = min(len(items), quotas.get(name, 0))
        selected[name] = items[:take]
        remaining -= take

    if remaining > 0:
        for name, items in layers:
            if remaining <= 0:
                break
            extra = items[len(selected[name]) :]
            if not extra:
                continue
            take = min(len(extra), remaining)
            selected[name].extend(extra[:take])
            remaining -= take

    return selected


def interleave_layers(
    selected_by_layer: Dict[str, List[Dict[str, Any]]],
    order: List[str],
) -> List[Dict[str, Any]]:
    result: List[Dict[str, Any]] = []
    idx = {name: 0 for name in order}
    added = True
    while added:
        added = False
        for name in order:
            items = selected_by_layer.get(name) or []
            if idx[name] < len(items):
                result.append(items[idx[name]])
                idx[name] += 1
                added = True
    return result


def select_quick_skim(
    candidates: List[Dict[str, Any]],
    target: int,
    strategy: str,
) -> List[Dict[str, Any]]:
    layers = split_layers(candidates)
    order = [name for name, _ in layers]

    if strategy == "low_bias":
        selected_by_layer = allocate_low_bias(layers, target)
    else:
        selected_by_layer = allocate_uniform(layers, target)

    # 标记分层信息，便于消费侧识别
    marked: Dict[str, List[Dict[str, Any]]] = {}
    for name, items in selected_by_layer.items():
        marked[name] = [dict(item, quick_tier=name) for item in items]

    return interleave_layers(marked, order)[:target]


def sanitize_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    cleaned: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        copied = dict(item)
        copied.pop("_source", None)
        copied.pop("carry_days", None)
        cleaned.append(copied)
    return cleaned


def select_deep_with_carryover(
    candidates: List[Dict[str, Any]],
    cap: int,
    carryover_ratio: float,
) -> List[Dict[str, Any]]:
    if cap <= 0:
        return []
    new_items = [p for p in candidates if p.get("_source") != "carryover"]
    carry_items = [p for p in candidates if p.get("_source") == "carryover"]

    max_carry = int(cap * carryover_ratio) if carryover_ratio > 0 else 0
    cap_new = max(cap - max_carry, 0)

    selected: List[Dict[str, Any]] = []
    selected_keys = set()

    if new_items:
        pick_new = round_robin_select(new_items, min(cap_new, len(new_items)))
        selected.extend(pick_new)
        selected_keys.update(paper_dedup_key(p) for p in pick_new if paper_dedup_key(p))

    remaining = cap - len(selected)
    if remaining > 0 and carry_items:
        pick_carry = round_robin_select(carry_items, min(remaining, len(carry_items)))
        selected.extend(pick_carry)
        selected_keys.update(paper_dedup_key(p) for p in pick_carry if paper_dedup_key(p))
        remaining = cap - len(selected)

    if remaining > 0 and new_items:
        extra_new = [p for p in new_items if paper_dedup_key(p) not in selected_keys]
        if extra_new:
            pick_extra = round_robin_select(extra_new, min(remaining, len(extra_new)))
            selected.extend(pick_extra)

    return selected


def build_carryover_out(
    candidates: List[Dict[str, Any]],
    recommended_ids: set,
    carryover_days: int,
) -> List[Dict[str, Any]]:
    carryover_out: List[Dict[str, Any]] = []
    for item in candidates:
        pid = str(item.get("id") or "").strip()
        key = paper_dedup_key(item)
        if not pid or pid in recommended_ids or key in recommended_ids:
            continue
        if float(item.get("llm_score", 0)) < 8.0:
            continue
        carry_days = int(item.get("carry_days") or 1)
        if carry_days > carryover_days:
            continue
        copied = dict(item)
        copied.pop("_source", None)
        copied["selection_source"] = SOURCE_CARRYOVER_CACHE
        copied["paper_id"] = copied.get("id")
        copied["carry_days"] = carry_days
        carryover_out.append(copied)
    return carryover_out


def build_carryover_payload(
    existing_payload: Dict[str, Any],
    carryover_items: List[Dict[str, Any]],
    *,
    active_tags: List[str],
    carryover_days: int,
    updated_date: str,
) -> Dict[str, Any]:
    payload = normalize_carryover_payload(existing_payload)
    states = dict(payload.get("tag_states") or {})
    active_tag_keys = [
        normalize_carryover_tag(tag)
        for tag in (active_tags or [])
        if normalize_carryover_tag(tag)
    ]

    grouped: Dict[str, List[Dict[str, Any]]] = {tag: [] for tag in active_tag_keys}
    for item in carryover_items:
        if not isinstance(item, dict):
            continue
        bucket_tags = resolve_carryover_tags(item, fallback_tags=active_tag_keys)
        for tag in bucket_tags:
            if active_tag_keys and tag not in active_tag_keys:
                continue
            grouped.setdefault(tag, []).append(dict(item))

    for tag in active_tag_keys or list(grouped.keys()):
        states[tag] = {
            "updated_date": updated_date,
            "carryover_days": carryover_days,
            "items": grouped.get(tag, []),
        }

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "updated_date": updated_date,
        "carryover_days": carryover_days,
        "tag_states": states,
    }


def process_mode(
    candidates: List[Dict[str, Any]],
    tag_count: int,
    mode: str,
    cfg: Dict[str, Any],
    carryover_ratio: float,
    profile_daily_limits: Dict[str, Dict[str, int]] | None = None,
    profile_recommend_mix: Dict[str, Dict[str, int]] | None = None,
) -> Dict[str, Any]:
    candidates = dedupe_papers_by_key([ensure_selection_fields(item) for item in candidates if isinstance(item, dict)])
    if cfg.get("all_quick_min_score") is not None:
        return process_mode_all_quick_min_score(
            candidates=candidates,
            mode=mode,
            min_score=float(cfg.get("all_quick_min_score") or 0),
            profile_daily_limits=profile_daily_limits,
            profile_recommend_mix=profile_recommend_mix,
        )

    cap = None
    recommend_mix = aggregate_recommend_mix(profile_recommend_mix)
    ranked_candidates = sort_by_score(candidates)
    deep_selected: List[Dict[str, Any]]
    remaining_after_deep: List[Dict[str, Any]]
    downgraded_deep = 0
    if cfg.get("deep_unlimited"):
        deep_selected = list(ranked_candidates)
        remaining_after_deep = []
    else:
        deep_base = int(cfg.get("deep_base") or 0)
        cap = max(deep_base + tag_count, 0)
        deep_selected, remaining_after_deep, downgraded_deep = select_deep_with_quality_backfill(
            ranked_candidates,
            cap,
        )

    quick_base = int(cfg.get("quick_base") or 0)
    quick_target = max(quick_base + tag_count, 0)
    quick_selected = remaining_after_deep[:quick_target]

    stats = {
        "mode": mode,
        "tag_count": tag_count,
        "deep_divecandidates": len(ranked_candidates),
        "deep_cap": cap,
        "deep_selected": len(deep_selected),
        "quick_candidates": len(remaining_after_deep),
        "quick_skim_target": quick_target,
        "quick_selected": len(quick_selected),
        "recommend_mix": recommend_mix,
        "selection_strategy": "unified_rank_slice",
        "deep_quality_downgraded": downgraded_deep if not cfg.get("deep_unlimited") else 0,
        "deep_quality_thresholds": {
            "method_substance_score": DEEP_METHOD_SUBSTANCE_MIN,
            "domain_breadth_score": DEEP_DOMAIN_BREADTH_MIN,
            "bridge_transfer_specificity_score": BRIDGE_TRANSFER_SPECIFICITY_MIN,
            "core_direct_exception": {
                "core_relevance_score": CORE_DIRECT_RELEVANCE_EXCEPTION_MIN,
                "method_substance_score": CORE_DIRECT_METHOD_EXCEPTION_MIN,
                "domain_breadth_score_floor": CORE_DIRECT_DOMAIN_EXCEPTION_FLOOR,
                "transfer_specificity_score": CORE_DIRECT_TRANSFER_EXCEPTION_MIN,
            },
            "generic_rerank_quality_score": GENERIC_RERANK_QUALITY_MIN,
        },
    }

    result = {
        "mode": mode,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "stats": stats,
        "papers": sanitize_items(ranked_candidates),
        "deep_dive": sanitize_items(deep_selected),
        "quick_skim": sanitize_items(quick_selected),
    }
    result = apply_profile_daily_limits(result, profile_daily_limits, profile_recommend_mix)
    return refresh_selection_diagnostics(result)


def process_mode_all_quick_min_score(
    candidates: List[Dict[str, Any]],
    mode: str,
    min_score: float,
    profile_daily_limits: Dict[str, Dict[str, int]] | None = None,
    profile_recommend_mix: Dict[str, Dict[str, int]] | None = None,
) -> Dict[str, Any]:
    """
    回溯窗口（days）场景：不再做“精读/速览配额分配”，而是将达到阈值的论文全部输出到速览区。
    """
    candidates = dedupe_papers_by_key([ensure_selection_fields(item) for item in candidates if isinstance(item, dict)])
    threshold = float(min_score)
    ranked_candidates = sort_by_score(candidates)
    picked = [p for p in ranked_candidates if float(p.get("llm_score", 0)) >= threshold]

    stats = {
        "mode": mode,
        "forced_all_quick": True,
        "min_score": threshold,
        "deep_divecandidates": len(picked),
        "deep_cap": None,
        "deep_selected": 0,
        "quick_candidates": len(picked),
        "quick_skim_target": None,
        "quick_selected": len(picked),
    }

    result = {
        "mode": mode,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "stats": stats,
        "papers": sanitize_items(ranked_candidates),
        "deep_dive": [],
        "quick_skim": sanitize_items(picked),
    }
    result = apply_profile_daily_limits(result, profile_daily_limits, profile_recommend_mix)
    return refresh_selection_diagnostics(result)

def force_all_into_quick(result: Dict[str, Any]) -> Dict[str, Any]:
    """
    将精读区合并进速览区，确保所有论文都归入 quick_skim。
    规则：保留“精读优先”（高分在前）的顺序：deep_dive 在前，quick_skim 在后；同一规范化论文 key 保留首选版本。
    """
    deep = result.get("deep_dive") or []
    quick = result.get("quick_skim") or []
    merged = dedupe_papers_by_key([item for item in list(deep) + list(quick) if isinstance(item, dict)])

    copied = dict(result)
    copied["deep_dive"] = []
    copied["quick_skim"] = merged

    stats = dict((copied.get("stats") or {}))
    stats["deep_selected"] = 0
    stats["quick_selected"] = len(merged)
    stats["forced_all_quick"] = True
    copied["stats"] = stats
    return refresh_selection_diagnostics(copied)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Step 5: select papers for deep dive + quick skim (standard/extend/spark).",
    )
    parser.add_argument(
        "--input",
        type=str,
        default=os.path.join(RANKED_DIR, f"arxiv_papers_{TODAY_STR}.llm.json"),
        help="LLM refine JSON input path.",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default=RECOMMEND_DIR,
        help="output directory for selection JSON.",
    )
    parser.add_argument(
        "--modes",
        type=str,
        default=None,
        help="comma separated modes (standard,extend,spark,skims). default: config arxiv_paper_setting.mode",
    )
    parser.add_argument(
        "--carryover-only",
        action="store_true",
        help="只使用 archive/carryover.json 作为候选集（忽略输入文件与 seen_ids 过滤）。",
    )
    parser.add_argument(
        "--preserve-carryover",
        action="store_true",
        help="运行完成后不覆盖写入 archive/carryover.json（默认会按本次推荐结果更新）。",
    )
    parser.add_argument(
        "--all-quick",
        action="store_true",
        help="Force all selected papers into quick_skim (deep_dive will be empty).",
    )
    parser.add_argument(
        "--all-quick-min-score",
        type=float,
        default=None,
        help="When set, output ALL candidates with llm_score >= min_score into quick_skim (no caps).",
    )

    args = parser.parse_args()

    input_path = args.input
    if not os.path.isabs(input_path):
        input_path = os.path.abspath(os.path.join(ROOT_DIR, input_path))

    output_dir = args.output_dir
    if not os.path.isabs(output_dir):
        output_dir = os.path.abspath(os.path.join(ROOT_DIR, output_dir))

    setting = load_arxiv_paper_setting()
    lookback_days = resolve_positive_int(setting.get("days_window"), DEFAULT_LOOKBACK_DAYS)
    carryover_days = resolve_carryover_days(setting)
    mode_text = args.modes
    if not mode_text:
        mode_text = setting.get("mode") or "standard,extend,spark"

    modes = [m.strip() for m in str(mode_text or "").split(",") if m.strip()]
    modes = [m for m in modes if m in MODES]
    if not modes:
        raise ValueError("modes must include at least one of: standard, extend, spark, skims")

    # skims 模式用于“回溯窗口/批量重跑”：默认不做历史 seen_ids 过滤，
    # 否则会因为之前推荐过而导致输出数量偏少。
    ignore_seen_ids = False
    if modes and all((MODES.get(m) or {}).get("all_quick_min_score") is not None for m in modes):
        ignore_seen_ids = True

    log_substep("5.1", "加载输入数据", "START")
    try:
        if args.carryover_only:
            log("[INFO] carryover-only=true：将忽略输入文件，仅使用 carryover 作为候选集。")
            papers = []
            llm_ranked = []
        else:
            # 检查输入文件是否存在，如果不存在则只使用 carryover
            if not os.path.exists(input_path):
                log(f"[INFO] 输入文件不存在：{input_path}（今天没有新论文，将只使用 carryover）")
                papers = []
                llm_ranked = []
            else:
                data = load_json(input_path)
                papers = data.get("papers") or []
                llm_ranked = data.get("llm_ranked") or []
    finally:
        log_substep("5.1", "加载输入数据", "END")

    if not papers or not llm_ranked:
        log("[INFO] 今天没有新论文，将只使用 carryover 生成推荐。")

    tag_count, tag_list = load_config_tag_count()
    profile_daily_limits = load_config_profile_daily_limits()
    profile_recommend_mix = load_config_profile_recommend_mix()
    active_carryover_tags = [normalize_carryover_tag(tag) for tag in tag_list if normalize_carryover_tag(tag)]
    log(f"[INFO] config tags={tag_count} | {tag_list}")
    log(f"[INFO] profile daily paper limits={profile_daily_limits}")
    log(f"[INFO] profile recommend mix={profile_recommend_mix}")
    log(f"[INFO] arxiv_paper_setting mode={mode_text} days_window={lookback_days} carryover_days={carryover_days}")

    group_start(f"Step 5 - select {os.path.basename(input_path)}")
    log_substep("5.2", "构建评分论文列表", "START")
    try:
        scored_papers = build_scored_papers(papers, llm_ranked)
        log(f"[INFO] scored_papers={len(scored_papers)}")
    finally:
        log_substep("5.2", "构建评分论文列表", "END")

    archive_root = os.path.join(ROOT_DIR, "archive")
    today_date = parse_date_str(TODAY_STR)
    if args.carryover_only or ignore_seen_ids:
        seen_ids = set()
        if ignore_seen_ids:
            log("[INFO] skims/backfill 模式：已关闭历史 seen_ids 过滤（输出数量更完整）。")
    else:
        seen_ids = collect_seen_ids(archive_root, TODAY_STR, active_tags=active_carryover_tags)
    log_substep("5.3", "加载 carryover 并构建候选集", "START")
    try:
        carryover_items, _delta = load_recent_carryover(
            CARRYOVER_PATH,
            today_date,
            carryover_days,
            active_tags=active_carryover_tags,
        )
        if args.carryover_only:
            candidates = []
            for item in carryover_items:
                pid = str(item.get("id") or item.get("paper_id") or "").strip()
                if float(item.get("llm_score", 0)) < CARRYOVER_MIN_SCORE:
                    continue
                if not pid:
                    continue
                copied = dict(item)
                copied["id"] = pid
                copied["_source"] = "carryover"
                copied["selection_source"] = SOURCE_CARRYOVER_CACHE
                candidates.append(copied)
        else:
            candidates = build_candidates(scored_papers, carryover_items, seen_ids)
    finally:
        log_substep("5.3", "加载 carryover 并构建候选集", "END")

    if not candidates:
        log("[INFO] 没有候选论文（新论文=0 且 carryover=0），将写入空推荐结果并更新 carryover。")
        os.makedirs(output_dir, exist_ok=True)
        for mode in modes:
            output_path = os.path.join(output_dir, core_artifacts.paper_artifact_filename(TODAY_STR, mode))
            empty = {
                "mode": mode,
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "stats": {
                    "mode": mode,
                    "tag_count": tag_count,
                    "deep_divecandidates": 0,
                    "deep_cap": None,
                    "deep_selected": 0,
                    "quick_candidates": 0,
                    "quick_skim_target": int((MODES.get(mode) or {}).get("quick_base") or 0) + tag_count,
                    "quick_selected": 0,
                    "profile_daily_limits": profile_daily_limits,
                    "profile_recommend_mix": profile_recommend_mix,
                },
                "papers": [],
                "deep_dive": [],
                "quick_skim": [],
            }
            save_json(empty, output_path)

        carryover_payload = build_carryover_payload(
            load_carryover_payload(CARRYOVER_PATH),
            [],
            active_tags=active_carryover_tags,
            carryover_days=carryover_days,
            updated_date=TODAY_STR,
        )
        save_json(carryover_payload, CARRYOVER_PATH)
        group_end()
        return

    recommended_ids: set = set()

    log_substep("5.4", "按模式生成推荐结果", "START")
    for mode in modes:
        cfg = MODES.get(mode) or {}
        if args.all_quick_min_score is not None:
            result = process_mode_all_quick_min_score(
                candidates=candidates,
                mode=mode,
                min_score=float(args.all_quick_min_score),
                profile_daily_limits=profile_daily_limits,
                profile_recommend_mix=profile_recommend_mix,
            )
        else:
            result = process_mode(
                candidates,
                tag_count,
                mode,
                cfg,
                carryover_ratio=CARRYOVER_RATIO,
                profile_daily_limits=profile_daily_limits,
                profile_recommend_mix=profile_recommend_mix,
            )
            if args.all_quick:
                result = force_all_into_quick(result)
        output_path = os.path.join(output_dir, core_artifacts.paper_artifact_filename(TODAY_STR, mode))
        stats = result.get("stats") or {}
        log(f"[STATS] {json.dumps(stats, ensure_ascii=False)}")
        validate_recommend_payload(result, output_path=output_path)
        save_json(result, output_path)
        log(
            f"[INFO] mode={mode} deep={stats.get('deep_selected')} quick={stats.get('quick_selected')} "
            f"cap={stats.get('deep_cap')} target={stats.get('quick_skim_target')}"
        )

        for section_key in ("deep_dive", "quick_skim"):
            for item in result.get(section_key) or []:
                dedup_key = paper_dedup_key(item)
                if dedup_key:
                    recommended_ids.add(dedup_key)
    log_substep("5.4", "按模式生成推荐结果", "END")

    log_substep("5.5", "写入 carryover 状态", "START")
    if args.preserve_carryover:
        log("[INFO] preserve-carryover=true：跳过写入 carryover.json")
    else:
        carryover_out = build_carryover_out(candidates, recommended_ids, carryover_days)
        carryover_payload = build_carryover_payload(
            load_carryover_payload(CARRYOVER_PATH),
            carryover_out,
            active_tags=active_carryover_tags,
            carryover_days=carryover_days,
            updated_date=TODAY_STR,
        )
        save_json(carryover_payload, CARRYOVER_PATH)
    log_substep("5.5", "写入 carryover 状态", "END")

    group_end()


if __name__ == "__main__":
    main()
