import contextlib
import importlib.util
import io
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


def _load_module():
    root = pathlib.Path(__file__).resolve().parents[1]
    path = root / "src" / "email_daily_brief.py"
    spec = importlib.util.spec_from_file_location("email_daily_brief_mod", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


class EmailDailyBriefTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_module()

    def test_build_daily_report_uses_latest_readme_and_docsify_link(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            docs = root / "docs"
            docs.mkdir()
            (docs / "README.md").write_text(
                "\n".join(
                    [
                        "# 最新日报",
                        "",
                        "### 今日简报（AI）",
                        "今天推荐了 3 篇论文。",
                        "- 详情：[/202605/25/README](/202605/25/README)",
                    ]
                ),
                encoding="utf-8",
            )

            report = self.mod.build_daily_report(
                root,
                "https://example.github.io/AI_Daily_Paper_Reader",
            )

            self.assertIn("今天推荐了 3 篇论文。", report.text)
            self.assertEqual(
                report.detail_url,
                "https://example.github.io/AI_Daily_Paper_Reader/#/202605/25/README",
            )
            self.assertIn(report.detail_url, report.text)
            self.assertIn(report.detail_url, report.html)

    def test_duplicate_state_skips_same_report_hash(self):
        report = self.mod.DailyReport(
            markdown="m",
            text="t",
            html="<p>t</p>",
            detail_url="",
            source_path=pathlib.Path("docs/README.md"),
            content_hash="abc",
        )
        self.assertTrue(
            self.mod.should_skip_duplicate(report, {"last_report_hash": "abc"}, False)
        )
        self.assertFalse(
            self.mod.should_skip_duplicate(report, {"last_report_hash": "abc"}, True)
        )

    def test_email_workflow_exposes_schedule_marker_and_secrets(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        text = (root / ".github" / "workflows" / "email-daily-brief.yml").read_text(
            encoding="utf-8"
        )

        self.assertIn("# DPR_EMAIL_SCHEDULE", text)
        self.assertIn("workflow_dispatch:", text)
        self.assertIn("DPR_EMAIL_TO", text)
        self.assertIn("src/email_daily_brief.py", text)

    def build_config(self, port):
        return self.mod.EmailConfig(
            enabled=True,
            to_addr="to@example.com",
            from_addr="from@example.com",
            smtp_host="smtp.qq.com",
            smtp_port=port,
            smtp_user="from@example.com",
            smtp_password="secret",
            site_url="",
        )

    def build_message(self):
        msg = self.mod.EmailMessage()
        msg["From"] = "from@example.com"
        msg["To"] = "to@example.com"
        msg["Subject"] = "test"
        msg.set_content("hello")
        return msg

    def test_send_message_uses_ssl_for_port_465(self):
        server = mock.Mock()
        server.__enter__ = mock.Mock(return_value=server)
        server.__exit__ = mock.Mock(return_value=None)
        context = object()

        with mock.patch.object(self.mod.ssl, "create_default_context", return_value=context), \
             mock.patch.object(self.mod.smtplib, "SMTP_SSL", return_value=server) as smtp_ssl, \
             mock.patch.object(self.mod.smtplib, "SMTP") as smtp:
            self.mod.send_message(self.build_config(465), self.build_message())

        smtp_ssl.assert_called_once_with(
            "smtp.qq.com",
            465,
            timeout=30,
            context=context,
        )
        smtp.assert_not_called()
        server.login.assert_called_once_with("from@example.com", "secret")
        server.send_message.assert_called_once()

    def test_send_message_uses_starttls_for_port_587(self):
        server = mock.Mock()
        server.__enter__ = mock.Mock(return_value=server)
        server.__exit__ = mock.Mock(return_value=None)
        context = object()

        with mock.patch.object(self.mod.ssl, "create_default_context", return_value=context), \
             mock.patch.object(self.mod.smtplib, "SMTP", return_value=server) as smtp, \
             mock.patch.object(self.mod.smtplib, "SMTP_SSL") as smtp_ssl:
            self.mod.send_message(self.build_config(587), self.build_message())

        smtp.assert_called_once_with("smtp.qq.com", 587, timeout=30)
        smtp_ssl.assert_not_called()
        server.starttls.assert_called_once_with(context=context)
        self.assertEqual(server.ehlo.call_count, 2)
        server.login.assert_called_once_with("from@example.com", "secret")
        server.send_message.assert_called_once()

    def test_send_message_reports_login_failure(self):
        server = mock.Mock()
        server.__enter__ = mock.Mock(return_value=server)
        server.__exit__ = mock.Mock(return_value=None)
        server.login.side_effect = self.mod.smtplib.SMTPAuthenticationError(
            535,
            b"auth failed",
        )
        stderr = io.StringIO()

        with mock.patch.object(self.mod.smtplib, "SMTP_SSL", return_value=server), \
             contextlib.redirect_stderr(stderr):
            with self.assertRaisesRegex(RuntimeError, "SMTP login failed"):
                self.mod.send_message(self.build_config(465), self.build_message())

        self.assertIn("SMTP login failed", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
