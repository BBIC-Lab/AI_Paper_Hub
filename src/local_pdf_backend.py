from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

import fitz

from paper_figures import ensure_paper_figures_from_file


ROOT_DIR = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT_DIR / "src"
_GEN6_PATH = SRC_DIR / "6.generate_docs.py"
_GEN6_SPEC = importlib.util.spec_from_file_location("dpr_generate_docs", _GEN6_PATH)
if not _GEN6_SPEC or not _GEN6_SPEC.loader:
    raise RuntimeError(f"无法加载 Step6 模块：{_GEN6_PATH}")
gen6 = importlib.util.module_from_spec(_GEN6_SPEC)
_GEN6_SPEC.loader.exec_module(gen6)

_GENERATION_LOCK = threading.Lock()
_REFINE_MODULE = None


def _clean_line(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _safe_asset_key(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "").strip())
    text = text.strip("-._").lower()
    return text or "local-paper"


def _resolve_local_upload_path(path_value: Any, *, docs_path: Path, label: str) -> Path:
    raw = _clean_line(path_value)
    if not raw:
        raise ValueError(f"{label} is required.")
    path = Path(raw)
    if not path.is_absolute():
        path = ROOT_DIR / path
    path = path.resolve()
    upload_root = (docs_path / "assets" / "local_pdfs" / "uploads").resolve()
    try:
        path.relative_to(upload_root)
    except ValueError as exc:
        raise ValueError(f"Unexpected {label}: {raw}") from exc
    return path


def _load_local_pdf_batch_manifest(*, manifest_path: str, docs_path: Path) -> tuple[Path, list[dict[str, Any]]]:
    path = _resolve_local_upload_path(manifest_path, docs_path=docs_path, label="manifest_path")
    if path.suffix.lower() != ".json":
        raise ValueError("Batch manifest must be a JSON file.")
    if not path.exists():
        raise FileNotFoundError(f"Batch manifest not found: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list) or not items:
        raise ValueError("Batch manifest must include a non-empty items list.")
    clean_items: list[dict[str, Any]] = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError(f"Batch manifest item {index + 1} must be an object.")
        upload_path = _resolve_local_upload_path(
            item.get("upload_path"),
            docs_path=docs_path,
            label=f"items[{index}].upload_path",
        )
        if upload_path.suffix.lower() != ".pdf":
            raise ValueError(f"Batch manifest item {index + 1} is not a PDF: {upload_path}")
        clean_items.append(
            {
                "index": index,
                "upload_path": upload_path,
                "upload_path_raw": _clean_line(item.get("upload_path")),
                "filename": _clean_line(item.get("original_filename") or item.get("filename")) or upload_path.name,
                "title_override": _clean_line(item.get("title_override")),
                "client_id": _clean_line(item.get("client_id")),
            }
        )
    return path, clean_items


def _first_meaningful_line(text: str) -> str:
    for raw in str(text or "").splitlines():
        line = _clean_line(raw)
        if 8 <= len(line) <= 220 and re.search(r"[A-Za-z]{3,}", line):
            if re.match(r"^(abstract|keywords?|introduction|references)\b", line, re.I):
                continue
            return line
    return ""


def _extract_abstract(text: str) -> str:
    source = str(text or "").replace("\r\n", "\n")
    match = re.search(r"\babstract\b[\s:.\-]*([\s\S]{80,2600})", source, re.I)
    if not match:
        return ""
    body = match.group(1) or ""
    stops = [
        r"\n\s*(?:1\.?\s+)?introduction\b",
        r"\n\s*keywords?\b",
        r"\n\s*index terms?\b",
        r"\n\s*(?:2\.?\s+)?related work\b",
    ]
    end = len(body)
    for pattern in stops:
        m = re.search(pattern, body, re.I)
        if m:
            end = min(end, m.start())
    return _clean_line(body[:end])


def _pdf_metadata(pdf_path: str, text: str, fallback_name: str) -> Dict[str, str]:
    title = ""
    authors = ""
    try:
        with fitz.open(pdf_path) as doc:
            meta = doc.metadata or {}
            title = _clean_line(meta.get("title") or "")
            authors = _clean_line(meta.get("author") or "")
    except Exception:
        pass
    if not title or title.lower() == "untitled":
        title = _first_meaningful_line(text)
    if not title:
        title = Path(fallback_name or "local-paper.pdf").stem
    return {
        "title": title,
        "authors": authors,
        "abstract": _extract_abstract(text),
    }


def _configure_temporary_llm(llm_config: Dict[str, Any] | None):
    if not llm_config:
        return None
    api_key = _clean_line(llm_config.get("apiKey") or llm_config.get("api_key"))
    base_url = _clean_line(llm_config.get("baseUrl") or llm_config.get("base_url"))
    model = _clean_line(llm_config.get("model"))
    if not api_key or not base_url or not model:
        return None
    return gen6.make_task_client("summary", api_key=api_key, base_url=base_url, model=model)


def _render_pdf_page_previews(
    pdf_path: str,
    *,
    docs_dir: str,
    source_key: str,
    asset_key: str,
    limit: int = 3,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    asset_dir = Path(docs_dir) / "assets" / "figures" / source_key / _safe_asset_key(asset_key)
    rel_prefix = "/".join(["assets", "figures", source_key, _safe_asset_key(asset_key)])
    asset_dir.mkdir(parents=True, exist_ok=True)
    try:
      doc = fitz.open(pdf_path)
    except Exception:
      return out
    try:
        count = min(len(doc), max(int(limit or 0), 0))
        for i in range(count):
            page = doc[i]
            rect = page.rect
            scale = max(min(720 / max(float(rect.width or 1), 1.0), 1.2), 0.45)
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            name = f"page-preview-{i + 1:03d}.webp"
            path = asset_dir / name
            pix.pil_save(str(path), format="WEBP", quality=78, method=6)
            out.append(
                {
                    "url": "/".join([rel_prefix, name]),
                    "caption": f"Page {i + 1} preview generated from uploaded PDF.",
                    "page": i + 1,
                    "index": i + 1,
                    "width": int(pix.width),
                    "height": int(pix.height),
                }
            )
    finally:
        doc.close()
    return out


def _parse_llm_config(raw: str | None) -> Dict[str, Any] | None:
    if not raw:
        return None
    try:
        obj = json.loads(raw)
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def _load_refine_module():
    global _REFINE_MODULE
    if _REFINE_MODULE is not None:
        return _REFINE_MODULE
    refine_path = SRC_DIR / "4.llm_refine_papers.py"
    spec = importlib.util.spec_from_file_location("dpr_llm_refine", refine_path)
    if not spec or not spec.loader:
        raise RuntimeError(f"Cannot load Step4 refine module: {refine_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _REFINE_MODULE = module
    return module


def _format_score_display(score: Any, label: str = "") -> str:
    text_label = _clean_line(label)
    try:
        score_text = f"{float(score):.1f}"
    except Exception:
        score_text = _clean_line(score)
    if not score_text:
        return ""
    return f"{score_text} {text_label}".strip()


def _make_local_filter_client(refine: Any, llm_config: Dict[str, Any] | None):
    llm_config = llm_config or {}
    api_key = _clean_line(llm_config.get("apiKey") or llm_config.get("api_key"))
    base_url = _clean_line(llm_config.get("baseUrl") or llm_config.get("base_url"))
    model = _clean_line(
        llm_config.get("filterModel")
        or llm_config.get("filter_model")
        or llm_config.get("model")
    )
    client = gen6.make_task_client(
        "filter",
        api_key=api_key or None,
        base_url=base_url or None,
        model=model or None,
    )
    client.kwargs.update({"temperature": 0.1, "max_tokens": 2048})
    return client


def _score_local_pdf_against_subscriptions(
    paper: Dict[str, Any],
    text: str,
    llm_config: Dict[str, Any] | None,
) -> Dict[str, Any] | None:
    try:
        refine = _load_refine_module()
        config = refine.load_config()
        requirements = refine.build_user_requirements(config, [])
        if not requirements:
            return None

        paper_id = _clean_line(paper.get("id")) or "local-pdf"
        abstract = _clean_line(paper.get("abstract"))
        excerpt = _clean_line(text[:5000])
        eval_text = abstract
        if excerpt and excerpt not in abstract:
            eval_text = f"{abstract}\n\nFull-text excerpt: {excerpt[:2500]}".strip()
        content = refine.format_doc(_clean_line(paper.get("title")), eval_text, 2600)
        docs = [{"id": paper_id, "content": content}]
        client = _make_local_filter_client(refine, llm_config)
        runner = refine._make_filter_runner(
            client,
            all_requirements=requirements,
            debug_dir="",
            base_tag="local_pdf",
        )
        results = refine.recover_filter_results(
            docs,
            runner,
            max_attempts=2,
            debug_tag="local_pdf",
        )
        merged: Dict[str, Dict[str, Any]] = {}
        requirement_by_index = {i + 1: r for i, r in enumerate(requirements)}
        for item in results:
            refine.merge_filter_result(merged, item, requirement_by_index)
        return merged.get(paper_id)
    except Exception as exc:
        print(f"[WARN] local PDF subscription scoring skipped: {exc}", flush=True)
        return None


def _apply_subscription_score(paper: Dict[str, Any], score_result: Dict[str, Any] | None) -> None:
    if not score_result:
        return
    try:
        score = float(score_result.get("score"))
    except Exception:
        return
    paper["llm_score"] = max(0.0, min(10.0, score))
    paper["score_label"] = "订阅评分"
    evidence = _clean_line(score_result.get("canonical_evidence"))
    if evidence:
        paper["canonical_evidence"] = evidence
    tldr_cn = _clean_line(score_result.get("tldr_cn"))
    if tldr_cn and tldr_cn != "不相关":
        paper["llm_tldr_cn"] = tldr_cn
    matched_tag = _clean_line(score_result.get("matched_query_tag"))
    if matched_tag:
        tags = paper.setdefault("llm_tags", [])
        if isinstance(tags, list) and matched_tag not in tags:
            tags.append(matched_tag)
    matched_query = _clean_line(score_result.get("matched_query_text"))
    if matched_query:
        paper["matched_query_text"] = matched_query


def _insert_local_sidebar_entry(
    sidebar_path: str,
    paper_id: str,
    title: str,
    evidence: str = "",
    score: Any = "local",
    score_label: str = "",
) -> None:
    path = Path(sidebar_path)
    lines = path.read_text(encoding="utf-8").splitlines(True) if path.exists() else []
    original_text = "".join(lines)
    root_line = "* 📄 本地 PDF 解析\n"
    upload_line = '  * <a class="dpr-sidebar-brief-link" href="#/local-pdf">📝 上传解析</a>\n'
    daily_line = "* 🗂️ 近期日报\n"
    daily_note_line = (
        '  * <small class="dpr-sidebar-daily-note">'
        '完整论文报告参见<a class="dpr-sidebar-daily-note-link" href="#/reader-library">「个人论文库」</a>'
        "</small>\n"
    )

    def is_daily_root(line: str) -> bool:
        return line.startswith("* ") and ("近期日报" in line or "Daily Papers" in line)

    def ensure_daily_note() -> None:
        daily_root_idx = next((i for i, line in enumerate(lines) if is_daily_root(line)), -1)
        if daily_root_idx < 0:
            return
        lines[daily_root_idx] = daily_line
        daily_end = next((i for i in range(daily_root_idx + 1, len(lines)) if lines[i].startswith("* ")), len(lines))
        lines[daily_root_idx + 1 : daily_end] = [
            line for line in lines[daily_root_idx + 1 : daily_end] if "dpr-sidebar-daily-note" not in line
        ]
        daily_end = next((i for i in range(daily_root_idx + 1, len(lines)) if lines[i].startswith("* ")), len(lines))
        lines.insert(daily_end, daily_note_line)

    daily_idx = next((i for i, line in enumerate(lines) if is_daily_root(line)), -1)
    root_idx = next(
        (
            i
            for i, line in enumerate(lines)
            if (line.startswith("* ") and "本地 PDF 解析" in line) or (line.startswith("* ") and 'href="#/local-pdf"' in line)
        ),
        -1,
    )
    if root_idx == -1:
        insert_at = daily_idx if daily_idx >= 0 else len(lines)
        lines.insert(insert_at, root_line)
        lines.insert(insert_at + 1, upload_line)
        root_idx = insert_at
        if daily_idx >= 0:
            daily_idx += 2
    elif lines[root_idx] != root_line:
        lines[root_idx] = root_line
    if daily_idx == -1:
        lines.append(daily_line)
        daily_idx = len(lines) - 1
    elif lines[daily_idx] != daily_line:
        lines[daily_idx] = daily_line

    next_top = next((i for i in range(root_idx + 1, len(lines)) if lines[i].startswith("* ")), len(lines))
    upload_idx = next((i for i in range(root_idx + 1, next_top) if 'href="#/local-pdf"' in lines[i]), -1)
    if upload_idx == -1:
        lines.insert(root_idx + 1, upload_line)
        next_top += 1
        upload_idx = root_idx + 1
    else:
        lines[upload_idx] = upload_line
    section_idx = next(
        (i for i in range(root_idx + 1, next_top) if lines[i].strip() == "* 精读区"),
        -1,
    )
    if section_idx == -1:
        insert_at = upload_idx + 1 if upload_idx >= 0 else root_idx + 1
        lines.insert(insert_at, "  * 精读区\n")
        section_idx = insert_at
        next_top += 1

    href = f"#/{paper_id}"
    if any(href in line for line in lines[root_idx + 1:next_top]):
        ensure_daily_note()
        next_text = "".join(lines)
        if next_text != original_text:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(next_text, encoding="utf-8")
        return
    safe_title = gen6.html.escape(_clean_line(title) or paper_id)
    payload = {
        "title": title,
        "link": href,
        "score": _format_score_display(score, score_label) or "local",
        "tags": [{"kind": "paper", "label": "本地PDF"}],
        "evidence": _clean_line(evidence) or "本地上传 PDF，使用后端精读流程生成。",
    }
    entry = (
        '    * '
        f'<a class="dpr-sidebar-item-link dpr-sidebar-item-structured" href="{href}" '
        f'data-sidebar-item="{gen6.html.escape(json.dumps(payload, ensure_ascii=False), quote=True)}">{safe_title}</a>\n'
    )
    insert_at = section_idx + 1
    while insert_at < len(lines) and lines[insert_at].startswith("    * "):
        insert_at += 1
    lines.insert(section_idx + 1, entry)
    ensure_daily_note()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(lines), encoding="utf-8")


def generate_local_pdf_deep_doc(
    *,
    pdf_bytes: bytes,
    filename: str,
    title_override: str | None = None,
    llm_config_json: str | None = None,
    docs_dir: str | None = None,
    date_str: str | None = None,
) -> Dict[str, Any]:
    if not pdf_bytes:
        raise ValueError("上传的 PDF 为空。")
    docs_path = Path(docs_dir or gen6.resolve_docs_dir()).resolve()
    docs_path.mkdir(parents=True, exist_ok=True)
    day = (date_str or datetime.now(timezone.utc).strftime("%Y%m%d")).strip()
    upload_stamp = datetime.now(timezone.utc).strftime("%H%M%S%f")
    llm_config = _parse_llm_config(llm_config_json)

    tmp_dir = docs_path / "assets" / "local_pdfs"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    safe_original = _safe_asset_key(Path(filename or "local-paper.pdf").stem)
    asset_key = _safe_asset_key(f"local-{day}-{upload_stamp}-{safe_original}")
    pdf_asset_rel = f"assets/local_pdfs/{asset_key}.pdf"
    pdf_asset_path = docs_path / pdf_asset_rel
    pdf_asset_path.write_bytes(pdf_bytes)

    text = gen6.extract_pdf_text(str(pdf_asset_path))
    meta = _pdf_metadata(str(pdf_asset_path), text, filename)
    detected_title = meta["title"]
    title = _clean_line(title_override) or detected_title
    abstract = meta["abstract"] or _clean_line(text[:1200])
    slug = gen6.slugify(title)
    paper_basename = f"{asset_key}-{slug}"
    paper_id = f"local-pdf/{day}/{paper_basename}"
    paper_dir = docs_path / "local-pdf" / day
    md_path = paper_dir / f"{paper_basename}.md"
    txt_path = paper_dir / f"{paper_basename}.txt"
    paper_dir.mkdir(parents=True, exist_ok=True)
    txt_path.write_text(text or "", encoding="utf-8")

    figures = ensure_paper_figures_from_file(
        pdf_path=str(pdf_asset_path),
        docs_dir=str(docs_path),
        source_key="local-pdf",
        asset_key=asset_key,
    )
    if not figures:
        figures = _render_pdf_page_previews(
            str(pdf_asset_path),
            docs_dir=str(docs_path),
            source_key="local-pdf",
            asset_key=asset_key,
        )

    paper = {
        "id": asset_key,
        "title": title,
        "authors": [meta["authors"]] if meta["authors"] else [],
        "published": f"{day[:4]}-{day[4:6]}-{day[6:8]}",
        "link": pdf_asset_rel,
        "pdf_url": pdf_asset_rel,
        "abstract": abstract,
        "source": "local-pdf",
        "selection_source": "local_upload",
        "llm_score": "local",
        "canonical_evidence": "本地上传 PDF，使用后端精读流程生成。",
        "llm_tldr_cn": abstract[:260],
        "llm_tags": ["paper:本地PDF", "query:local-pdf"],
        "_figure_assets": figures,
    }

    zh_title = ""
    glance: dict[str, str] = {}
    with _GENERATION_LOCK:
        old_client = gen6.LLM_CLIENT
        old_error = gen6.LLM_INIT_ERROR
        try:
            temporary_client = _configure_temporary_llm(llm_config)
            if temporary_client is not None:
                gen6.LLM_CLIENT = temporary_client
                gen6.LLM_INIT_ERROR = ""
            _apply_subscription_score(
                paper,
                _score_local_pdf_against_subscriptions(paper, text, llm_config),
            )
            zh_title, zh_abstract = gen6.translate_title_and_abstract_to_zh(title, abstract)
            glance = gen6.generate_glance_overview(title, abstract) or gen6.build_glance_fallback(paper)
            if glance:
                paper["_glance_overview"] = glance
            content = gen6.build_markdown_content(
                paper,
                "deep",
                zh_title,
                zh_abstract,
                gen6.build_tags_list("deep", paper.get("llm_tags") or []),
            )
            md_path.write_text(content, encoding="utf-8")
            summary = gen6.generate_deep_summary(str(md_path), str(txt_path))
            if summary:
                gen6.upsert_auto_block(str(md_path), "论文详细总结（自动生成）", summary)
        finally:
            if llm_config:
                gen6.LLM_CLIENT = old_client
                gen6.LLM_INIT_ERROR = old_error

    sidebar_evidence = str(
        zh_title
        or (paper.get("_glance_overview") or {}).get("motivation")
        or paper.get("canonical_evidence")
        or "本地上传 PDF，使用后端精读流程生成。"
    ).strip()
    _insert_local_sidebar_entry(
        str(docs_path / "_sidebar.md"),
        paper_id,
        title,
        sidebar_evidence,
        score=paper.get("llm_score"),
        score_label=str(paper.get("score_label") or ""),
    )
    return {
        "ok": True,
        "title": title,
        "detected_title": detected_title,
        "paper_id": paper_id,
        "route": f"#/{paper_id}",
        "md_path": str(md_path),
        "txt_path": str(txt_path),
        "pdf_path": str(pdf_asset_path),
        "figures_count": len(figures),
        "score": paper.get("llm_score"),
        "score_label": paper.get("score_label"),
    }


def generate_local_pdf_deep_doc_from_file(
    *,
    pdf_path: str,
    filename: str | None = None,
    title_override: str | None = None,
    llm_config_json: str | None = None,
    docs_dir: str | None = None,
    date_str: str | None = None,
) -> Dict[str, Any]:
    path = Path(pdf_path).resolve()
    if not path.exists():
        raise FileNotFoundError(f"PDF 文件不存在：{path}")
    return generate_local_pdf_deep_doc(
        pdf_bytes=path.read_bytes(),
        filename=filename or path.name,
        title_override=title_override,
        llm_config_json=llm_config_json,
        docs_dir=docs_dir,
        date_str=date_str,
    )


def generate_local_pdf_deep_docs_from_manifest(
    *,
    manifest_path: str,
    llm_config_json: str | None = None,
    docs_dir: str | None = None,
    date_str: str | None = None,
    cleanup_uploads: bool = False,
) -> Dict[str, Any]:
    docs_path = Path(docs_dir or gen6.resolve_docs_dir()).resolve()
    manifest_file, items = _load_local_pdf_batch_manifest(manifest_path=manifest_path, docs_path=docs_path)
    day = (date_str or datetime.now(timezone.utc).strftime("%Y%m%d")).strip()
    results: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []

    for item in items:
        result_base = {
            "index": item["index"],
            "client_id": item.get("client_id") or "",
            "upload_path": item.get("upload_path_raw") or str(item["upload_path"]),
            "filename": item.get("filename") or item["upload_path"].name,
        }
        try:
            result = generate_local_pdf_deep_doc_from_file(
                pdf_path=str(item["upload_path"]),
                filename=item.get("filename") or item["upload_path"].name,
                title_override=item.get("title_override") or None,
                llm_config_json=llm_config_json,
                docs_dir=str(docs_path),
                date_str=day,
            )
            result.update(result_base)
            results.append(result)
            if cleanup_uploads:
                item["upload_path"].unlink(missing_ok=True)
        except Exception as exc:
            failure = {
                **result_base,
                "ok": False,
                "error": str(exc),
            }
            results.append(failure)
            failures.append(failure)

    if cleanup_uploads and not failures:
        manifest_file.unlink(missing_ok=True)
        try:
            manifest_file.parent.rmdir()
        except OSError:
            pass

    return {
        "ok": not failures,
        "succeeded": len(results) - len(failures),
        "failed": len(failures),
        "manifest_path": str(manifest_file),
        "results": results,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate a Daily Paper style deep-read page from a local PDF.")
    parser.add_argument("--pdf-path", default="", help="Path to the uploaded PDF file.")
    parser.add_argument("--manifest-path", default="", help="Batch manifest JSON under docs/assets/local_pdfs/uploads.")
    parser.add_argument("--filename", default="", help="Original filename shown in generated metadata.")
    parser.add_argument("--title-override", default="", help="Optional user-corrected paper title.")
    parser.add_argument("--docs-dir", default=str(ROOT_DIR / "docs"), help="Docs directory to update.")
    parser.add_argument("--date", default="", help="Optional YYYYMMDD date folder.")
    parser.add_argument("--cleanup-uploads", action="store_true", help="Remove temporary uploaded PDFs after success.")
    parser.add_argument(
        "--llm-config-json",
        default="",
        help="Optional temporary LLM JSON. GitHub Actions should prefer DPR_LLM_* secrets instead.",
    )
    args = parser.parse_args(argv)
    if args.manifest_path:
        result = generate_local_pdf_deep_docs_from_manifest(
            manifest_path=args.manifest_path,
            llm_config_json=args.llm_config_json or None,
            docs_dir=args.docs_dir,
            date_str=args.date or None,
            cleanup_uploads=args.cleanup_uploads,
        )
    elif args.pdf_path:
        result = generate_local_pdf_deep_doc_from_file(
            pdf_path=args.pdf_path,
            filename=args.filename or None,
            title_override=args.title_override or None,
            llm_config_json=args.llm_config_json or None,
            docs_dir=args.docs_dir,
            date_str=args.date or None,
        )
    else:
        parser.error("one of --pdf-path or --manifest-path is required")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok", True) or int(result.get("succeeded") or 0) > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
