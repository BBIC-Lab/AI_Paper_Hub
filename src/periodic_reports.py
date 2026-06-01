#!/usr/bin/env python
from __future__ import annotations

import argparse
import calendar
import hashlib
import html
import json
import math
import os
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    import yaml  # type: ignore
except Exception:  # pragma: no cover
    yaml = None

try:
    from llm import LLMClient  # type: ignore
except Exception:  # pragma: no cover
    LLMClient = None  # type: ignore

BEIJING_TZ = timezone(timedelta(hours=8))
ROOT_DIR = Path(__file__).resolve().parents[1]
CONFIG_FILE = ROOT_DIR / "config.yaml"
DEFAULT_DOCS_DIR = ROOT_DIR / "docs"
DEFAULT_MAX_TOPICS = 10
DEFAULT_REPRESENTATIVE_PAPERS = 12
DEFAULT_MAX_CANDIDATES = 240
SUPPORTED_INPUT_MODES = {"artifacts", "recrawl", "hybrid"}
SUPPORTED_PERIODS = {"weekly", "monthly"}
REPORT_RENDER_VERSION = "periodic-weekly-v4"
FOCUS_TAG_KINDS = {"query", "profile", "intent", "reader", "research", "subscription"}
WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五"]
RADAR_AXES = [
    ("智能体/推理", "agent_reasoning"),
    ("数据/评测", "data_eval"),
    ("系统/效率", "systems_efficiency"),
    ("科学/机器人", "science_robotics"),
    ("安全/HCI", "safety_hci"),
]
CS_TAXONOMY_SEEDS = [
    ("LLM Agents", "agent_reasoning", ["agent", "multi-agent", "tool use", "tool-using", "planning", "memory", "autonomous"]),
    ("Reasoning", "agent_reasoning", ["reasoning", "chain-of-thought", "theorem", "formal", "logic", "search"]),
    ("RAG / Retrieval", "data_eval", ["retrieval", "rag", "search", "ranking", "indexing", "knowledge graph"]),
    ("Evaluation / Benchmark", "data_eval", ["benchmark", "evaluation", "eval", "metric", "leaderboard", "dataset"]),
    ("Vision / Multimodal", "data_eval", ["vision", "multimodal", "image", "video", "vlm", "visual"]),
    ("NLP / Language", "agent_reasoning", ["language model", "nlp", "translation", "dialogue", "text generation"]),
    ("Systems / Efficiency", "systems_efficiency", ["systems", "serving", "inference", "latency", "throughput", "distributed", "compiler"]),
    ("Efficient Models", "systems_efficiency", ["efficient", "compression", "quantization", "distillation", "edge", "small model"]),
    ("Robotics", "science_robotics", ["robot", "robotics", "manipulation", "policy", "control", "embodied"]),
    ("Scientific AI", "science_robotics", ["scientific", "science", "biology", "chemistry", "medicine", "biomedical", "hypothesis", "simulation", "laboratory"]),
    ("Causality / World Models", "science_robotics", ["causal", "causality", "world model", "simulation", "dynamics"]),
    ("Safety / Alignment", "safety_hci", ["safety", "alignment", "trustworthy", "risk", "guardrail", "red team", "privacy"]),
    ("HCI / Human-AI", "safety_hci", ["human-ai", "hci", "interactive", "user study", "collaboration", "interface"]),
    ("Security", "safety_hci", ["security", "attack", "adversarial", "vulnerability", "jailbreak"]),
]
WORD_STOPWORDS = {
    "about", "after", "again", "against", "also", "among", "based", "between", "could", "from",
    "have", "into", "latest", "learning", "model", "models", "paper", "papers", "study", "that",
    "their", "these", "this", "through", "using", "with", "without", "towards", "toward", "via",
    "for", "and", "the", "of", "in", "on", "to", "a", "an", "by", "is", "are", "as", "we",
}


@dataclass(frozen=True)
class PeriodWindow:
    period: str
    key: str
    label: str
    start: date
    end: date


@dataclass
class ArtifactFile:
    path: Path
    token: str
    start: date
    end: date


def log(message: str) -> None:
    print(message, flush=True)


def beijing_today(now: datetime | None = None) -> date:
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current.astimezone(BEIJING_TZ).date()


def parse_date(value: Any) -> date:
    text = str(value or "").strip()
    if not text:
        raise ValueError("date value is empty")
    for fmt in ("%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            pass
    raise ValueError(f"unsupported date format: {value}")


def fmt_date(d: date) -> str:
    return d.strftime("%Y-%m-%d")


def resolve_period_window(
    period: str,
    start_date: str | None = None,
    end_date: str | None = None,
    now: datetime | None = None,
) -> PeriodWindow:
    safe_period = str(period or "").strip().lower()
    if safe_period not in SUPPORTED_PERIODS:
        raise ValueError(f"unsupported period: {period}")

    if start_date and end_date:
        start = parse_date(start_date)
        end = parse_date(end_date)
        if end < start:
            raise ValueError("end-date must not be earlier than start-date")
    else:
        today = beijing_today(now)
        if safe_period == "weekly":
            start = today - timedelta(days=today.weekday())
            end = start + timedelta(days=6)
        else:
            start = today.replace(day=1)
            last_day = calendar.monthrange(today.year, today.month)[1]
            end = today.replace(day=last_day)

    if safe_period == "weekly":
        iso = start.isocalendar()
        key = f"{iso.year}-W{iso.week:02d}"
        label = f"周报 · {fmt_date(start)} ~ {fmt_date(end)}"
    else:
        key = f"{start.year:04d}-{start.month:02d}"
        label = f"月报 · {key}"
    return PeriodWindow(safe_period, key, label, start, end)


def parse_archive_token(token: str) -> tuple[date, date] | None:
    text = str(token or "").strip()
    if re.fullmatch(r"\d{8}", text):
        d = parse_date(text)
        return d, d
    m = re.fullmatch(r"(\d{8})-(\d{8})", text)
    if m:
        start = parse_date(m.group(1))
        end = parse_date(m.group(2))
        if end < start:
            start, end = end, start
        return start, end
    return None


def ranges_overlap(a_start: date, a_end: date, b_start: date, b_end: date) -> bool:
    return a_start <= b_end and b_start <= a_end


def normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def has_cjk(text: str) -> bool:
    return bool(re.search(r"[\u3400-\u9fff]", text or ""))


def looks_like_broken_cjk(text: str) -> bool:
    value = normalize_text(text)
    return bool(value) and not has_cjk(value) and value.count("?") >= max(2, len(value) // 3)


def clean_title_zh(value: Any) -> str:
    text = normalize_text(value)
    if looks_like_broken_cjk(text):
        return ""
    return text


def first_clean_title_zh(*values: Any) -> str:
    for value in values:
        text = clean_title_zh(value)
        if text:
            return text
    return ""


def short_text(value: Any, limit: int = 220) -> str:
    text = normalize_text(value)
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "..."


def load_yaml_config(path: Path = CONFIG_FILE) -> dict[str, Any]:
    if not path.exists() or yaml is None:
        return {}
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8-sig"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def default_periodic_config() -> dict[str, Any]:
    return {
        "enabled": True,
        "default_input_mode": "artifacts",
        "language": "zh-CN",
        "max_candidates": DEFAULT_MAX_CANDIDATES,
        "max_topics": DEFAULT_MAX_TOPICS,
        "representative_papers": DEFAULT_REPRESENTATIVE_PAPERS,
        "weekly": {
            "enabled": True,
            "schedule": "30 23 * * 5",
            "input_mode": "artifacts",
            "recrawl_days": 10,
        },
        "monthly": {
            "enabled": True,
            "schedule": "30 23 1 * *",
            "input_mode": "artifacts",
            "recrawl_days": 30,
        },
        "charts": {
            "topics": True,
            "sources": True,
            "score_distribution": True,
            "timeline": True,
            "topic_timeline": True,
        },
        "topic_aliases": {},
        "include_low_score_novelty": False,
    }


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = json.loads(json.dumps(base, ensure_ascii=False))
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def resolve_periodic_config(config: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = config if isinstance(config, dict) else load_yaml_config()
    raw = cfg.get("periodic_reports") if isinstance(cfg, dict) else {}
    return deep_merge(default_periodic_config(), raw if isinstance(raw, dict) else {})


def positive_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)
        return parsed if parsed > 0 else fallback
    except Exception:
        return fallback


def normalize_input_mode(value: Any, fallback: str = "artifacts") -> str:
    mode = str(value or "").strip().lower()
    return mode if mode in SUPPORTED_INPUT_MODES else fallback


def discover_recommend_files(root: Path, window: PeriodWindow) -> list[ArtifactFile]:
    archive_root = root / "archive"
    if not archive_root.exists():
        return []
    out: list[ArtifactFile] = []
    for path in sorted(archive_root.glob("*/recommend/*.json")):
        token = path.parents[1].name
        parsed = parse_archive_token(token)
        if not parsed:
            continue
        start, end = parsed
        if ranges_overlap(start, end, window.start, window.end):
            out.append(ArtifactFile(path=path, token=token, start=start, end=end))
    return out


def normalize_arxiv_id(value: Any) -> str:
    text = normalize_text(value).lower()
    if not text:
        return ""
    if text.startswith("arxiv:"):
        text = text.split(":", 1)[1].strip()
    if text.startswith("http://") or text.startswith("https://"):
        text = text.split("?", 1)[0].split("#", 1)[0].rstrip("/")
        if "/abs/" in text:
            text = text.rsplit("/abs/", 1)[-1]
        elif "/pdf/" in text:
            text = text.rsplit("/pdf/", 1)[-1]
        else:
            text = text.rsplit("/", 1)[-1]
    if text.endswith(".pdf"):
        text = text[:-4]
    m = re.match(r"^(\d{4}\.\d{4,5})(?:v\d+)?$", text)
    if m:
        return m.group(1)
    return text


def normalize_title_key(value: Any) -> str:
    text = normalize_text(value).lower()
    text = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_doi(value: Any) -> str:
    text = normalize_text(value).lower()
    text = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", text)
    return text.strip()


def source_id_from_item(item: dict[str, Any]) -> str:
    for key in ("source_id", "source_paper_id", "paper_id", "id"):
        value = normalize_text(item.get(key))
        if value:
            return value
    return ""


def extract_year(value: Any) -> str:
    m = re.search(r"(19|20)\d{2}", str(value or ""))
    return m.group(0) if m else ""


def dedupe_key(item: dict[str, Any]) -> str:
    doi = normalize_doi(item.get("doi") or item.get("DOI"))
    if doi:
        return f"doi:{doi}"
    arxiv = normalize_arxiv_id(item.get("arxiv_id") or item.get("id") or item.get("paper_id") or item.get("link") or item.get("pdf_url"))
    if re.match(r"^\d{4}\.\d{4,5}$", arxiv):
        return f"arxiv:{arxiv}"
    source = normalize_text(item.get("source") or "").lower()
    sid = source_id_from_item(item)
    if source and sid:
        return f"source:{source}:{normalize_text(sid).lower()}"
    title = normalize_title_key(item.get("title") or item.get("title_en"))
    year = extract_year(item.get("published") or item.get("date"))
    if title:
        return f"title:{year}:{title}" if year else f"title:{title}"
    payload = json.dumps(item, sort_keys=True, ensure_ascii=False)
    return f"unknown:{hashlib.sha1(payload.encode('utf-8')).hexdigest()}"


def score_value(value: Any) -> float:
    try:
        return float(value)
    except Exception:
        m = re.search(r"\d+(?:\.\d+)?", str(value or ""))
        return float(m.group(0)) if m else 0.0


def parse_tag_text(value: Any) -> list[dict[str, str]]:
    tags: list[dict[str, str]] = []
    if isinstance(value, str):
        parts = [p.strip() for p in re.split(r",|，|;|；", value) if p.strip()]
    elif isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict):
                label = normalize_text(item.get("label") or item.get("name") or item.get("tag"))
                kind = normalize_text(item.get("kind") or item.get("type") or "paper") or "paper"
                if label:
                    tags.append({"kind": kind, "label": label})
                continue
            parts.append(normalize_text(item))
    else:
        parts = []
    for part in parts:
        if not part:
            continue
        if ":" in part:
            kind, label = part.split(":", 1)
            kind = normalize_text(kind) or "paper"
            label = normalize_text(label)
        else:
            kind, label = "paper", normalize_text(part)
        if label and kind != "score":
            tags.append({"kind": kind, "label": label})
    return tags


def apply_topic_alias(label: str, aliases: dict[str, Any]) -> str:
    raw = normalize_text(label)
    if not raw:
        return ""
    folded = raw.casefold()
    for target, values in (aliases or {}).items():
        candidates = values if isinstance(values, list) else [values]
        if folded == str(target).casefold() or folded in {str(v).casefold() for v in candidates}:
            return normalize_text(target) or raw
    return raw


def collect_item_tags(item: dict[str, Any], meta: dict[str, Any] | None, aliases: dict[str, Any]) -> list[dict[str, str]]:
    tags: list[dict[str, str]] = []
    if meta:
        tags.extend(parse_tag_text(meta.get("tags")))
    for key in ("tags", "llm_tags", "keywords", "topic_tags"):
        tags.extend(parse_tag_text(item.get(key)))
    selection = normalize_text(item.get("selection_source") or (meta or {}).get("selection_source"))
    if selection and ":" in selection:
        tags.extend(parse_tag_text(selection))
    if not tags:
        cat = normalize_text(item.get("primary_category") or item.get("category"))
        if cat:
            tags.append({"kind": "paper", "label": cat})
    cleaned: list[dict[str, str]] = []
    seen = set()
    for tag in tags:
        kind = normalize_text(tag.get("kind") or "paper") or "paper"
        label = apply_topic_alias(tag.get("label") or "", aliases)
        if not label:
            continue
        key = (kind.casefold(), label.casefold())
        if key in seen:
            continue
        seen.add(key)
        cleaned.append({"kind": kind, "label": label})
    return cleaned


def meta_index_keys(meta: dict[str, Any]) -> list[str]:
    keys = []
    for value in (meta.get("paper_id"), meta.get("id"), meta.get("arxiv_id"), meta.get("pdf")):
        text = normalize_text(value)
        if text:
            keys.append(text)
        arxiv = normalize_arxiv_id(text)
        if arxiv:
            keys.append(arxiv)
            if re.match(r"^\d{4}\.\d{4,5}$", arxiv):
                keys.append(f"arxiv:{arxiv}")
    title = normalize_title_key(meta.get("title_en") or meta.get("title"))
    if title:
        keys.append(f"title:{title}")
    return list(dict.fromkeys(keys))


def load_meta_indexes(docs_dir: Path) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    if not docs_dir.exists():
        return index
    for path in docs_dir.rglob("papers.meta.json"):
        if "reports" in path.parts:
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        for meta in payload.get("papers") or []:
            if not isinstance(meta, dict):
                continue
            for key in meta_index_keys(meta):
                index.setdefault(key, meta)
    return index


def find_meta(item: dict[str, Any], meta_index: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    candidates = []
    for value in (item.get("id"), item.get("paper_id"), item.get("arxiv_id"), item.get("link"), item.get("pdf_url")):
        text = normalize_text(value)
        if text:
            candidates.append(text)
        arxiv = normalize_arxiv_id(text)
        if arxiv:
            candidates.extend([arxiv, f"arxiv:{arxiv}"])
    title = normalize_title_key(item.get("title"))
    if title:
        candidates.append(f"title:{title}")
    for key in candidates:
        if key in meta_index:
            return meta_index[key]
    return None


def docsify_href_from_meta(meta: dict[str, Any] | None) -> str:
    if not meta:
        return ""
    pid = normalize_text(meta.get("paper_id"))
    if pid:
        return f"#/{pid.strip('/')}"
    return ""


def external_href(item: dict[str, Any], meta: dict[str, Any] | None = None) -> str:
    for key in ("link", "canonical_url", "url", "pdf_url"):
        value = normalize_text(item.get(key))
        if value:
            return value
    if meta:
        value = normalize_text(meta.get("pdf"))
        if value:
            return value
    arxiv = normalize_arxiv_id(item.get("id") or item.get("paper_id"))
    if re.match(r"^\d{4}\.\d{4,5}$", arxiv):
        return f"https://arxiv.org/abs/{arxiv}"
    return ""


def normalize_source(item: dict[str, Any], meta: dict[str, Any] | None) -> str:
    source = normalize_text(item.get("source") or (meta or {}).get("source"))
    if source:
        return source.lower()
    arxiv = normalize_arxiv_id(item.get("id") or item.get("paper_id") or item.get("link"))
    return "arxiv" if re.match(r"^\d{4}\.\d{4,5}$", arxiv) else "unknown"


def build_paper_record(
    item: dict[str, Any],
    section: str,
    artifact: ArtifactFile,
    meta_index: dict[str, dict[str, Any]],
    aliases: dict[str, Any],
    root: Path = ROOT_DIR,
) -> dict[str, Any]:
    meta = find_meta(item, meta_index)
    paper_id = normalize_text(item.get("id") or item.get("paper_id") or (meta or {}).get("paper_id"))
    title = normalize_text(item.get("title") or item.get("title_en") or (meta or {}).get("title_en"))
    title_zh = first_clean_title_zh(
        item.get("title_zh"),
        item.get("zh_title"),
        item.get("title_cn"),
        (meta or {}).get("title_zh"),
        (meta or {}).get("zh_title"),
        (meta or {}).get("title_cn"),
    )
    score = score_value(item.get("llm_score") if item.get("llm_score") is not None else (meta or {}).get("score"))
    published = normalize_text(item.get("published") or item.get("date") or (meta or {}).get("date"))
    evidence = normalize_text(item.get("evidence") or item.get("reason") or item.get("recommend_reason") or (meta or {}).get("evidence"))
    tldr = normalize_text(item.get("tldr") or item.get("summary") or (meta or {}).get("tldr"))
    abstract = normalize_text(item.get("abstract") or (meta or {}).get("abstract_en"))
    source = normalize_source(item, meta)
    try:
        artifact_path = str(artifact.path.relative_to(root))
    except Exception:
        artifact_path = str(artifact.path)
    return {
        "paper_id": paper_id,
        "title": title or paper_id or "Untitled paper",
        "title_zh": title_zh,
        "section": section,
        "score": score,
        "source": source,
        "source_id": source_id_from_item(item),
        "doi": normalize_doi(item.get("doi") or item.get("DOI")),
        "published": published,
        "date": fmt_date(artifact.end),
        "artifact_token": artifact.token,
        "artifact_path": artifact_path,
        "href": docsify_href_from_meta(meta),
        "external_url": external_href(item, meta),
        "tags": collect_item_tags(item, meta, aliases),
        "evidence": evidence,
        "tldr": tldr,
        "abstract": short_text(abstract, 360),
        "dedupe_key": dedupe_key({**item, "title": title, "date": published, "source": source}),
        "selection_source": normalize_text(item.get("selection_source") or (meta or {}).get("selection_source")),
        "carryover": normalize_text(item.get("_source")).lower() == "carryover",
    }


def load_recommend_payload(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        return data if isinstance(data, dict) else {}
    except Exception as exc:
        log(f"[WARN] failed to read {path}: {exc}")
        return {}


def prefer_record(candidate: dict[str, Any], existing: dict[str, Any]) -> bool:
    if candidate.get("section") == "deep" and existing.get("section") != "deep":
        return True
    if candidate.get("section") != "deep" and existing.get("section") == "deep":
        return False
    if float(candidate.get("score") or 0) != float(existing.get("score") or 0):
        return float(candidate.get("score") or 0) > float(existing.get("score") or 0)
    return normalize_text(candidate.get("date")) > normalize_text(existing.get("date"))


def collect_papers(
    root: Path,
    docs_dir: Path,
    window: PeriodWindow,
    max_candidates: int,
    aliases: dict[str, Any] | None = None,
    profile_tag: str = "",
) -> tuple[list[dict[str, Any]], list[ArtifactFile], dict[str, int]]:
    artifacts = discover_recommend_files(root, window)
    meta_index = load_meta_indexes(docs_dir)
    profile_filter = normalize_text(profile_tag).casefold()
    raw_records: list[dict[str, Any]] = []
    for artifact in artifacts:
        payload = load_recommend_payload(artifact.path)
        for section, key in (("deep", "deep_dive"), ("quick", "quick_skim")):
            for item in payload.get(key) or []:
                if not isinstance(item, dict):
                    continue
                if profile_filter:
                    tag_text = " ".join(str(v or "") for v in [item.get("selection_source"), item.get("paper_tag"), item.get("tag")]).casefold()
                    tag_text += " " + " ".join(tag.get("label", "").casefold() for tag in collect_item_tags(item, None, aliases or {}))
                    if profile_filter not in tag_text:
                        continue
                raw_records.append(build_paper_record(item, section, artifact, meta_index, aliases or {}, root=root))

    by_key: dict[str, dict[str, Any]] = {}
    duplicate_count = 0
    for record in raw_records:
        key = record.get("dedupe_key") or ""
        existing = by_key.get(key)
        if existing is None:
            by_key[key] = record
            continue
        duplicate_count += 1
        if prefer_record(record, existing):
            merged_dates = sorted(set((existing.get("all_dates") or [existing.get("date")]) + [record.get("date")]))
            record["all_dates"] = [d for d in merged_dates if d]
            by_key[key] = record
        else:
            dates = sorted(set((existing.get("all_dates") or [existing.get("date")]) + [record.get("date")]))
            existing["all_dates"] = [d for d in dates if d]
    papers = sorted(by_key.values(), key=lambda p: (-float(p.get("score") or 0), p.get("title") or ""))
    if max_candidates > 0:
        papers = papers[:max_candidates]
    stats = {"raw_records": len(raw_records), "duplicates_removed": duplicate_count}
    return papers, artifacts, stats


def counter_to_items(counter: Counter, limit: int) -> list[dict[str, Any]]:
    items = sorted(counter.items(), key=lambda kv: (-kv[1], str(kv[0]).casefold()))
    top = items[:limit]
    other = sum(v for _, v in items[limit:])
    out = [{"label": str(k), "count": int(v)} for k, v in top]
    if other:
        out.append({"label": "Other", "count": int(other)})
    return out


def counter_to_ranked_items(counter: Counter, limit: int) -> list[dict[str, Any]]:
    items = sorted(counter.items(), key=lambda kv: (-kv[1], str(kv[0]).casefold()))
    return [{"label": str(k), "count": int(v)} for k, v in items[:limit] if v > 0]


def paper_text_blob(paper: dict[str, Any]) -> str:
    parts = [
        paper.get("title"),
        paper.get("title_zh"),
        paper.get("abstract"),
        paper.get("evidence"),
        paper.get("tldr"),
        paper.get("selection_source"),
    ]
    parts.extend(tag.get("label") for tag in (paper.get("tags") or []) if isinstance(tag, dict))
    return " ".join(normalize_text(part) for part in parts if normalize_text(part))


def infer_taxonomy_topics(paper: dict[str, Any]) -> list[tuple[str, str]]:
    text = paper_text_blob(paper).casefold()
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for label, axis, keywords in CS_TAXONOMY_SEEDS:
        if any(keyword.casefold() in text for keyword in keywords):
            key = label.casefold()
            if key not in seen:
                seen.add(key)
                out.append((label, axis))
    return out


def paper_weekly_topics(paper: dict[str, Any], aliases: dict[str, Any] | None = None) -> tuple[list[str], list[str], list[str]]:
    focus: list[str] = []
    context: list[str] = []
    axes: list[str] = []
    for tag in paper.get("tags") or []:
        if not isinstance(tag, dict):
            continue
        label = apply_topic_alias(tag.get("label") or "", aliases or {})
        if not label:
            continue
        kind = normalize_text(tag.get("kind") or "paper").casefold()
        if kind in FOCUS_TAG_KINDS:
            focus.append(label)
        else:
            context.append(label)
    for label, axis in infer_taxonomy_topics(paper):
        context.append(apply_topic_alias(label, aliases or {}))
        axes.append(axis)
    focus = list(dict.fromkeys(focus))
    context = list(dict.fromkeys(label for label in context if label and label not in focus))
    axes = list(dict.fromkeys(axes))
    return focus, context, axes


def word_cloud_items(papers: list[dict[str, Any]], limit: int = 36) -> list[dict[str, Any]]:
    counter: Counter = Counter()
    for paper in papers:
        focus, context, _axes = paper_weekly_topics(paper)
        for label in focus + context:
            counter[label] += 2
        text = paper_text_blob(paper)
        for token in re.findall(r"[A-Za-z][A-Za-z0-9+./-]{2,}", text):
            word = token.strip("-_.").casefold()
            if len(word) < 3 or word in WORD_STOPWORDS or word.isdigit():
                continue
            counter[word] += 1
    max_count = max(counter.values() or [1])
    out = []
    for label, count in sorted(counter.items(), key=lambda kv: (-kv[1], str(kv[0]).casefold()))[:limit]:
        out.append({"label": str(label), "count": int(count), "weight": round(0.72 + count / max_count * 1.28, 2)})
    return out


def build_weekday_topic_timeline(
    papers: list[dict[str, Any]],
    window: PeriodWindow,
    topic_labels: list[str],
    aliases: dict[str, Any] | None = None,
    topic_kinds: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    workdays: list[date] = []
    cur = window.start
    while cur <= window.end and len(workdays) < 5:
        if cur.weekday() < 5:
            workdays.append(cur)
        cur += timedelta(days=1)
    if not workdays:
        return []
    counts: dict[str, Counter] = {fmt_date(day): Counter() for day in workdays}
    for paper in papers:
        day = normalize_text(paper.get("date"))
        if day not in counts:
            continue
        focus, context, _axes = paper_weekly_topics(paper, aliases)
        for label in set(focus + context):
            counts[day][label] += 1
    rows = []
    for label in topic_labels[:12]:
        rows.append(
            {
                "topic": label,
                "kind": (topic_kinds or {}).get(label, "focus"),
                "points": [
                    {
                        "date": fmt_date(day),
                        "weekday": WEEKDAY_LABELS[day.weekday()],
                        "count": int(counts[fmt_date(day)].get(label, 0)),
                    }
                    for day in workdays
                ],
            }
        )
    return rows


def blank_weekday_topic_points(window: PeriodWindow) -> list[dict[str, Any]]:
    points: list[dict[str, Any]] = []
    cur = window.start
    while cur <= window.end and len(points) < 5:
        if cur.weekday() < 5:
            points.append({"date": fmt_date(cur), "weekday": WEEKDAY_LABELS[cur.weekday()], "count": 0})
        cur += timedelta(days=1)
    return points


def complete_weekday_topic_timeline(
    rows: list[dict[str, Any]],
    focus_topics: list[dict[str, Any]],
    context_topics: list[dict[str, Any]],
    window: PeriodWindow,
) -> list[dict[str, Any]]:
    """Backfill older cached weekly metrics so all ranked topics can render."""
    existing: dict[str, dict[str, Any]] = {}
    for row in rows:
        label = normalize_text(row.get("topic"))
        if label and label not in existing:
            existing[label] = row

    ordered_labels: list[str] = []
    topic_kinds: dict[str, str] = {}
    for kind, items in (("focus", focus_topics), ("context", context_topics)):
        for item in items:
            label = normalize_text(item.get("label") if isinstance(item, dict) else item)
            if not label:
                continue
            topic_kinds.setdefault(label, kind)
            if label not in ordered_labels:
                ordered_labels.append(label)
    for row in rows:
        label = normalize_text(row.get("topic"))
        if label and label not in ordered_labels:
            topic_kinds.setdefault(label, "context" if row.get("kind") == "context" else "focus")
            ordered_labels.append(label)

    template = blank_weekday_topic_points(window)
    completed: list[dict[str, Any]] = []
    for label in ordered_labels[:12]:
        source = existing.get(label) or {}
        counts_by_date = {
            normalize_text(point.get("date")): int(point.get("count") or 0)
            for point in (source.get("points") or [])
        }
        points = [dict(point, count=counts_by_date.get(point["date"], 0)) for point in template]
        completed.append(
            {
                "topic": label,
                "kind": source.get("kind") or topic_kinds.get(label, "focus"),
                "points": points,
            }
        )
    return completed


def build_weekly_chart_data(
    papers: list[dict[str, Any]],
    window: PeriodWindow,
    max_topics: int,
    aliases: dict[str, Any] | None = None,
) -> dict[str, Any]:
    focus_counter: Counter = Counter()
    context_counter: Counter = Counter()
    axis_counter: Counter = Counter()
    pair_counter: Counter = Counter()

    for paper in papers:
        focus, context, axes = paper_weekly_topics(paper, aliases)
        for label in focus:
            focus_counter[label] += 1
        for label in context:
            context_counter[label] += 1
        for axis in axes:
            axis_counter[axis] += 1
        labels = list(dict.fromkeys((focus + context)[:8]))
        for i, left in enumerate(labels):
            for right in labels[i + 1:]:
                pair_counter[tuple(sorted((left, right)))] += 1

    if not focus_counter and context_counter:
        for label, count in context_counter.most_common(min(3, max_topics)):
            focus_counter[label] += count
            context_counter.pop(label, None)

    focus_topics = counter_to_ranked_items(focus_counter, max_topics)
    context_topics = counter_to_ranked_items(context_counter, max_topics)
    focus_labels = [item["label"] for item in focus_topics]
    context_labels = [item["label"] for item in context_topics if item["label"] not in set(focus_labels)]
    topic_labels = (focus_labels + context_labels)[:12]
    topic_kinds = {item["label"]: "focus" for item in focus_topics}
    topic_kinds.update({item["label"]: "context" for item in context_topics if item["label"] not in topic_kinds})
    radar = []
    max_axis = max(axis_counter.values() or [1])
    for label, key in RADAR_AXES:
        count = int(axis_counter.get(key, 0))
        radar.append({"label": label, "key": key, "count": count, "score": round(count / max_axis, 3) if max_axis else 0})
    cooccurrence = [
        {"source": left, "target": right, "count": int(count)}
        for (left, right), count in sorted(pair_counter.items(), key=lambda kv: (-kv[1], kv[0]))[:14]
    ]
    return {
        "focus_topics": focus_topics,
        "context_topics": context_topics,
        "weekday_topic_timeline": build_weekday_topic_timeline(papers, window, topic_labels, aliases, topic_kinds),
        "word_cloud": word_cloud_items(papers),
        "radar": radar,
        "cooccurrence": cooccurrence,
        "topic_breadth": len(set(focus_counter) | set(context_counter)),
    }


def score_bucket(score: float) -> str:
    if score >= 9:
        return "9.0+"
    if score >= 8:
        return "8.0-8.9"
    if score >= 7:
        return "7.0-7.9"
    if score >= 6:
        return "6.0-6.9"
    return "<6.0"


def build_metrics(
    papers: list[dict[str, Any]],
    artifacts: list[ArtifactFile],
    window: PeriodWindow,
    max_topics: int,
    duplicate_stats: dict[str, int] | None = None,
    aliases: dict[str, Any] | None = None,
) -> dict[str, Any]:
    topic_counter: Counter = Counter()
    source_counter: Counter = Counter()
    section_counter: Counter = Counter()
    score_counter: Counter = Counter()
    date_counter: Counter = Counter()
    topic_by_time: dict[str, Counter] = defaultdict(Counter)

    for paper in papers:
        source_counter[paper.get("source") or "unknown"] += 1
        section_counter[paper.get("section") or "unknown"] += 1
        score_counter[score_bucket(float(paper.get("score") or 0))] += 1
        d = normalize_text(paper.get("date")) or "unknown"
        date_counter[d] += 1
        for tag in paper.get("tags") or []:
            label = normalize_text(tag.get("label"))
            if not label:
                continue
            topic_counter[label] += 1
            topic_by_time[d][label] += 1

    top_topics = counter_to_items(topic_counter, max_topics)
    topic_labels = [item["label"] for item in top_topics if item["label"] != "Other"][:max_topics]
    timeline = []
    cur = window.start
    while cur <= window.end:
        key = fmt_date(cur)
        timeline.append({"date": key, "count": int(date_counter.get(key, 0))})
        cur += timedelta(days=1)
    if window.period == "monthly" and len(timeline) > 18:
        week_counts: Counter = Counter()
        for item in timeline:
            d = parse_date(item["date"])
            week_counts[f"W{d.isocalendar().week:02d}"] += int(item["count"])
        timeline = [{"date": k, "count": int(v)} for k, v in sorted(week_counts.items())]

    topic_timeline = []
    for label in topic_labels[:8]:
        row = {"topic": label, "points": []}
        for point in timeline:
            bucket = point["date"]
            if bucket.startswith("W"):
                count = 0
                for d, c in topic_by_time.items():
                    try:
                        if f"W{parse_date(d).isocalendar().week:02d}" == bucket:
                            count += c.get(label, 0)
                    except Exception:
                        pass
            else:
                count = topic_by_time.get(bucket, Counter()).get(label, 0)
            row["points"].append({"date": bucket, "count": int(count)})
        topic_timeline.append(row)

    coverage = {
        "start_date": fmt_date(window.start),
        "end_date": fmt_date(window.end),
        "artifact_files": len(artifacts),
        "raw_records": int((duplicate_stats or {}).get("raw_records", len(papers))),
        "unique_papers": len(papers),
        "duplicates_removed": int((duplicate_stats or {}).get("duplicates_removed", 0)),
        "source_buckets": len(source_counter),
    }
    scores = [float(p.get("score") or 0) for p in papers]
    avg_score = round(sum(scores) / len(scores), 2) if scores else 0
    weekly_chart_data = build_weekly_chart_data(papers, window, max_topics, aliases or {}) if window.period == "weekly" else {}
    return {
        "coverage": coverage,
        "avg_score": avg_score,
        "topics": top_topics,
        "sources": counter_to_items(source_counter, 12),
        "sections": counter_to_items(section_counter, 4),
        "score_distribution": counter_to_items(score_counter, 6),
        "timeline": timeline,
        "topic_timeline": topic_timeline,
        "weekly_v2": weekly_chart_data,
    }


def build_fallback_interpretation(window: PeriodWindow, metrics: dict[str, Any], papers: list[dict[str, Any]]) -> dict[str, Any]:
    topics = metrics.get("topics") or []
    sources = metrics.get("sources") or []
    weekly_v2 = metrics.get("weekly_v2") or {}
    focus = weekly_v2.get("focus_topics") or []
    context = weekly_v2.get("context_topics") or []
    top_papers = papers[:3]
    topic_text = "、".join(str(t.get("label")) for t in topics[:3]) or "暂无明显主题"
    source_text = "、".join(str(s.get("label")) for s in sources[:3]) or "未知来源"
    focus_text = "、".join(f"{t.get('label')}（{t.get('count')}）" for t in focus[:3]) or topic_text
    context_text = "、".join(f"{t.get('label')}（{t.get('count')}）" for t in context[:3]) or "暂无明显其他主题"
    must_read = sum(1 for p in papers if float(p.get("score") or 0) >= 8.0)
    evidence_ids = [
        normalize_text(p.get("paper_id") or p.get("dedupe_key") or f"paper-{idx}")
        for idx, p in enumerate(top_papers, start=1)
    ]
    weekly_summary = (
        f"本周去重样本共 {metrics['coverage']['unique_papers']} 篇，其中 {must_read} 篇达到 8.0 分以上。"
        f"读者关注主题主要落在 {focus_text}；其他主题显示 {context_text} 也在本周样本中持续出现。"
    )
    if top_papers:
        weekly_summary += " 代表性证据包括 " + "、".join(
            f"{pid}: {short_text(paper.get('title'), 44)}"
            for pid, paper in zip(evidence_ids, top_papers)
        ) + "。"
    highlights = [
        f"本期覆盖 {metrics['coverage']['artifact_files']} 个日报 artifact，去重后得到 {metrics['coverage']['unique_papers']} 篇论文。",
        f"主题集中在 {topic_text}，来源主要包括 {source_text}。",
    ]
    if top_papers:
        evidence_refs = []
        for idx, paper in enumerate(top_papers, start=1):
            pid = normalize_text(paper.get("paper_id") or paper.get("dedupe_key") or f"paper-{idx}")
            evidence_refs.append(f"{pid}: {short_text(paper.get('title'), 42)}")
        highlights.append("最高优先级论文包括 " + "、".join(evidence_refs) + "。")
    route = [
        f"先读 Top {min(3, len(top_papers))} 高分论文，建立本期问题意识。",
        "再按主题图表展开证据列表，补齐相邻方向。",
        "最后记录需要持续跟踪的主题，作为下期检索配置的调整依据。",
    ]
    rising = [f"{item.get('label')}（{item.get('count')} 篇）" for item in topics[:5]]
    caveats = [
        "本报告只基于已生成的日报/候选 artifact，不代表全领域完整统计。",
        "趋势判断以本地统计为准，LLM 仅参与解读文本。",
    ]
    return {
        "weekly_summary": weekly_summary,
        "summary_evidence_ids": evidence_ids,
        "highlights": highlights,
        "rising_topics": rising,
        "reading_route": route,
        "caveats": caveats,
    }


def env_text(*names: str) -> str:
    for name in names:
        value = normalize_text(os.getenv(name))
        if value:
            return value
    return ""


def normalize_interpretation(data: dict[str, Any]) -> dict[str, Any]:
    out = {}
    weekly_summary = normalize_text(data.get("weekly_summary") or data.get("summary"))
    evidence_ids = data.get("summary_evidence_ids") or data.get("evidence_ids") or []
    if isinstance(evidence_ids, list):
        out["summary_evidence_ids"] = [normalize_text(v) for v in evidence_ids if normalize_text(v)][:8]
    elif normalize_text(evidence_ids):
        out["summary_evidence_ids"] = [normalize_text(evidence_ids)]
    else:
        out["summary_evidence_ids"] = []
    for key in ("highlights", "rising_topics", "reading_route", "caveats"):
        value = data.get(key)
        if isinstance(value, list):
            out[key] = [normalize_text(v) for v in value if normalize_text(v)][:6]
        elif normalize_text(value):
            out[key] = [normalize_text(value)]
        else:
            out[key] = []
    if not weekly_summary and out.get("highlights"):
        weekly_summary = " ".join(out["highlights"][:3])
    out["weekly_summary"] = weekly_summary
    return out


def try_llm_interpretation(window: PeriodWindow, metrics: dict[str, Any], papers: list[dict[str, Any]]) -> dict[str, Any] | None:
    api_key = env_text("DPR_LLM_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY")
    base_url = env_text("DPR_LLM_BASE_URL", "LLM_BASE_URL", "OPENAI_BASE_URL") or "https://api.openai.com/v1"
    model = env_text("DPR_LLM_REPORT_MODEL", "DPR_LLM_SUMMARY_MODEL", "DPR_LLM_MODEL", "LLM_MODEL")
    if not api_key or not model or LLMClient is None:
        return None
    evidence = [
        {
            "id": p.get("paper_id"),
            "title": p.get("title"),
            "score": p.get("score"),
            "source": p.get("source"),
            "topics": [t.get("label") for t in (p.get("tags") or [])[:4]],
            "evidence": short_text(p.get("evidence") or p.get("tldr") or p.get("abstract"), 180),
        }
        for p in papers[:18]
    ]
    system_prompt = "你是科研周期报告编辑。只基于给定 JSON 统计和 evidence papers 写中文洞察，不要编造未出现的论文、数量或趋势。返回 JSON。"
    user_payload = {
        "period": window.period,
        "label": window.label,
        "metrics": metrics,
        "weekly_chart_data": metrics.get("weekly_v2") or {},
        "evidence_papers": evidence,
        "schema": {
            "weekly_summary": "one concise Chinese paragraph for weekly report, grounded in topic counts and evidence paper ids",
            "summary_evidence_ids": ["paper ids cited by weekly_summary"],
            "highlights": ["2-4 concise Chinese bullets with counts or paper ids"],
            "rising_topics": ["topic trend bullets grounded in topic counts"],
            "reading_route": ["ordered reading suggestions"],
            "caveats": ["coverage and accuracy caveats"],
        },
    }
    client = LLMClient(api_key=api_key, model=model, base_url=base_url)
    client.kwargs.update({"temperature": 0.2, "max_tokens": 1200})
    try:
        response = client.chat(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
            response_format=LLMClient.build_json_object_response_format(),
        )
        content = (((response.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
        parsed = LLMClient.parse_json_content(content)
        return normalize_interpretation(parsed) if isinstance(parsed, dict) else None
    except Exception as exc:
        log(f"[WARN] LLM interpretation failed, using fallback: {exc}")
        return None


def compute_input_hash(window: PeriodWindow, input_mode: str, artifacts: list[ArtifactFile], papers: list[dict[str, Any]], config: dict[str, Any]) -> str:
    payload = {
        "period": window.__dict__,
        "renderer_version": REPORT_RENDER_VERSION,
        "input_mode": input_mode,
        "artifacts": [str(a.path) for a in artifacts],
        "papers": [
            {"key": p.get("dedupe_key"), "title": p.get("title"), "score": p.get("score"), "source": p.get("source"), "tags": p.get("tags")}
            for p in papers
        ],
        "config": config,
    }
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def pct_width(count: int, max_count: int) -> str:
    if max_count <= 0:
        return "0%"
    return f"{max(4, min(100, round(count * 100 / max_count)))}%"


def bar_chart_html(items: list[dict[str, Any]], title: str, class_name: str = "") -> str:
    max_count = max([int(item.get("count") or 0) for item in items] or [0])
    rows = []
    for item in items:
        label = html.escape(str(item.get("label") or "Unknown"))
        count = int(item.get("count") or 0)
        rows.append(
            '<div class="dpr-periodic-bar-row">'
            f'<span class="dpr-periodic-bar-label">{label}</span>'
            '<span class="dpr-periodic-bar-track">'
            f'<i style="width:{pct_width(count, max_count)}"></i>'
            "</span>"
            f"<strong>{count}</strong>"
            "</div>"
        )
    return f'<section class="dpr-periodic-chart-card {html.escape(class_name)}"><h3>{html.escape(title)}</h3>{"".join(rows) if rows else "<p>暂无数据</p>"}</section>'


def timeline_svg(points: list[dict[str, Any]], title: str) -> str:
    width = 640
    height = 160
    pad = 28
    counts = [int(p.get("count") or 0) for p in points]
    max_count = max(counts or [1]) or 1
    step = (width - pad * 2) / max(1, len(points) - 1)
    coords = []
    for idx, count in enumerate(counts):
        x = pad + idx * step
        y = height - pad - (count / max_count) * (height - pad * 2)
        coords.append((x, y, count))
    polyline = " ".join(f"{x:.1f},{y:.1f}" for x, y, _ in coords)
    circles = "".join(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="4"><title>{c}</title></circle>' for x, y, c in coords)
    labels = "".join(
        f'<text x="{x:.1f}" y="{height - 6}" text-anchor="middle">{html.escape(str(points[idx].get("date") or ""))}</text>'
        for idx, (x, _y, _c) in enumerate(coords)
        if idx == 0 or idx == len(coords) - 1 or len(coords) <= 8
    )
    return (
        '<section class="dpr-periodic-chart-card dpr-periodic-timeline-card">'
        f"<h3>{html.escape(title)}</h3>"
        f'<svg class="dpr-periodic-line-chart" viewBox="0 0 {width} {height}" role="img" aria-label="{html.escape(title)}">'
        f'<polyline points="{polyline}" />{circles}{labels}</svg></section>'
    )


def topic_timeline_html(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return '<section class="dpr-periodic-chart-card"><h3>主题演化</h3><p>暂无数据</p></section>'
    max_count = max([int(point.get("count") or 0) for row in rows for point in row.get("points", [])] or [1])
    body = []
    for row in rows[:12]:
        cells = []
        for point in row.get("points") or []:
            count = int(point.get("count") or 0)
            level = 0 if count <= 0 else max(1, min(5, round(count * 5 / max_count)))
            cells.append(f'<span class="dpr-periodic-heat-cell level-{level}" title="{html.escape(str(point.get("date")))}: {count}">{count if count else ""}</span>')
        body.append(f'<div class="dpr-periodic-heat-row"><strong>{html.escape(str(row.get("topic") or ""))}</strong><div>{"".join(cells)}</div></div>')
    return '<section class="dpr-periodic-chart-card dpr-periodic-heat-card"><h3>主题演化</h3>' + "".join(body) + "</section>"


def list_html(items: list[Any], class_name: str = "") -> str:
    if not items:
        return "<ul><li>暂无。</li></ul>"
    return f'<ul class="{html.escape(class_name)}">' + "".join(f"<li>{html.escape(str(item))}</li>" for item in items) + "</ul>"


def paper_card_html(paper: dict[str, Any], idx: int) -> str:
    title = html.escape(str(paper.get("title") or "Untitled"))
    title_zh = html.escape(str(paper.get("title_zh") or ""))
    href = html.escape(str(paper.get("href") or paper.get("external_url") or "#"), quote=True)
    source = html.escape(str(paper.get("source") or "unknown"))
    score = float(paper.get("score") or 0)
    tags = "".join(f'<span>{html.escape(str(tag.get("label") or ""))}</span>' for tag in (paper.get("tags") or [])[:4] if tag.get("label"))
    evidence = html.escape(short_text(paper.get("evidence") or paper.get("tldr") or paper.get("abstract"), 180))
    return (
        '<article class="dpr-periodic-paper-card">'
        f'<div class="dpr-periodic-paper-rank">{idx:02d}</div>'
        "<div>"
        f'<a href="{href}" class="dpr-periodic-paper-title">{title}</a>'
        f'{"<p>" + title_zh + "</p>" if title_zh else ""}'
        f'<div class="dpr-periodic-paper-meta"><span>{source}</span><span>{score:.1f}</span>{tags}</div>'
        f'{"<small>" + evidence + "</small>" if evidence else ""}'
        "</div></article>"
    )


def compact_topic_card_html(items: list[dict[str, Any]], title: str, class_name: str) -> str:
    max_count = max([int(item.get("count") or 0) for item in items] or [0])
    rows = []
    for item in items[:10]:
        label = html.escape(str(item.get("label") or "Unknown"))
        count = int(item.get("count") or 0)
        rows.append(
            '<div class="dpr-weekly-topic-row">'
            f'<span title="{label}">{label}</span>'
            f'<i style="--w:{pct_width(count, max_count)}"></i>'
            f"<b>{count}</b>"
            "</div>"
        )
    body = "".join(rows) if rows else '<p class="dpr-weekly-empty">暂无可归类主题。</p>'
    return f'<section class="dpr-weekly-bento-card dpr-weekly-topic-card {html.escape(class_name)}"><h2>{html.escape(title)}</h2>{body}</section>'


def word_cloud_html(items: list[dict[str, Any]]) -> str:
    words = layout_word_cloud(items[:40])
    if not words:
        return '<section class="dpr-weekly-bento-card dpr-weekly-word-card"><h2>词频云</h2><p class="dpr-weekly-empty">暂无词频数据。</p></section>'
    word_nodes = []
    for word in words:
        label = html.escape(word["label"])
        count = int(word["count"])
        word_nodes.append(
            f'<text x="{word["x"]:.1f}" y="{word["y"]:.1f}" '
            f'font-size="{word["font_size"]:.1f}" fill="{word["color"]}" '
            f'text-anchor="middle" dominant-baseline="middle" '
            f'class="{word["class_name"]}">{label}<title>{label}: {count}</title></text>'
        )
    return (
        '<section class="dpr-weekly-bento-card dpr-weekly-word-card"><h2>词频云</h2>'
        '<svg class="dpr-weekly-word-cloud" viewBox="0 0 900 420" role="img" aria-label="词频云">'
        f'<g transform="translate(450 210) scale(1.34) translate(-450 -210)">{"".join(word_nodes)}</g></svg></section>'
    )


def mini_word_cloud_html(items: list[dict[str, Any]]) -> str:
    words = layout_word_cloud(items[:24])[:18]
    if not words:
        return '<div class="dpr-periodic-index-mini-cloud is-empty"><span>暂无词频</span></div>'
    nodes = []
    for word in words:
        label = html.escape(word["label"])
        nodes.append(
            f'<text x="{word["x"]:.1f}" y="{word["y"]:.1f}" '
            f'font-size="{word["font_size"]:.1f}" fill="{word["color"]}" '
            f'text-anchor="middle" dominant-baseline="middle">{label}</text>'
        )
    return (
        '<svg class="dpr-periodic-index-mini-cloud" viewBox="0 0 900 420" role="img" aria-label="周报词频云">'
        f'<g transform="translate(450 210) scale(1.34) translate(-450 -210)">{"".join(nodes)}</g></svg>'
    )


MUTED_SPECTRAL_SCALE = (
    "#0e9f8f",
    "#2c9fd6",
    "#4f7edb",
    "#6fb85f",
    "#e4a12f",
    "#ef7f58",
    "#d96b86",
    "#a6a943",
    "#36b6ac",
)


def hex_to_rgb(color: str) -> tuple[int, int, int]:
    text = color.strip().lstrip("#")
    return int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16)


def rgb_to_hex(rgb: tuple[float, float, float]) -> str:
    return "#" + "".join(f"{max(0, min(255, round(channel))):02x}" for channel in rgb)


def color_for_index(index: int, total: int) -> str:
    if total <= 1:
        return MUTED_SPECTRAL_SCALE[0]
    pos = max(0.0, min(1.0, index / (total - 1))) * (len(MUTED_SPECTRAL_SCALE) - 1)
    left = int(math.floor(pos))
    right = min(len(MUTED_SPECTRAL_SCALE) - 1, left + 1)
    ratio = pos - left
    if left == right:
        return MUTED_SPECTRAL_SCALE[left]
    a = hex_to_rgb(MUTED_SPECTRAL_SCALE[left])
    b = hex_to_rgb(MUTED_SPECTRAL_SCALE[right])
    return rgb_to_hex(tuple(a[i] + (b[i] - a[i]) * ratio for i in range(3)))


def stable_color(label: str) -> str:
    return MUTED_SPECTRAL_SCALE[sum(ord(ch) for ch in label) % len(MUTED_SPECTRAL_SCALE)]


def estimated_text_width(label: str, font_size: float) -> float:
    units = 0.0
    for ch in label:
        units += 1.0 if ord(ch) > 127 else 0.58
    return max(font_size * 1.1, units * font_size)


def overlaps(rect: tuple[float, float, float, float], placed: list[tuple[float, float, float, float]], pad: float = 5.0) -> bool:
    left, top, right, bottom = rect
    for p_left, p_top, p_right, p_bottom in placed:
        if left - pad < p_right and right + pad > p_left and top - pad < p_bottom and bottom + pad > p_top:
            return True
    return False


def layout_word_cloud(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    clean = [
        {"label": normalize_text(item.get("label")), "count": int(item.get("count") or 0)}
        for item in items
        if normalize_text(item.get("label"))
    ]
    if not clean:
        return []
    clean.sort(key=lambda item: (-item["count"], item["label"].casefold()))
    max_count = max(item["count"] for item in clean) or 1
    min_count = min(item["count"] for item in clean) or 0
    width, height = 900.0, 420.0
    cx, cy = width / 2, height / 2
    placed_rects: list[tuple[float, float, float, float]] = []
    out = []
    total = min(36, len(clean))
    for idx, item in enumerate(clean[:36]):
        ratio = 1.0 if max_count == min_count else (item["count"] - min_count) / (max_count - min_count)
        font_size = 18 + ratio * 44
        if idx == 0:
            font_size = max(font_size, 60)
        label = item["label"]
        text_width = estimated_text_width(label, font_size)
        text_height = font_size * 1.12
        candidates = [(cx, cy)] if idx == 0 else []
        seed = (sum(ord(ch) for ch in label) % 29) / 29 * math.pi * 2
        for step in range(1, 340):
            angle = seed + step * 0.47
            radius = 4.9 * math.sqrt(step) * step / 5.4
            candidates.append((cx + math.cos(angle) * radius, cy + math.sin(angle) * radius * 0.68))
        chosen: tuple[float, float] | None = None
        for x, y in candidates:
            rect = (x - text_width / 2, y - text_height / 2, x + text_width / 2, y + text_height / 2)
            if rect[0] < 12 or rect[2] > width - 12 or rect[1] < 14 or rect[3] > height - 14:
                continue
            if not overlaps(rect, placed_rects, pad=2.5):
                chosen = (x, y)
                placed_rects.append(rect)
                break
        if chosen is None:
            continue
        out.append(
            {
                "label": label,
                "count": item["count"],
                "x": chosen[0],
                "y": chosen[1],
                "font_size": font_size,
                "color": color_for_index(idx, total),
                "class_name": "is-core" if idx < 5 else "is-tail",
            }
        )
    return out


def radar_svg_html(items: list[dict[str, Any]]) -> str:
    width = 260
    height = 220
    cx = 130
    cy = 102
    radius = 66
    axes = items or [{"label": label, "score": 0, "count": 0} for label, _key in RADAR_AXES]
    points = []
    grid = []
    labels = []
    for idx, item in enumerate(axes[:5]):
        angle = -math.pi / 2 + idx * (2 * math.pi / 5)
        score = max(0.0, min(1.0, float(item.get("score") or 0)))
        x = cx + math.cos(angle) * radius * score
        y = cy + math.sin(angle) * radius * score
        points.append(f"{x:.1f},{y:.1f}")
        gx = cx + math.cos(angle) * radius
        gy = cy + math.sin(angle) * radius
        grid.append(f'<line x1="{cx}" y1="{cy}" x2="{gx:.1f}" y2="{gy:.1f}" />')
        lx = cx + math.cos(angle) * (radius + 34)
        ly = cy + math.sin(angle) * (radius + 26)
        label = html.escape(str(item.get("label") or ""))
        count = int(item.get("count") or 0)
        labels.append(f'<text x="{lx:.1f}" y="{ly:.1f}" text-anchor="middle">{label}<tspan x="{lx:.1f}" dy="13">{count}</tspan></text>')
    rings = []
    for scale in (0.33, 0.66, 1):
        ring = []
        for idx in range(5):
            angle = -math.pi / 2 + idx * (2 * math.pi / 5)
            ring.append(f"{cx + math.cos(angle) * radius * scale:.1f},{cy + math.sin(angle) * radius * scale:.1f}")
        rings.append(f'<polygon points="{" ".join(ring)}" />')
    return (
        '<section class="dpr-weekly-bento-card dpr-weekly-radar-card"><h2>主题雷达</h2>'
        f'<svg class="dpr-weekly-radar" viewBox="0 0 {width} {height}" role="img" aria-label="主题雷达">'
        f'<g class="grid">{"".join(rings)}{"".join(grid)}</g>'
        f'<polygon class="area" points="{" ".join(points)}" />'
        f'<g class="labels">{"".join(labels)}</g>'
        "</svg></section>"
    )


def weekday_heatmap_html(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return '<section class="dpr-weekly-bento-card dpr-weekly-heat-card"><h2>主题演化</h2><p class="dpr-weekly-empty">暂无工作日主题数据。</p></section>'
    max_count = max([int(point.get("count") or 0) for row in rows for point in row.get("points", [])] or [1])
    header_points = (rows[0].get("points") or [])[:5]
    header = '<div class="dpr-weekly-heat-head"><span></span>' + "".join(
        f'<b title="{html.escape(str(point.get("date") or ""))}">{html.escape(str(point.get("weekday") or ""))}</b>'
        for point in header_points
    ) + "</div>"
    body = []
    for row in rows[:12]:
        cells = []
        for point in (row.get("points") or [])[:5]:
            count = int(point.get("count") or 0)
            level = 0 if count <= 0 else max(1, min(5, round(count * 5 / max_count)))
            title = f"{point.get('weekday')} {point.get('date')}: {count}"
            cells.append(f'<span class="dpr-periodic-heat-cell level-{level}" title="{html.escape(title)}">{count if count else ""}</span>')
        topic = html.escape(str(row.get("topic") or ""))
        kind = "context" if row.get("kind") == "context" else "focus"
        body.append(f'<div class="dpr-weekly-heat-row is-{kind}"><strong title="{topic}">{topic}</strong>{"".join(cells)}</div>')
    return '<section class="dpr-weekly-bento-card dpr-weekly-heat-card"><h2>主题演化</h2>' + header + "".join(body) + "</section>"



def polar_point(cx: float, cy: float, radius: float, angle: float) -> tuple[float, float]:
    return cx + math.cos(angle) * radius, cy + math.sin(angle) * radius


def arc_path(cx: float, cy: float, radius: float, start_angle: float, end_angle: float) -> str:
    start_x, start_y = polar_point(cx, cy, radius, start_angle)
    end_x, end_y = polar_point(cx, cy, radius, end_angle)
    large = 1 if end_angle - start_angle > math.pi else 0
    return f"M{start_x:.1f},{start_y:.1f} A{radius:.1f},{radius:.1f} 0 {large} 1 {end_x:.1f},{end_y:.1f}"


def cooccurrence_html(pairs: list[dict[str, Any]]) -> str:
    if not pairs:
        return '<section class="dpr-weekly-bento-card dpr-weekly-network-card"><h2>主题共现</h2><p class="dpr-weekly-empty">暂无足够共现关系。</p></section>'
    degree: Counter = Counter()
    pair_rows = []
    for pair in pairs:
        left = normalize_text(pair.get("source"))
        right = normalize_text(pair.get("target"))
        count = int(pair.get("count") or 0)
        if not left or not right or left == right or count <= 0:
            continue
        degree[left] += count
        degree[right] += count
        pair_rows.append((left, right, count))
    if not pair_rows:
        return '<section class="dpr-weekly-bento-card dpr-weekly-network-card"><h2>主题共现</h2><p class="dpr-weekly-empty">暂无足够共现关系。</p></section>'

    labels = [label for label, _count in degree.most_common(8)]
    label_set = set(labels)
    pair_rows = [(left, right, count) for left, right, count in pair_rows if left in label_set and right in label_set]
    if not pair_rows:
        return '<section class="dpr-weekly-bento-card dpr-weekly-network-card"><h2>主题共现</h2><p class="dpr-weekly-empty">暂无足够共现关系。</p></section>'

    pair_rows = sorted(pair_rows, key=lambda row: row[2], reverse=True)[:16]
    degree = Counter()
    for left, right, count in pair_rows:
        degree[left] += count
        degree[right] += count
    labels = [label for label in labels if degree[label] > 0]

    width, height = 760, 430
    cx, cy = width / 2, height / 2
    radius = 174.0
    inner_radius = 142.0
    gap = 0.095
    total_degree = sum(degree[label] for label in labels) or 1
    usable = math.tau - gap * len(labels)
    angles: dict[str, dict[str, float]] = {}
    chord_cursor: dict[str, float] = {}
    cursor = -math.pi / 2
    for label in labels:
        span = usable * degree[label] / total_degree
        start = cursor + gap / 2
        end = start + span
        angles[label] = {"start": start, "end": end, "mid": (start + end) / 2}
        chord_cursor[label] = start
        cursor = end + gap / 2

    colors = {label: color_for_index(idx, len(labels)) for idx, label in enumerate(labels)}
    arcs = []
    label_nodes = []
    for label in labels:
        angle = angles[label]
        color = colors[label]
        safe = html.escape(label)
        arcs.append(
            f'<path class="dpr-weekly-chord-arc" d="{arc_path(cx, cy, radius, angle["start"], angle["end"])}" '
            f'stroke="{color}"><title>{safe}: {int(degree[label])}</title></path>'
        )
        lx, ly = polar_point(cx, cy, radius + 48, angle["mid"])
        anchor = "start" if math.cos(angle["mid"]) > 0.18 else "end" if math.cos(angle["mid"]) < -0.18 else "middle"
        label_nodes.append(
            f'<text class="dpr-weekly-chord-label" x="{lx:.1f}" y="{ly:.1f}" text-anchor="{anchor}" fill="{color}">{safe}</text>'
        )

    max_count = max(count for _left, _right, count in pair_rows) or 1
    gradients = []
    chords = []
    legend_rows = sorted(pair_rows, key=lambda row: (-row[2], row[0].casefold(), row[1].casefold()))
    for idx, (left, right, count) in enumerate(sorted(pair_rows, key=lambda row: row[2])):
        def take_angle(label: str, value: int) -> float:
            span = angles[label]["end"] - angles[label]["start"]
            share = span * value / max(1, degree[label])
            angle = chord_cursor[label] + share / 2
            chord_cursor[label] += share
            return angle

        left_angle = take_angle(left, count)
        right_angle = take_angle(right, count)
        sx, sy = polar_point(cx, cy, inner_radius, left_angle)
        tx, ty = polar_point(cx, cy, inner_radius, right_angle)
        c1x, c1y = polar_point(cx, cy, inner_radius * 0.30, left_angle)
        c2x, c2y = polar_point(cx, cy, inner_radius * 0.30, right_angle)
        grad_id = f"dpr-weekly-chord-grad-{idx}"
        left_color = colors[left]
        right_color = colors[right]
        gradients.append(
            f'<linearGradient id="{grad_id}" gradientUnits="userSpaceOnUse" x1="{sx:.1f}" y1="{sy:.1f}" x2="{tx:.1f}" y2="{ty:.1f}">'
            f'<stop offset="0%" stop-color="{left_color}" />'
            f'<stop offset="100%" stop-color="{right_color}" />'
            '</linearGradient>'
        )
        ratio = math.sqrt(count / max_count)
        width_px = 3.5 + ratio * 10.5
        opacity = 0.20 + ratio * 0.24
        title = html.escape(f"{left} ↔ {right}: {count}")
        chords.append(
            f'<path class="dpr-weekly-chord-ribbon" d="M{sx:.1f},{sy:.1f} C{c1x:.1f},{c1y:.1f} {c2x:.1f},{c2y:.1f} {tx:.1f},{ty:.1f}" '
            f'stroke="url(#{grad_id})" stroke-width="{width_px:.1f}" stroke-opacity="{opacity:.2f}"><title>{title}</title></path>'
        )
    legend = []
    for left, right, count in legend_rows:
        left_safe = html.escape(left)
        right_safe = html.escape(right)
        label = html.escape(f"{left} ↔ {right}")
        color = colors.get(left, "#0e9f8f")
        legend.append(
            '<div class="dpr-weekly-chord-table-row">'
            f'<span title="{label}"><i style="background:{html.escape(color, quote=True)}"></i>{left_safe}<em>↔</em>{right_safe}</span>'
            f"<b>{int(count)} 篇</b>"
            "</div>"
        )

    return (
        '<section class="dpr-weekly-bento-card dpr-weekly-network-card"><h2>主题共现</h2>'
        '<div class="dpr-weekly-chord-layout">'
        '<div class="dpr-weekly-chord-figure">'
        f'<svg class="dpr-weekly-network dpr-weekly-chord" viewBox="0 0 {width} {height}" role="img" aria-label="主题共现 Chord diagram">'
        f'<defs>{"".join(gradients)}</defs>'
        f'<g class="dpr-weekly-chord-ribbons">{"".join(chords)}</g>'
        f'<g class="dpr-weekly-chord-arcs">{"".join(arcs)}</g>'
        f'<g class="dpr-weekly-chord-labels">{"".join(label_nodes)}</g>'
        '</svg></div>'
        '<div class="dpr-weekly-chord-table" aria-label="主题共现标签表">'
        f'{"".join(legend)}'
        '</div></div></section>'
    )

def evidence_row_html(paper: dict[str, Any], idx: int) -> str:
    title = html.escape(str(paper.get("title") or "Untitled"))
    title_zh = html.escape(clean_title_zh(paper.get("title_zh")))
    title_zh_html = f'<div class="dpr-weekly-evidence-title-zh">{title_zh}</div>' if title_zh else ""
    href = html.escape(str(paper.get("href") or paper.get("external_url") or "#"), quote=True)
    tags = "".join(
        f'<span>{html.escape(str(tag.get("label") or ""))}</span>'
        for tag in (paper.get("tags") or [])[:5]
        if tag.get("label")
    )
    evidence = html.escape(short_text(paper.get("evidence") or paper.get("tldr") or paper.get("abstract"), 220))
    return (
        '<article class="dpr-weekly-evidence-row">'
        f'<div class="dpr-weekly-evidence-index">{idx:02d}</div>'
        '<div class="dpr-weekly-evidence-main">'
        f'<a class="dpr-weekly-evidence-title" href="{href}" title="{title}">{title}</a>'
        f"{title_zh_html}"
        f'<div class="dpr-weekly-evidence-tags">{tags or "<span>未标注</span>"}</div>'
        f'<div class="dpr-weekly-evidence-reason"><span>推荐证据</span>{evidence or "暂无推荐证据。"}</div>'
        "</div>"
        "</article>"
    )


def weekly_adjacent_key(window: PeriodWindow, delta_weeks: int) -> str:
    anchor = window.start + timedelta(days=delta_weeks * 7)
    iso = anchor.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def weekly_report_nav_html(window: PeriodWindow) -> str:
    prev_key = weekly_adjacent_key(window, -1)
    next_key = weekly_adjacent_key(window, 1)
    return (
        '<nav class="dpr-weekly-report-nav" aria-label="周报翻页">'
        f'<a class="is-prev" href="#/reports/weekly/{html.escape(prev_key)}/README"><span class="dpr-weekly-nav-arrow is-left" aria-hidden="true">⬅</span><em>上一周报</em></a>'
        f'<a class="is-next" href="#/reports/weekly/{html.escape(next_key)}/README"><em>下一周报</em><span class="dpr-weekly-nav-arrow is-right" aria-hidden="true">➡</span></a>'
        "</nav>"
    )


def build_weekly_report_markdown(
    window: PeriodWindow,
    input_mode: str,
    metrics: dict[str, Any],
    papers: list[dict[str, Any]],
    interpretation: dict[str, Any],
    generated_at: str,
    representative_papers: int = DEFAULT_REPRESENTATIVE_PAPERS,
) -> str:
    coverage = metrics.get("coverage") or {}
    weekly = metrics.get("weekly_v2") or {}
    focus_topics = weekly.get("focus_topics") or []
    context_topics = weekly.get("context_topics") or []
    top_papers = papers[: max(1, representative_papers)]
    timeline_rows = complete_weekday_topic_timeline(
        weekly.get("weekday_topic_timeline") or [],
        focus_topics,
        context_topics,
        window,
    )
    top_focus = focus_topics[0] if focus_topics else {"label": "暂无", "count": 0}
    top_context = context_topics[0] if context_topics else {"label": "暂无", "count": 0}
    hero_chips = [
        f"样本论文 {coverage.get('unique_papers', 0)} 篇",
        f"代表论文 {len(top_papers)} 篇",
        f"主题广度 {weekly.get('topic_breadth', 0)} 类",
        f"关注 Top: {top_focus.get('label')} {top_focus.get('count')} 篇",
        f"其他 Top: {top_context.get('label')} {top_context.get('count')} 篇",
    ]
    summary = html.escape(
        normalize_text(interpretation.get("weekly_summary"))
        or "本周摘要暂未生成；请检查 LLM 配置或日报 artifact 是否包含足够证据。"
    )
    evidence_rows = "".join(evidence_row_html(paper, idx) for idx, paper in enumerate(top_papers, start=1))
    lines = [
        '<section class="dpr-periodic-report dpr-periodic-weekly dpr-periodic-weekly-v2 dpr-periodic-weekly-v3 dpr-periodic-weekly-v4">',
        '<div class="dpr-weekly-hero">',
        '<div><div class="dpr-periodic-kicker">Weekly Research Bento</div>',
        f"<h1>{html.escape(window.label)}</h1></div>",
        '<div class="dpr-weekly-hero-chip-row is-primary">',
        "".join(f"<span>{html.escape(chip)}</span>" for chip in hero_chips),
        "</div></div>",
        '<div class="dpr-weekly-bento">',
        '<section class="dpr-weekly-bento-card dpr-weekly-summary-card"><h2>本期重点</h2>',
        f"<p>{summary}</p>",
        "</section>",
        compact_topic_card_html(focus_topics, "关注主题", "focus"),
        compact_topic_card_html(context_topics, "其他主题", "context"),
        weekday_heatmap_html(timeline_rows),
        word_cloud_html(weekly.get("word_cloud") or []),
        cooccurrence_html(weekly.get("cooccurrence") or []),
        '<section class="dpr-weekly-evidence-strip is-collapsed" data-dpr-weekly-evidence>',
        '<header class="dpr-weekly-evidence-head">',
        '<div><span>代表论文证据</span></div>',
        '<div class="dpr-weekly-evidence-actions">',
        f'<span class="dpr-weekly-evidence-count">{len(top_papers)} 篇</span>',
        '<button type="button" class="dpr-weekly-evidence-toggle" aria-expanded="false" aria-controls="dpr-weekly-evidence-list">展开</button>',
        "</div>",
        "</header>",
        f'<div id="dpr-weekly-evidence-list" class="dpr-weekly-evidence-list" hidden>{evidence_rows if evidence_rows else "<p>暂无代表论文。</p>"}</div>',
        "</section>",
        weekly_report_nav_html(window),
        "</div>",
        "</section>",
    ]
    return "\n".join(lines) + "\n"


def build_report_markdown(
    window: PeriodWindow,
    input_mode: str,
    metrics: dict[str, Any],
    papers: list[dict[str, Any]],
    interpretation: dict[str, Any],
    generated_at: str,
    charts: dict[str, Any] | None = None,
    representative_papers: int = DEFAULT_REPRESENTATIVE_PAPERS,
) -> str:
    if window.period == "weekly":
        return build_weekly_report_markdown(
            window,
            input_mode,
            metrics,
            papers,
            interpretation,
            generated_at,
            representative_papers=representative_papers,
        )
    coverage = metrics.get("coverage") or {}
    period_class = f"dpr-periodic-{window.period}"
    top_papers = papers[: max(1, representative_papers)]
    chart_cfg = charts if isinstance(charts, dict) else {}
    enabled = lambda key: chart_cfg.get(key) is not False
    chart_cards: list[str] = []
    if enabled("topics"):
        chart_cards.append(bar_chart_html(metrics.get("topics") or [], "研究热点 Top Topics", "topics"))
    if enabled("sources"):
        chart_cards.append(bar_chart_html(metrics.get("sources") or [], "来源分布 Source Mix", "sources"))
    if enabled("score_distribution"):
        chart_cards.append(bar_chart_html(metrics.get("score_distribution") or [], "分数分布", "scores"))
    chart_cards.append(bar_chart_html(metrics.get("sections") or [], "精读 / 速读", "sections"))
    if enabled("timeline"):
        chart_cards.append(timeline_svg(metrics.get("timeline") or [], "时间分布"))
    if enabled("topic_timeline"):
        chart_cards.append(topic_timeline_html(metrics.get("topic_timeline") or []))
    paper_cards = "".join(paper_card_html(p, idx) for idx, p in enumerate(top_papers, start=1))
    lines = [
        f'<section class="dpr-periodic-report {period_class}">',
        '<div class="dpr-periodic-hero">',
        '<div class="dpr-periodic-kicker">Periodic Research Intelligence</div>',
        f"<h1>{html.escape(window.label)}</h1>",
        f'<p>基于日报 artifact 的周期研究热点与趋势报告。输入模式：<strong>{html.escape(input_mode)}</strong>；生成时间：{html.escape(generated_at)}</p>',
        '<div class="dpr-periodic-stats">',
        f'<span><strong>{coverage.get("artifact_files", 0)}</strong><em>日报 artifact</em></span>',
        f'<span><strong>{coverage.get("unique_papers", 0)}</strong><em>去重论文</em></span>',
        f'<span><strong>{coverage.get("duplicates_removed", 0)}</strong><em>去重合并</em></span>',
        f'<span><strong>{coverage.get("source_buckets", 0)}</strong><em>来源桶</em></span>',
        f'<span><strong>{metrics.get("avg_score", 0)}</strong><em>平均分</em></span>',
        "</div></div>",
        '<div class="dpr-periodic-layout">',
        '<section class="dpr-periodic-narrative">',
        '<div class="dpr-periodic-panel"><h2>本期重点</h2>',
        list_html(interpretation.get("highlights") or []),
        "</div>",
        '<div class="dpr-periodic-panel"><h2>阅读路线</h2>',
        list_html(interpretation.get("reading_route") or []),
        "</div>",
        '<div class="dpr-periodic-panel"><h2>上升主题 / 值得跟踪</h2>',
        list_html(interpretation.get("rising_topics") or []),
        "</div>",
        '<details class="dpr-periodic-evidence" open><summary>代表论文证据</summary>',
        f'<div class="dpr-periodic-paper-grid">{paper_cards if paper_cards else "<p>暂无代表论文。</p>"}</div>',
        "</details>",
        '<div class="dpr-periodic-panel dpr-periodic-caveats"><h2>覆盖边界</h2>',
        list_html(interpretation.get("caveats") or []),
        f'<p>统计窗口：{html.escape(str(coverage.get("start_date")))} ~ {html.escape(str(coverage.get("end_date")))}；原始记录 {coverage.get("raw_records", 0)} 条。</p>',
        "</div>",
        "</section>",
        '<aside class="dpr-periodic-dashboard">',
        "".join(chart_cards),
        "</aside>",
        "</div>",
        "</section>",
    ]
    return "\n".join(lines) + "\n"


def report_output_dir(docs_dir: Path, window: PeriodWindow) -> Path:
    return docs_dir / "reports" / window.period / window.key


def load_existing_interpretation(out_dir: Path, input_hash: str) -> dict[str, Any] | None:
    meta_path = out_dir / "report.meta.json"
    if not meta_path.exists():
        return None
    try:
        payload = json.loads(meta_path.read_text(encoding="utf-8-sig"))
    except Exception:
        return None
    if payload.get("input_hash") == input_hash and isinstance(payload.get("interpretation"), dict):
        return normalize_interpretation(payload["interpretation"])
    return None


def period_info(period: str) -> dict[str, str]:
    if period == "monthly":
        return {"title": "研究月报", "emoji": "📈", "path": "reports/monthly/README", "label": "月报"}
    return {"title": "研究周报", "emoji": "🗓️", "path": "reports/weekly/README", "label": "周报"}


def load_report_entries(docs_dir: Path, period: str) -> list[dict[str, Any]]:
    root = docs_dir / "reports" / period
    entries: list[dict[str, Any]] = []
    if not root.exists():
        return entries
    for meta_path in sorted(root.glob("*/report.meta.json")):
        try:
            payload = json.loads(meta_path.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        if payload.get("period") != period:
            continue
        key = normalize_text(payload.get("key") or meta_path.parent.name)
        metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
        coverage = metrics.get("coverage") if isinstance(metrics.get("coverage"), dict) else {}
        interpretation = payload.get("interpretation") if isinstance(payload.get("interpretation"), dict) else {}
        topics = (
            payload.get("focus_topics")
            or (metrics.get("weekly_v2") or {}).get("focus_topics")
            or metrics.get("topics")
            or []
        )
        summary = normalize_text(payload.get("weekly_summary") or interpretation.get("weekly_summary") or " ".join((interpretation.get("highlights") or [])[:2]))
        entries.append(
            {
                "key": key,
                "label": normalize_text(payload.get("label") or key),
                "href": f"#/reports/{period}/{key}/README",
                "start_date": normalize_text(payload.get("start_date") or coverage.get("start_date")),
                "end_date": normalize_text(payload.get("end_date") or coverage.get("end_date")),
                "unique_papers": int(coverage.get("unique_papers") or 0),
                "topics": [item for item in topics if isinstance(item, dict)][:4],
                "word_cloud": [item for item in (payload.get("word_cloud") or (metrics.get("weekly_v2") or {}).get("word_cloud") or []) if isinstance(item, dict)][:24],
                "summary": short_text(summary, 160),
            }
        )
    return sorted(entries, key=lambda item: (item.get("start_date") or "", item.get("key") or ""), reverse=True)


def build_periodic_index_markdown(period: str, entries: list[dict[str, Any]]) -> str:
    info = period_info(period)
    cards = []
    for entry in entries:
        topic_tags = "".join(
            f'<span>{html.escape(str(item.get("label") or ""))} {int(item.get("count") or 0)}</span>'
            for item in entry.get("topics") or []
            if item.get("label")
        )
        card_body = (
            mini_word_cloud_html(entry.get("word_cloud") or [])
            if period == "weekly"
            else f'<p>{html.escape(entry.get("summary") or "暂无摘要。")}</p><div>{topic_tags or "<span>暂无主题</span>"}</div>'
        )
        card_meta = ""
        if period != "weekly":
            card_meta = (
                f'<em>{html.escape(entry.get("start_date") or "")} ~ {html.escape(entry.get("end_date") or "")}</em>'
                f'<b>{entry.get("unique_papers", 0)} 篇去重样本</b>'
            )
        cards.append(
            f'<a class="dpr-periodic-index-card is-{html.escape(period)}" '
            f'href="{html.escape(entry.get("href") or "#", quote=True)}">'
            f'<strong>{html.escape(entry.get("label") or "")}</strong>'
            f"{card_meta}"
            f"{card_body}"
            "</a>"
        )
    body = "".join(cards) if cards else '<p class="dpr-periodic-index-empty">还没有生成报告。运行周期报告工作流后，这里会自动出现卡片入口。</p>'
    return "\n".join(
        [
            f'<section class="dpr-periodic-index-page is-{html.escape(period)}-index">',
            f'<div class="dpr-periodic-index-hero"><h1><span>{info["emoji"]}</span>{info["title"]}</h1></div>',
            f'<div class="dpr-periodic-index-grid">{body}</div>',
            "</section>",
        ]
    ) + "\n"


def write_periodic_index_pages(docs_dir: Path) -> None:
    for period in ("weekly", "monthly"):
        out_dir = docs_dir / "reports" / period
        out_dir.mkdir(parents=True, exist_ok=True)
        entries = load_report_entries(docs_dir, period)
        (out_dir / "README.md").write_text(build_periodic_index_markdown(period, entries), encoding="utf-8")


def update_periodic_sidebar(sidebar_path: Path, window: PeriodWindow) -> None:
    sidebar_path.parent.mkdir(parents=True, exist_ok=True)
    if sidebar_path.exists():
        lines = sidebar_path.read_text(encoding="utf-8-sig").splitlines()
    else:
        lines = ['* <a class="dpr-sidebar-root-link" href="#/">首页</a>', "* Daily Papers"]
    cleaned: list[str] = []
    skip_old_periodic_children = False
    for line in [line.rstrip("\n") for line in lines]:
        stripped = line.strip()
        is_top = line.startswith("* ")
        if is_top:
            skip_old_periodic_children = False
        if "<!--dpr-periodic" in line or "#/reports/weekly/README" in line or "#/reports/monthly/README" in line:
            continue
        if is_top and stripped in ("* 研究周报", "* 研究月报"):
            skip_old_periodic_children = True
            continue
        if skip_old_periodic_children and line.startswith("  "):
            continue
        cleaned.append(line)
    lines = cleaned
    daily_idx = next((i for i, line in enumerate(lines) if line.strip().startswith("* Daily Papers")), len(lines))
    if daily_idx == len(lines):
        lines.append("* Daily Papers")
        daily_idx = len(lines) - 1
    insert_idx = next((i for i in range(daily_idx + 1, len(lines)) if lines[i].startswith("* ")), len(lines))
    entries = [
        '* <a class="dpr-sidebar-root-link dpr-sidebar-noactive-link" href="#/reports/weekly/README">🗓️ 研究周报</a> <!--dpr-periodic-root:weekly-->',
        '* <a class="dpr-sidebar-root-link dpr-sidebar-noactive-link" href="#/reports/monthly/README">📈 研究月报</a> <!--dpr-periodic-root:monthly-->',
    ]
    lines[insert_idx:insert_idx] = entries
    sidebar_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def write_report(
    docs_dir: Path,
    window: PeriodWindow,
    input_mode: str,
    metrics: dict[str, Any],
    papers: list[dict[str, Any]],
    artifacts: list[ArtifactFile],
    interpretation: dict[str, Any],
    input_hash: str,
    charts: dict[str, Any] | None = None,
    representative_papers: int = DEFAULT_REPRESENTATIVE_PAPERS,
    dry_run: bool = False,
) -> dict[str, Any]:
    generated_at = datetime.now(BEIJING_TZ).isoformat(timespec="seconds")
    out_dir = report_output_dir(docs_dir, window)
    readme_path = out_dir / "README.md"
    meta_path = out_dir / "report.meta.json"
    artifact_paths = []
    for artifact in artifacts:
        try:
            artifact_paths.append(str(artifact.path.relative_to(ROOT_DIR)))
        except Exception:
            artifact_paths.append(str(artifact.path))
    evidence_index = []
    for paper in papers:
        evidence_index.append(
            {
                "paper_id": paper.get("paper_id") or paper.get("dedupe_key"),
                "title": paper.get("title"),
                "href": paper.get("href") or paper.get("external_url"),
                "artifact_path": paper.get("artifact_path"),
                "score": paper.get("score"),
                "source": paper.get("source"),
                "topics": [tag.get("label") for tag in (paper.get("tags") or []) if tag.get("label")],
            }
        )
    weekly_chart_data = metrics.get("weekly_v2") if isinstance(metrics.get("weekly_v2"), dict) else {}
    payload = {
        "period": window.period,
        "key": window.key,
        "label": window.label,
        "start_date": fmt_date(window.start),
        "end_date": fmt_date(window.end),
        "input_mode": input_mode,
        "input_hash": input_hash,
        "generated_at": generated_at,
        "metrics": metrics,
        "interpretation": interpretation,
        "charts": charts if isinstance(charts, dict) else {},
        "representative_papers": representative_papers,
        "evidence_index": evidence_index,
        "focus_topics": weekly_chart_data.get("focus_topics") or [],
        "context_topics": weekly_chart_data.get("context_topics") or [],
        "weekday_topic_timeline": weekly_chart_data.get("weekday_topic_timeline") or [],
        "word_cloud": weekly_chart_data.get("word_cloud") or [],
        "radar": weekly_chart_data.get("radar") or [],
        "cooccurrence": weekly_chart_data.get("cooccurrence") or [],
        "weekly_summary": normalize_text(interpretation.get("weekly_summary")),
        "artifacts": artifact_paths,
        "papers": papers,
    }
    if dry_run:
        return {"readme": str(readme_path), "meta": str(meta_path), "payload": payload}
    out_dir.mkdir(parents=True, exist_ok=True)
    readme_path.write_text(
        build_report_markdown(
            window,
            input_mode,
            metrics,
            papers,
            interpretation,
            generated_at,
            charts=charts,
            representative_papers=representative_papers,
        ),
        encoding="utf-8",
    )
    meta_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    update_periodic_sidebar(docs_dir / "_sidebar.md", window)
    write_periodic_index_pages(docs_dir)
    return {"readme": str(readme_path), "meta": str(meta_path), "payload": payload}


def run(args: argparse.Namespace) -> dict[str, Any]:
    config = load_yaml_config()
    periodic_cfg = resolve_periodic_config(config)
    period_cfg = periodic_cfg.get(args.period) if isinstance(periodic_cfg.get(args.period), dict) else {}
    fallback_mode = normalize_input_mode(period_cfg.get("input_mode") or periodic_cfg.get("default_input_mode"), "artifacts")
    input_mode = normalize_input_mode(args.input_mode, fallback_mode)
    window = resolve_period_window(args.period, args.start_date, args.end_date)
    docs_dir = Path(args.docs_dir).resolve() if args.docs_dir else DEFAULT_DOCS_DIR
    max_topics = positive_int(args.max_topics or periodic_cfg.get("max_topics"), DEFAULT_MAX_TOPICS)
    max_candidates = positive_int(args.max_candidates or periodic_cfg.get("max_candidates"), DEFAULT_MAX_CANDIDATES)
    representative_papers = positive_int(periodic_cfg.get("representative_papers"), DEFAULT_REPRESENTATIVE_PAPERS)
    charts = periodic_cfg.get("charts") if isinstance(periodic_cfg.get("charts"), dict) else {}
    aliases = periodic_cfg.get("topic_aliases") if isinstance(periodic_cfg.get("topic_aliases"), dict) else {}
    papers, artifacts, duplicate_stats = collect_papers(ROOT_DIR, docs_dir, window, max_candidates, aliases, args.profile_tag or "")
    metrics = build_metrics(papers, artifacts, window, max_topics, duplicate_stats, aliases)
    out_dir = report_output_dir(docs_dir, window)
    input_hash = compute_input_hash(window, input_mode, artifacts, papers, periodic_cfg)
    interpretation = load_existing_interpretation(out_dir, input_hash)
    if interpretation is None:
        interpretation = try_llm_interpretation(window, metrics, papers) or build_fallback_interpretation(window, metrics, papers)
    result = write_report(
        docs_dir,
        window,
        input_mode,
        metrics,
        papers,
        artifacts,
        interpretation,
        input_hash,
        charts=charts,
        representative_papers=representative_papers,
        dry_run=args.dry_run,
    )
    log(f"[OK] periodic report {window.period}:{window.key} papers={len(papers)} artifacts={len(artifacts)}")
    if args.dry_run:
        log(json.dumps({"readme": result["readme"], "meta": result["meta"], "metrics": metrics}, ensure_ascii=False, indent=2))
    else:
        log(f"[OK] README: {result['readme']}")
        log(f"[OK] meta: {result['meta']}")
    return result


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate weekly/monthly research reports from daily artifacts.")
    parser.add_argument("--period", choices=sorted(SUPPORTED_PERIODS), required=True)
    parser.add_argument("--input-mode", choices=sorted(SUPPORTED_INPUT_MODES), default="")
    parser.add_argument("--start-date", default="", help="YYYY-MM-DD or YYYYMMDD")
    parser.add_argument("--end-date", default="", help="YYYY-MM-DD or YYYYMMDD")
    parser.add_argument("--profile-tag", default="")
    parser.add_argument("--fetch-days", type=int, default=0, help="Recorded for workflow compatibility; recrawl is orchestrated by workflow.")
    parser.add_argument("--docs-dir", default="")
    parser.add_argument("--max-candidates", type=int, default=0)
    parser.add_argument("--max-topics", type=int, default=0)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main() -> None:
    args = build_arg_parser().parse_args()
    run(args)


if __name__ == "__main__":
    main()
