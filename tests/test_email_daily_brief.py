import importlib.util
import pathlib
import sys
import tempfile
import unittest


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

        self.assertIn("# DPR_EMAIL_SCHEDULE Asia/Shanghai 08:30", text)
        self.assertIn("workflow_dispatch:", text)
        self.assertIn("DPR_EMAIL_TO", text)
        self.assertIn("src/email_daily_brief.py", text)


if __name__ == "__main__":
    unittest.main()
