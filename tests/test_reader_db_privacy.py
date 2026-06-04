from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_reader_db_runtime_paths_are_protected():
    publish_script = (ROOT / "scripts" / "publish-dual.ps1").read_text(encoding="utf-8")
    sync_script = (ROOT / "scripts" / "sync-origin-to-private.ps1").read_text(encoding="utf-8")
    privacy_guard = (ROOT / "scripts" / "privacy_guard.py").read_text(encoding="utf-8")

    assert '"^docs/reader-db/"' in publish_script
    assert publish_script.count('"^docs/reader-db/"') >= 2
    assert "personal reader database: docs/reader-db/**" in sync_script
    assert '"^docs/reader-db/"' in sync_script
    assert 'path.startswith("docs/reader-db/")' in privacy_guard
    assert 'not path.endswith(".enc.json")' in privacy_guard
