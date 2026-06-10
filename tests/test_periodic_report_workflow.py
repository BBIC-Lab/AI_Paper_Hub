import pathlib
import unittest

import yaml


class PeriodicReportWorkflowTest(unittest.TestCase):
    def test_schedule_dispatch_and_commit_scope(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        workflow_path = root / ".github" / "workflows" / "periodic-report.yml"
        text = workflow_path.read_text(encoding="utf-8")
        workflow = yaml.safe_load(text) or {}
        on_block = workflow.get("on") or workflow.get(True) or {}
        schedule = on_block.get("schedule") or []
        inputs = ((on_block.get("workflow_dispatch") or {}).get("inputs")) or {}

        self.assertIn({"cron": "30 23 * * 5"}, schedule)
        self.assertIn({"cron": "30 23 28-31 * *"}, schedule)
        for key in ("period", "start_date", "end_date", "input_mode", "fetch_days", "profile_tag", "dry_run"):
            self.assertIn(key, inputs)
        self.assertEqual(inputs["input_mode"].get("default"), "artifacts")
        self.assertIn("python src/periodic_reports.py", text)
        self.assertIn("python src/main.py", text)
        self.assertIn("paths=(docs/reports docs/_sidebar.md)", text)
        self.assertIn("archive/*/recommend", text)


if __name__ == "__main__":
    unittest.main()
