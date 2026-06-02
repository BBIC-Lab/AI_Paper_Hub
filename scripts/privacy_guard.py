#!/usr/bin/env python3
"""Fail if private runtime artifacts are tracked in the primary public repo."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def tracked_files() -> list[str]:
    result = subprocess.run(
        ["git", "ls-files"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    return [line.strip().replace("\\", "/") for line in result.stdout.splitlines() if line.strip()]


def main() -> int:
    failures: list[str] = []
    files = tracked_files()

    for path in files:
        if path == "secret.private":
            failures.append(f"tracked private secret file: {path}")
        if re.match(r"^docs/\d{6}/", path):
            failures.append(f"tracked generated dated docs page: {path}")
        if path.startswith("docs/reports/"):
            failures.append(f"tracked generated periodic report page: {path}")
        if path.startswith("docs/assets/figures/"):
            failures.append(f"tracked generated paper figure asset: {path}")
        if path.startswith("archive/") and path != "archive/.gitkeep":
            failures.append(f"tracked runtime archive artifact: {path}")
        if path.startswith("trash/"):
            failures.append(f"tracked runtime trash artifact: {path}")

    for rel in ("config.yaml", "docs/config.yaml", "docs_init/config.yaml"):
        p = ROOT / rel
        if not p.exists():
            failures.append(f"missing template config: {rel}")
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        if "embedding_cache:" in text:
            failures.append(f"private embedding cache in template config: {rel}")
        if re.search(r"(?m)^\s*owner:\s*Jurio0304\s*$", text):
            failures.append(f"personal GitHub owner in template config: {rel}")
        if "AI_Daily_Paper_Reader_Private" in text:
            failures.append(f"private repo name in template config: {rel}")

    if failures:
        print("Privacy guard failed:")
        for item in failures:
            print(f"- {item}")
        return 1
    print("Privacy guard passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
