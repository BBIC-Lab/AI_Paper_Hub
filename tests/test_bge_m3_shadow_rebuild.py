import importlib.util
import pathlib
import sys
import unittest
from unittest.mock import patch


def _load_module(module_name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(module_name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return mod


class BgeM3ShadowRebuildTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = pathlib.Path(__file__).resolve().parents[1]
        cls.root = root
        cls.mod = _load_module(
            "bge_m3_shadow_rebuild_mod",
            root / "src" / "maintain" / "bge_m3_shadow_rebuild.py",
        )

    def test_build_sync_command_targets_shadow_table_and_local_bge_m3(self):
        spec = self.mod.SOURCE_SPECS["arxiv"]
        with patch.object(self.mod, "detect_idle_cuda_devices", return_value=[]):
            cmd = self.mod.build_sync_command(
                python="python3",
                spec=spec,
                raw_dir=self.root / "archive" / "bge_m3_rebuild" / "raw",
                schema="public",
                embed_model="BAAI/bge-m3",
            )
        joined = " ".join(cmd)
        self.assertIn("--papers-table arxiv_papers_bge_m3", joined)
        self.assertIn("--embed-model BAAI/bge-m3", joined)
        self.assertIn("--embed-local-only", cmd)
        self.assertIn("--local-maintain-mode", cmd)
        self.assertIn("--embed-device cpu", joined)

    def test_embedding_device_args_uses_multi_gpu_when_available(self):
        with patch.object(self.mod, "detect_idle_cuda_devices", return_value=["cuda:1", "cuda:0"]):
            args = self.mod.embedding_device_args()
        self.assertEqual(args, ["--embed-devices", "cuda:1,cuda:0"])

    def test_background_command_uses_setsid_and_log_redirection(self):
        cmd = ["python3", "src/maintain/sync.py", "--embed-model", "BAAI/bge-m3"]
        bg = self.mod.build_background_command(cmd, self.root / "logs" / "bge_m3_arxiv.log")
        self.assertIn("setsid bash -lc", bg)
        self.assertIn("BAAI/bge-m3", bg)
        self.assertIn("bge_m3_arxiv.log", bg)
        self.assertTrue(bg.endswith("2>&1 &"))

    def test_build_export_command_outputs_raw_json(self):
        spec = self.mod.SOURCE_SPECS["biorxiv"]
        cmd = self.mod.build_export_command(
            python="python3",
            spec=spec,
            raw_dir=self.root / "archive" / "bge_m3_rebuild" / "raw",
            schema="public",
            page_size=500,
            limit=20,
        )
        joined = " ".join(cmd)
        self.assertIn("--table biorxiv_papers", joined)
        self.assertIn("biorxiv_papers_all.json", joined)
        self.assertIn("--limit 20", joined)


if __name__ == "__main__":
    unittest.main()
