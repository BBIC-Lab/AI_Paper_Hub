"""Send the latest generated daily report by email.

The script intentionally reuses the already-generated Markdown report and never
calls an LLM. Secrets are supplied through GitHub Actions environment variables.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import smtplib
import ssl
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Iterable


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_STATE_PATH = ROOT_DIR / "archive" / "email_state.json"


def _env(name: str, default: str = "") -> str:
    return str(os.environ.get(name, default) or "").strip()


def is_truthy(value: str) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class EmailConfig:
    enabled: bool
    to_addr: str
    from_addr: str
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_password: str
    site_url: str
    subject_prefix: str = "AI Daily Paper Reader"

    @property
    def smtp_pass(self) -> str:
        return self.smtp_password


@dataclass
class DailyReport:
    markdown: str
    text: str
    html: str
    detail_url: str
    source_path: Path
    content_hash: str


def load_email_config() -> EmailConfig:
    port_text = _env("DPR_SMTP_PORT", "587")
    try:
        port = int(port_text)
    except ValueError:
        port = 587
    return EmailConfig(
        enabled=is_truthy(_env("DPR_EMAIL_ENABLED", "false")),
        to_addr=_env("DPR_EMAIL_TO"),
        from_addr=_env("DPR_EMAIL_FROM"),
        smtp_host=_env("DPR_SMTP_HOST"),
        smtp_port=port,
        smtp_user=_env("DPR_SMTP_USER"),
        smtp_password=_env("DPR_SMTP_PASSWORD"),
        site_url=_env("DPR_EMAIL_SITE_URL") or infer_site_url(),
        subject_prefix=_env("DPR_EMAIL_SUBJECT_PREFIX", "AI Daily Paper Reader"),
    )


def infer_site_url() -> str:
    repo = _env("GITHUB_REPOSITORY")
    if not repo or "/" not in repo:
        return ""
    owner, name = repo.split("/", 1)
    public_name = re.sub(r"[_-]Private$", "", name, flags=re.IGNORECASE)
    return f"https://{owner}.github.io/{public_name}/"


def validate_config(config: EmailConfig) -> None:
    if not config.enabled:
        return
    missing = [
        name
        for name, value in [
            ("DPR_EMAIL_TO", config.to_addr),
            ("DPR_EMAIL_FROM", config.from_addr),
            ("DPR_SMTP_HOST", config.smtp_host),
            ("DPR_SMTP_USER", config.smtp_user),
            ("DPR_SMTP_PASSWORD", config.smtp_password),
        ]
        if not value
    ]
    if missing:
        raise RuntimeError(f"missing required email secrets: {', '.join(missing)}")
    if not (0 < config.smtp_port <= 65535):
        raise RuntimeError("DPR_SMTP_PORT must be between 1 and 65535")


def read_latest_markdown(root: Path) -> tuple[str, Path]:
    candidates = [
        root / "docs" / "README.md",
        root / "docs_init" / "README.md",
    ]
    for path in candidates:
        if path.exists():
            text = path.read_text(encoding="utf-8")
            if text.strip():
                return text, path
    raise FileNotFoundError("no docs/README.md report found")


def strip_frontmatter(markdown: str) -> str:
    text = markdown.lstrip("\ufeff")
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end >= 0:
            return text[end + 4 :].lstrip()
    return markdown


def first_detail_href(markdown: str) -> str:
    for line in markdown.splitlines():
        if "详情" not in line and "Detail" not in line and "detail" not in line:
            continue
        match = re.search(r"\[[^\]]+\]\(([^)]+)\)", line)
        if match:
            return match.group(1).strip()
    match = re.search(r"\[[^\]]+\]\((/\d{6}/\d{2}/README)\)", markdown)
    return match.group(1).strip() if match else ""


def absolutize_docsify_link(href: str, site_url: str) -> str:
    value = (href or "").strip()
    if not value:
        return ""
    if re.match(r"^https?://", value, flags=re.IGNORECASE):
        return value
    base = (site_url or "").strip().rstrip("/")
    if not base:
        return value
    if value.startswith("#/"):
        return f"{base}/{value}"
    if value.startswith("/"):
        return f"{base}/#{value}"
    return f"{base}/#/{value.lstrip('./')}"


def replace_markdown_links(markdown: str, site_url: str) -> str:
    def repl(match: re.Match[str]) -> str:
        label = match.group(1)
        href = absolutize_docsify_link(match.group(2), site_url)
        return f"{label} ({href})" if href else label

    return re.sub(r"\[([^\]]+)\]\(([^)]+)\)", repl, markdown)


def markdown_to_text(markdown: str, site_url: str) -> str:
    text = strip_frontmatter(markdown)
    text = replace_markdown_links(text, site_url)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def markdown_to_html(markdown: str, site_url: str) -> str:
    text = strip_frontmatter(markdown)
    lines: list[str] = []
    in_list = False

    def close_list() -> None:
        nonlocal in_list
        if in_list:
            lines.append("</ul>")
            in_list = False

    def inline_md(value: str) -> str:
        escaped = html.escape(value)

        def link_repl(match: re.Match[str]) -> str:
            label = html.escape(match.group(1))
            href = html.escape(absolutize_docsify_link(match.group(2), site_url), quote=True)
            return f'<a href="{href}">{label}</a>' if href else label

        escaped = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", link_repl, escaped)
        escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
        return escaped

    for raw in text.splitlines():
        line = raw.rstrip()
        if not line:
            close_list()
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)$", line)
        if heading:
            close_list()
            level = min(3, max(2, len(heading.group(1))))
            lines.append(f"<h{level}>{inline_md(heading.group(2))}</h{level}>")
            continue
        item = re.match(r"^\s*[-*]\s+(.*)$", line)
        if item:
            if not in_list:
                lines.append("<ul>")
                in_list = True
            lines.append(f"<li>{inline_md(item.group(1))}</li>")
            continue
        close_list()
        lines.append(f"<p>{inline_md(line)}</p>")
    close_list()

    return """<!doctype html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.65;color:#172033;">
  <div style="max-width:760px;margin:0 auto;padding:16px;">
    {body}
  </div>
</body>
</html>""".format(body="\n".join(lines))


def build_daily_report(root: Path, site_url: str) -> DailyReport:
    markdown, source_path = read_latest_markdown(root)
    detail_url = absolutize_docsify_link(first_detail_href(markdown), site_url)
    text = markdown_to_text(markdown, site_url)
    if detail_url and detail_url not in text:
        text = f"{text}\n\n详情链接：{detail_url}"
    html_body = markdown_to_html(markdown, site_url)
    if detail_url and detail_url not in html_body:
        html_body = html_body.replace(
            "</div>",
            f'<p><strong>详情链接：</strong> <a href="{html.escape(detail_url, quote=True)}">{html.escape(detail_url)}</a></p>\n</div>',
            1,
        )
    content_hash = hashlib.sha256(
        (markdown + "\n" + detail_url).encode("utf-8")
    ).hexdigest()
    return DailyReport(
        markdown=markdown,
        text=text,
        html=html_body,
        detail_url=detail_url,
        source_path=source_path,
        content_hash=content_hash,
    )


def load_state(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def save_state(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def should_skip_duplicate(report: DailyReport, state: dict, force: bool) -> bool:
    if force:
        return False
    return state.get("last_report_hash") == report.content_hash


def build_message(config: EmailConfig, report: DailyReport) -> EmailMessage:
    subject = f"{config.subject_prefix} - Daily Brief"
    msg = EmailMessage()
    msg["From"] = config.from_addr
    msg["To"] = config.to_addr
    msg["Subject"] = subject
    msg.set_content(report.text)
    msg.add_alternative(report.html, subtype="html")
    return msg


def send_message(config: EmailConfig, message: EmailMessage) -> None:
    context = ssl.create_default_context()
    password = getattr(config, "smtp_pass", None) or config.smtp_password

    def log_error(stage: str, exc: Exception) -> None:
        print(
            f"[ERROR] SMTP {stage}: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )

    if config.smtp_port == 465:
        try:
            server = smtplib.SMTP_SSL(
                config.smtp_host,
                config.smtp_port,
                timeout=30,
                context=context,
            )
        except Exception as exc:
            log_error("connection failed (implicit SSL, port 465)", exc)
            raise RuntimeError(
                f"SMTP connection failed for {config.smtp_host}:{config.smtp_port} using SSL."
            ) from exc

        with server:
            try:
                server.login(config.smtp_user, password)
            except Exception as exc:
                log_error("login failed", exc)
                raise RuntimeError("SMTP login failed; check user/password or app password.") from exc
            try:
                server.send_message(message)
            except Exception as exc:
                log_error("send failed", exc)
                raise RuntimeError("SMTP send failed after login.") from exc
        return

    try:
        server = smtplib.SMTP(config.smtp_host, config.smtp_port, timeout=30)
    except Exception as exc:
        log_error("connection failed (STARTTLS)", exc)
        raise RuntimeError(
            f"SMTP connection failed for {config.smtp_host}:{config.smtp_port} using STARTTLS."
        ) from exc

    with server:
        try:
            server.ehlo()
            server.starttls(context=context)
            server.ehlo()
        except Exception as exc:
            log_error("STARTTLS negotiation failed", exc)
            raise RuntimeError("SMTP STARTTLS negotiation failed.") from exc
        try:
            server.login(config.smtp_user, password)
        except Exception as exc:
            log_error("login failed", exc)
            raise RuntimeError("SMTP login failed; check user/password or app password.") from exc
        try:
            server.send_message(message)
        except Exception as exc:
            log_error("send failed", exc)
            raise RuntimeError("SMTP send failed after login.") from exc


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Send latest daily report email.")
    parser.add_argument("--root", default=str(ROOT_DIR), help="Repository root.")
    parser.add_argument("--state-path", default=str(DEFAULT_STATE_PATH), help="Duplicate-send state path.")
    parser.add_argument("--force", action="store_true", help="Send even when the latest report hash was sent.")
    parser.add_argument("--dry-run", action="store_true", help="Build the message but do not send or write state.")
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    root = Path(args.root).resolve()
    state_path = Path(args.state_path).resolve()
    config = load_email_config()
    if not config.enabled and not args.dry_run:
        print("[INFO] email delivery disabled; skip.")
        return 0
    validate_config(config)
    report = build_daily_report(root, config.site_url)
    state = load_state(state_path)
    if should_skip_duplicate(report, state, args.force):
        print("[INFO] latest report has already been sent; skip.")
        return 0
    message = build_message(config, report)
    if args.dry_run:
        print("[DRY-RUN] email message built.")
        print(f"[DRY-RUN] source={report.source_path}")
        print(f"[DRY-RUN] detail_url={report.detail_url or '<none>'}")
        print(f"[DRY-RUN] text_chars={len(report.text)} html_chars={len(report.html)}")
        return 0
    send_message(config, message)
    save_state(
        state_path,
        {
            "last_report_hash": report.content_hash,
            "last_source": str(report.source_path.relative_to(root)),
            "last_detail_url": report.detail_url,
            "last_sent_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    print(f"[OK] email sent to {config.to_addr}; source={report.source_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
