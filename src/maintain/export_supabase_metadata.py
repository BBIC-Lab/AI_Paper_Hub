#!/usr/bin/env python
"""只读导出现有 Supabase 论文元数据，不导出旧 embedding。"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

import requests

SRC_DIR = Path(__file__).resolve().parents[1]
ROOT_DIR = SRC_DIR.parent
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

try:
    import yaml  # type: ignore
except Exception:  # pragma: no cover
    yaml = None

try:
    from source_config import get_source_backend
except Exception:  # pragma: no cover
    from src.source_config import get_source_backend


METADATA_COLUMNS = (
    "id",
    "source",
    "source_paper_id",
    "doi",
    "version",
    "title",
    "abstract",
    "authors",
    "primary_category",
    "categories",
    "published",
    "link",
    "updated_at",
)

DEFAULT_TABLES = {
    "arxiv": "arxiv_papers",
    "biorxiv": "biorxiv_papers",
}


def _norm(value: Any) -> str:
    return str(value or "").strip()


def _base_rest(url: str) -> str:
    return _norm(url).rstrip("/") + "/rest/v1"


def _headers(api_key: str, schema: str) -> Dict[str, str]:
    safe_schema = _norm(schema) or "public"
    return {
        "apikey": api_key,
        "Authorization": f"Bearer {api_key}",
        "Accept-Profile": safe_schema,
        "Content-Profile": safe_schema,
        "Prefer": "count=exact",
    }


def load_config(path: Path | None = None) -> Dict[str, Any]:
    config_path = path or (ROOT_DIR / "config.yaml")
    if yaml is None or not config_path.exists():
        return {}
    try:
        data = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def parse_content_range_total(value: Any) -> int | None:
    text = _norm(value)
    if "/" not in text:
        return None
    total_text = text.rsplit("/", 1)[-1].strip()
    if not total_text or total_text == "*":
        return None
    try:
        return int(total_text)
    except Exception:
        return None


def default_output_path(backend_key: str, table: str) -> Path:
    safe_table = _norm(table) or DEFAULT_TABLES.get(_norm(backend_key).lower(), "papers")
    return ROOT_DIR / "archive" / "bge_m3_rebuild" / "raw" / f"{safe_table}_all.json"


def resolve_export_config(args: argparse.Namespace) -> Dict[str, str]:
    backend_key = _norm(args.backend_key).lower() or "arxiv"
    cfg = load_config()
    backend = get_source_backend(cfg, backend_key)
    table = _norm(args.table) or _norm((backend or {}).get("papers_table")) or DEFAULT_TABLES.get(backend_key, "papers")
    url = _norm(args.url) or _norm((backend or {}).get("url")) or _norm(os.getenv("SUPABASE_URL"))
    key = (
        _norm(args.service_key)
        or _norm(os.getenv("SUPABASE_SERVICE_KEY"))
        or _norm(os.getenv("SUPABASE_ANON_KEY"))
        or _norm((backend or {}).get("anon_key"))
    )
    schema = _norm(args.schema) or _norm((backend or {}).get("schema")) or "public"
    output = _norm(args.output) or str(default_output_path(backend_key, table))
    if not url:
        raise RuntimeError("缺少 Supabase URL；请设置 --url、config.yaml 或 SUPABASE_URL。")
    if not key:
        raise RuntimeError("缺少 Supabase key；请设置 SUPABASE_SERVICE_KEY，或只读 anon key。")
    return {
        "backend_key": backend_key,
        "table": table,
        "url": url,
        "key": key,
        "schema": schema,
        "output": output,
    }


def sanitize_row(row: Dict[str, Any]) -> Dict[str, Any]:
    # 明确只保留元数据字段，避免旧 embedding/维度信息混入重建 raw。
    out: Dict[str, Any] = {}
    for key in METADATA_COLUMNS:
        if key in row:
            out[key] = row.get(key)
    return out


def missing_column_from_error(resp: requests.Response, active_columns: List[str]) -> str:
    try:
        payload = resp.json() or {}
    except Exception:
        payload = {}
    message = _norm(payload.get("message") if isinstance(payload, dict) else "") or _norm(resp.text)
    for column in active_columns:
        if re.search(rf"\b{re.escape(column)}\b", message):
            return column
    return ""


def export_metadata(
    *,
    url: str,
    api_key: str,
    table: str,
    schema: str = "public",
    page_size: int = 1000,
    limit: int = 0,
    timeout: int = 60,
    retries: int = 6,
    retry_wait: float = 2.0,
) -> tuple[List[Dict[str, Any]], int | None]:
    safe_page_size = min(max(int(page_size or 1000), 1), 1000)
    safe_limit = max(int(limit or 0), 0)
    endpoint = f"{_base_rest(url)}/{table}"
    rows_out: List[Dict[str, Any]] = []
    reported_total: int | None = None
    offset = 0
    active_columns = list(METADATA_COLUMNS)

    while True:
        if safe_limit and len(rows_out) >= safe_limit:
            break
        page_limit = safe_page_size
        if safe_limit:
            page_limit = min(page_limit, safe_limit - len(rows_out))
        params = {
            "select": ",".join(active_columns),
            "order": "id.asc",
            "limit": str(page_limit),
            "offset": str(offset),
        }
        max_attempts = max(int(retries or 0), 0) + 1
        resp = None
        last_error: Exception | None = None
        for attempt in range(1, max_attempts + 1):
            try:
                resp = requests.get(
                    endpoint,
                    headers=_headers(api_key, schema),
                    params=params,
                    timeout=max(int(timeout or 60), 1),
                )
                if resp.status_code < 500 and resp.status_code != 429:
                    break
                last_error = RuntimeError(f"HTTP {resp.status_code} {resp.text[:120]}")
            except Exception as exc:
                last_error = exc
            if attempt >= max_attempts:
                break
            wait_s = max(float(retry_wait or 0.0), 0.0) * attempt
            print(
                f"[WARN] 导出分页失败，准备重试：table={table} offset={offset} "
                f"attempt={attempt}/{max_attempts} wait={wait_s:.1f}s error={last_error}",
                flush=True,
            )
            if wait_s > 0:
                time.sleep(wait_s)
        if resp is None:
            raise RuntimeError(f"导出失败：offset={offset}, error={last_error}")
        if resp.status_code >= 300:
            missing_column = missing_column_from_error(resp, active_columns)
            if resp.status_code == 400 and missing_column:
                active_columns = [column for column in active_columns if column != missing_column]
                reported_total = None
                offset = 0
                rows_out = []
                continue
            raise RuntimeError(f"导出失败：HTTP {resp.status_code} {resp.text[:200]}")
        if reported_total is None:
            reported_total = parse_content_range_total(resp.headers.get("Content-Range"))
        page = resp.json() or []
        if not isinstance(page, list):
            raise RuntimeError("导出失败：Supabase 返回格式不是 list。")
        if not page:
            break
        rows_out.extend(sanitize_row(row) for row in page if isinstance(row, dict))
        got = len(page)
        offset += got
        if got < page_limit:
            break
        if reported_total is not None and offset >= reported_total:
            break

    return rows_out, reported_total


def write_json(path: str, rows: List[Dict[str, Any]]) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(rows, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Export Supabase paper metadata without old embeddings.")
    parser.add_argument("--backend-key", default="arxiv", help="source_backends key，默认 arxiv。")
    parser.add_argument("--table", default="", help="源表名；默认取 backend papers_table。")
    parser.add_argument("--output", default="", help="输出 JSON；默认 archive/bge_m3_rebuild/raw/<table>_all.json。")
    parser.add_argument("--url", default=os.getenv("SUPABASE_URL", ""), help="Supabase URL。")
    parser.add_argument("--service-key", default=os.getenv("SUPABASE_SERVICE_KEY", ""), help="Service key；空则回退 anon key。")
    parser.add_argument("--schema", default=os.getenv("SUPABASE_SCHEMA", "public"), help="PostgREST schema。")
    parser.add_argument("--page-size", type=int, default=1000, help="分页大小，最大 1000。")
    parser.add_argument("--limit", type=int, default=0, help="仅导出前 N 条，用于 smoke test。")
    parser.add_argument("--timeout", type=int, default=60, help="单次请求超时秒数。")
    parser.add_argument("--retries", type=int, default=6, help="分页请求重试次数。")
    parser.add_argument("--retry-wait", type=float, default=2.0, help="分页请求递增重试等待秒数。")
    args = parser.parse_args()

    resolved = resolve_export_config(args)
    rows, reported_total = export_metadata(
        url=resolved["url"],
        api_key=resolved["key"],
        table=resolved["table"],
        schema=resolved["schema"],
        page_size=args.page_size,
        limit=args.limit,
        timeout=args.timeout,
        retries=args.retries,
        retry_wait=args.retry_wait,
    )
    write_json(resolved["output"], rows)
    count_msg = f", reported_total={reported_total}" if reported_total is not None else ""
    print(
        f"[OK] 导出完成：backend={resolved['backend_key']} table={resolved['table']} "
        f"rows={len(rows)}{count_msg} output={resolved['output']}",
        flush=True,
    )


if __name__ == "__main__":
    main()
