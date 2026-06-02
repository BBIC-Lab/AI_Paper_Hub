import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ReportRuntimePrivacyTest(unittest.TestCase):
    def test_periodic_report_outputs_are_protected_runtime_paths(self):
        sync_script = (ROOT / "scripts" / "sync-origin-to-private.ps1").read_text(encoding="utf-8")
        publish_script = (ROOT / "scripts" / "publish-dual.ps1").read_text(encoding="utf-8")
        privacy_guard = (ROOT / "scripts" / "privacy_guard.py").read_text(encoding="utf-8")

        self.assertIn("generated periodic reports: docs/reports/**", sync_script)
        self.assertIn('"^docs/reports/"', sync_script)
        self.assertGreaterEqual(publish_script.count('"^docs/reports/"'), 2)
        self.assertIn('path.startswith("docs/reports/")', privacy_guard)


if __name__ == "__main__":
    unittest.main()
