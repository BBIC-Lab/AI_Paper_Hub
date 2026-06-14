#!/usr/bin/env python
"""生成/执行 bge-m3 1024 维影子库导出与重建命令。"""

from __future__ import annotations

import argparse
import os
import shlex
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_MODEL = "BAAI/bge-m3"


@dataclass(frozen=True)
class SourceSpec:
    key: str
    source_table: str
    shadow_table: str
    raw_filename: str


SOURCE_SPECS = {
    "arxiv": SourceSpec(
        key="arxiv",
        source_table="arxiv_papers",
        shadow_table="arxiv_papers_bge_m3",
        raw_filename="arxiv_papers_all.json",
    ),
    "biorxiv": SourceSpec(
        key="biorxiv",
        source_table="biorxiv_papers",
        shadow_table="biorxiv_papers_bge_m3",
        raw_filename="biorxiv_papers_all.json",
    ),
}


def parse_sources(value: str) -> List[str]:
    out: List[str] = []
    seen = set()
    for item in str(value or "").replace(";", ",").split(","):
        key = item.strip().lower()
        if not key:
            continue
        if key not in SOURCE_SPECS:
            raise ValueError(f"不支持的 source：{key}")
        if key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out or ["arxiv", "biorxiv"]


def detect_idle_cuda_devices() -> List[str]:
    """按空闲程度返回 cuda 设备；无 nvidia-smi 时回退空列表。"""
    try:
        proc = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,memory.free,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return []

    devices: List[tuple[int, int, int]] = []
    for raw in proc.stdout.splitlines():
        parts = [part.strip() for part in raw.split(",")]
        if len(parts) < 3:
            continue
        try:
            idx = int(parts[0])
            free_mem = int(parts[1])
            util = int(parts[2])
        except Exception:
            continue
        devices.append((idx, free_mem, util))
    devices.sort(key=lambda item: (-item[1], item[2], item[0]))
    return [f"cuda:{idx}" for idx, _free_mem, _util in devices]


def embedding_device_args(embed_devices: str = "", embed_device: str = "") -> List[str]:
    explicit_devices = str(embed_devices or "").strip()
    if explicit_devices:
        return ["--embed-devices", explicit_devices]
    explicit_device = str(embed_device or "").strip()
    if explicit_device:
        return ["--embed-device", explicit_device]
    detected = detect_idle_cuda_devices()
    if len(detected) > 1:
        return ["--embed-devices", ",".join(detected)]
    if len(detected) == 1:
        return ["--embed-device", detected[0]]
    return ["--embed-device", "cpu"]


def raw_path_for(spec: SourceSpec, raw_dir: Path) -> Path:
    return raw_dir / spec.raw_filename


def build_export_command(
    *,
    python: str,
    spec: SourceSpec,
    raw_dir: Path,
    schema: str,
    page_size: int,
    limit: int = 0,
) -> List[str]:
    cmd = [
        python,
        str(ROOT_DIR / "src" / "maintain" / "export_supabase_metadata.py"),
        "--backend-key",
        spec.key,
        "--table",
        spec.source_table,
        "--output",
        str(raw_path_for(spec, raw_dir)),
        "--schema",
        schema,
        "--page-size",
        str(page_size),
    ]
    if limit > 0:
        cmd.extend(["--limit", str(limit)])
    return cmd


def build_sync_command(
    *,
    python: str,
    spec: SourceSpec,
    raw_dir: Path,
    schema: str,
    embed_model: str,
    embed_devices: str = "",
    embed_device: str = "",
    embed_batch_size: int = 8,
    embed_chunk_size: int = 512,
    upsert_batch_size: int = 200,
) -> List[str]:
    cmd = [
        python,
        str(ROOT_DIR / "src" / "maintain" / "sync.py"),
        "--backend-key",
        spec.key,
        "--raw-input",
        str(raw_path_for(spec, raw_dir)),
        "--papers-table",
        spec.shadow_table,
        "--schema",
        schema,
        "--embed-model",
        embed_model,
        "--embed-local-only",
        "--local-maintain-mode",
        "--embed-batch-size",
        str(embed_batch_size),
        "--embed-chunk-size",
        str(embed_chunk_size),
        "--upsert-batch-size",
        str(upsert_batch_size),
    ]
    cmd.extend(embedding_device_args(embed_devices, embed_device))
    return cmd


def shell_join(cmd: List[str]) -> str:
    return shlex.join([str(part) for part in cmd])


def build_background_command(cmd: List[str], log_path: Path) -> str:
    return f"setsid bash -lc {shlex.quote(shell_join(cmd))} > {shlex.quote(str(log_path))} 2>&1 &"


def run_background(cmd: List[str], log_path: Path) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    background_cmd = build_background_command(cmd, log_path)
    subprocess.Popen(["bash", "-lc", background_cmd], cwd=str(ROOT_DIR))


def main() -> None:
    parser = argparse.ArgumentParser(description="bge-m3 shadow rebuild command runner.")
    parser.add_argument("--sources", default="arxiv,biorxiv", help="逗号分隔：arxiv,biorxiv。")
    parser.add_argument("--raw-dir", default=str(ROOT_DIR / "archive" / "bge_m3_rebuild" / "raw"))
    parser.add_argument("--logs-dir", default=str(ROOT_DIR / "logs"))
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--schema", default=os.getenv("SUPABASE_SCHEMA", "public"))
    parser.add_argument("--page-size", type=int, default=1000)
    parser.add_argument("--limit", type=int, default=0, help="导出 smoke test 条数；0 表示全量。")
    parser.add_argument("--embed-model", default=DEFAULT_MODEL)
    parser.add_argument("--embed-devices", default="", help="显式多设备，例如 cuda:0,cuda:1。")
    parser.add_argument("--embed-device", default="", help="显式单设备，例如 cuda:0 或 cpu。")
    parser.add_argument("--embed-batch-size", type=int, default=8)
    parser.add_argument("--embed-chunk-size", type=int, default=512)
    parser.add_argument("--upsert-batch-size", type=int, default=200)
    parser.add_argument("--run-export", action="store_true", help="实际执行只读导出。")
    parser.add_argument("--run-sync", action="store_true", help="实际执行 embedding+upsert。")
    parser.add_argument("--background", action="store_true", help="sync 用 setsid 后台运行。")
    args = parser.parse_args()

    sources = parse_sources(args.sources)
    raw_dir = Path(args.raw_dir)
    logs_dir = Path(args.logs_dir)

    if args.run_export or args.run_sync:
        raw_dir.mkdir(parents=True, exist_ok=True)
        logs_dir.mkdir(parents=True, exist_ok=True)

    for source in sources:
        spec = SOURCE_SPECS[source]
        export_cmd = build_export_command(
            python=args.python,
            spec=spec,
            raw_dir=raw_dir,
            schema=args.schema,
            page_size=args.page_size,
            limit=args.limit,
        )
        sync_cmd = build_sync_command(
            python=args.python,
            spec=spec,
            raw_dir=raw_dir,
            schema=args.schema,
            embed_model=args.embed_model,
            embed_devices=args.embed_devices,
            embed_device=args.embed_device,
            embed_batch_size=args.embed_batch_size,
            embed_chunk_size=args.embed_chunk_size,
            upsert_batch_size=args.upsert_batch_size,
        )
        log_path = logs_dir / f"bge_m3_{source}.log"
        print(f"[{source}] export: {shell_join(export_cmd)}", flush=True)
        print(f"[{source}] sync:   {shell_join(sync_cmd)}", flush=True)
        print(f"[{source}] bg:     {build_background_command(sync_cmd, log_path)}", flush=True)

        if args.run_export:
            subprocess.run(export_cmd, cwd=str(ROOT_DIR), check=True)
        if args.run_sync:
            if args.background:
                run_background(sync_cmd, log_path)
                print(f"[{source}] 后台任务已启动，日志：{log_path}", flush=True)
            else:
                subprocess.run(sync_cmd, cwd=str(ROOT_DIR), check=True)

    if not args.run_export and not args.run_sync:
        print("[DRY-RUN] 未传 --run-export/--run-sync，仅打印命令。", flush=True)


if __name__ == "__main__":
    main()
