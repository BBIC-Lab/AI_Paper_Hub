import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import pytest


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from core import artifacts, paths  # noqa: E402


def test_beijing_date_tokens_and_range_resolution():
    now = datetime(2026, 5, 23, 20, 41, 46, tzinfo=timezone.utc)

    assert paths.beijing_today(now).isoformat() == "2026-05-24"
    assert paths.beijing_today_token(now) == "20260524"
    assert paths.resolve_run_date_token(1, now=now) == "20260524"
    assert paths.resolve_run_date_token(10, now=now) == "20260515-20260524"
    assert paths.resolve_run_date_token(
        None,
        days_window="11",
        now=now,
    ) == "20260514-20260524"


def test_dpr_run_date_takes_priority_for_env_helper():
    now = datetime(2026, 5, 23, 20, 41, 46, tzinfo=timezone.utc)

    with patch.dict(os.environ, {"DPR_RUN_DATE": "20260520-20260524"}, clear=True):
        assert paths.run_date_from_env(now=now) == "20260520-20260524"


def test_artifact_paths_are_built_under_archive_dirs(tmp_path):
    token = "20260520-20260524"

    run_paths = paths.run_artifact_paths(tmp_path, token, recommend_mode="fast")

    assert paths.archive_dir(tmp_path, token) == tmp_path / "archive" / token
    assert paths.raw_dir(tmp_path, token) == tmp_path / "archive" / token / "raw"
    assert paths.filtered_dir(tmp_path, token) == tmp_path / "archive" / token / "filtered"
    assert paths.rank_dir(tmp_path, token) == tmp_path / "archive" / token / "rank"
    assert paths.recommend_dir(tmp_path, token) == tmp_path / "archive" / token / "recommend"
    assert paths.carryover_path(tmp_path) == tmp_path / "archive" / "carryover.json"

    assert run_paths.archive == tmp_path / "archive" / token
    assert run_paths.raw == tmp_path / "archive" / token / "raw" / f"arxiv_papers_{token}.json"
    assert run_paths.bm25 == tmp_path / "archive" / token / "filtered" / f"arxiv_papers_{token}.bm25.json"
    assert run_paths.embedding == tmp_path / "archive" / token / "filtered" / f"arxiv_papers_{token}.embedding.json"
    assert run_paths.rrf == tmp_path / "archive" / token / "filtered" / f"arxiv_papers_{token}.json"
    assert run_paths.rerank == tmp_path / "archive" / token / "rank" / f"arxiv_papers_{token}.json"
    assert run_paths.llm == tmp_path / "archive" / token / "rank" / f"arxiv_papers_{token}.llm.json"
    assert run_paths.recommend == tmp_path / "archive" / token / "recommend" / f"arxiv_papers_{token}.fast.json"


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        ("20260524", "2026-05-24"),
        ("20260520-20260524", "2026-05-24"),
    ],
)
def test_parse_run_date_token_accepts_single_day_and_range(token, expected):
    assert paths.parse_run_date_token(token).isoformat() == expected


def test_list_archive_date_dirs_only_returns_date_named_directories(tmp_path):
    for name in ("20260524", "20260520-20260524", "raw", "2026052", "202605240"):
        (tmp_path / name).mkdir()
    (tmp_path / "20260525").write_text("not a directory", encoding="utf-8")

    assert paths.list_archive_date_dirs(tmp_path) == ["20260520-20260524", "20260524"]
    assert paths.list_archive_date_dirs(tmp_path / "missing") == []


def test_paper_artifact_filename_requires_token_and_adds_variant_suffix():
    assert artifacts.paper_artifact_filename("20260524") == "arxiv_papers_20260524.json"
    assert (
        artifacts.paper_artifact_filename(" 20260520-20260524 ", " llm ")
        == "arxiv_papers_20260520-20260524.llm.json"
    )

    with pytest.raises(ValueError, match="run_date_token is required"):
        artifacts.paper_artifact_filename(" ")


def test_write_json_and_read_json_helpers_round_trip_objects(tmp_path):
    path = tmp_path / "nested" / "payload.json"
    payload = {"papers": [{"id": "p1", "title": "测试"}], "queries": []}

    artifacts.write_json(path, payload)

    assert json.loads(path.read_text(encoding="utf-8")) == payload
    assert artifacts.read_json_object(path) == payload
    assert artifacts.read_json_safe(path) == payload


def test_read_json_object_errors_and_read_json_safe_default(tmp_path):
    missing = tmp_path / "missing.json"
    errors = []

    with pytest.raises(FileNotFoundError, match="custom missing"):
        artifacts.read_json_object(missing, missing_message="custom missing")

    assert artifacts.read_json_safe(missing, default={"fallback": True}, on_error=errors.append) == {
        "fallback": True
    }
    assert isinstance(errors[0], FileNotFoundError)

    list_path = tmp_path / "list.json"
    artifacts.write_json(list_path, [1, 2, 3])

    with pytest.raises(ValueError, match="JSON artifact must be an object"):
        artifacts.read_json_object(list_path)


def test_validate_recall_payload_reports_shape_errors():
    assert artifacts.validate_recall_payload({"papers": [], "queries": []}) == []
    assert artifacts.validate_recall_payload(["not", "object"]) == ["payload must be an object"]
    assert artifacts.validate_recall_payload({"papers": {}, "queries": "bad"}) == [
        "papers must be a list",
        "queries must be a list",
    ]


def test_validate_recommendation_payload_reports_shape_errors():
    assert artifacts.validate_recommendation_payload(
        {"deep_dive": [], "quick_skim": [], "stats": {}}
    ) == []
    assert artifacts.validate_recommendation_payload(None) == ["payload must be an object"]
    assert artifacts.validate_recommendation_payload(
        {"deep_dive": {}, "quick_skim": "bad", "stats": []}
    ) == [
        "deep_dive must be a list",
        "quick_skim must be a list",
        "stats must be an object",
    ]
