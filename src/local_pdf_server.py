from __future__ import annotations

import json
import os
import warnings
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from local_pdf_backend import generate_local_pdf_deep_doc

with warnings.catch_warnings():
    warnings.filterwarnings("ignore", category=DeprecationWarning)
    import cgi


ROOT_DIR = Path(__file__).resolve().parents[1]


class LocalPdfHandler(SimpleHTTPRequestHandler):
    server_version = "DPRLocalPdfHTTP/1.0"

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_head(self):
        for header in ("If-Modified-Since", "If-None-Match"):
            if header in self.headers:
                del self.headers[header]
        return super().send_head()

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/api/local-pdf/health":
            self._send_json(200, {"ok": True})
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/api/local-pdf/deep":
            self._send_json(404, {"ok": False, "error": "not_found"})
            return
        try:
            form = cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={
                    "REQUEST_METHOD": "POST",
                    "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                },
            )
            if "pdf" not in form:
                self._send_json(400, {"ok": False, "error": "missing_pdf"})
                return
            item = form["pdf"]
            pdf_bytes = item.file.read()
            filename = item.filename or "local-paper.pdf"
            llm_config = form.getfirst("llm_config", "")
            result = generate_local_pdf_deep_doc(
                pdf_bytes=pdf_bytes,
                filename=filename,
                llm_config_json=llm_config,
                docs_dir=str(ROOT_DIR / "docs"),
            )
            self._send_json(200, result)
        except Exception as exc:
            self._send_json(500, {"ok": False, "error": str(exc)})


def main() -> None:
    host = os.getenv("DPR_LOCAL_PDF_HOST", "0.0.0.0")
    port = int(os.getenv("DPR_LOCAL_PDF_PORT", "8000"))
    os.chdir(ROOT_DIR)
    httpd = ThreadingHTTPServer((host, port), LocalPdfHandler)
    print(f"DPR local PDF server listening on http://{host}:{port}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
