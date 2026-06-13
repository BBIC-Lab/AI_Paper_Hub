import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest


def _load_module(module_name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(module_name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


class SelectPapersSourceTagTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = pathlib.Path(__file__).resolve().parents[1]
        src_dir = root / "src"
        if str(src_dir) not in sys.path:
            sys.path.insert(0, str(src_dir))
        cls.mod = _load_module("select_mod", src_dir / "5.select_papers.py")

    def test_build_candidates_marks_selection_source(self):
        scored = [
            {"id": "fresh-1", "title": "Fresh", "llm_score": 8.2},
            {"id": "fresh-2", "title": "Fresh2", "llm_score": 8.1},
        ]
        carryover = [
            {"id": "carry-1", "title": "Carry", "llm_score": 9.0},
        ]
        out = self.mod.build_candidates(scored, carryover, set())
        source_map = {item.get("id"): item.get("selection_source") for item in out}
        self.assertEqual(source_map.get("fresh-1"), "fresh_fetch")
        self.assertEqual(source_map.get("fresh-2"), "fresh_fetch")
        self.assertEqual(source_map.get("carry-1"), "carryover_cache")

    def test_build_candidates_dedupes_arxiv_versions_by_base_id(self):
        scored = [
            {
                "id": "2605.11710v1",
                "source": "arxiv",
                "title": "Unlocking Compositional Generalization",
                "llm_score": 9.5,
            },
            {
                "id": "2605.11710v2",
                "source": "arxiv",
                "title": "Unlocking Compositional Generalization",
                "llm_score": 6.0,
            },
        ]

        out = self.mod.build_candidates(scored, [], set())

        self.assertEqual([item.get("id") for item in out], ["2605.11710v2"])
        self.assertEqual(out[0].get("selection_source"), "fresh_fetch")

    def test_build_candidates_filters_seen_arxiv_base_id(self):
        scored = [
            {
                "id": "2605.11710v2",
                "source": "arxiv",
                "title": "Unlocking Compositional Generalization",
                "llm_score": 8.0,
            },
        ]

        out = self.mod.build_candidates(scored, [], {"arxiv:2605.11710"})

        self.assertEqual(out, [])

    def test_resolve_carryover_days_uses_separate_window(self):
        self.assertEqual(
            self.mod.resolve_carryover_days({"days_window": 9, "carryover_days": 3}),
            3,
        )
        self.assertEqual(self.mod.resolve_carryover_days({"days_window": 4}), 4)
        self.assertEqual(self.mod.resolve_carryover_days({}), 7)

    def test_build_carryover_out_marks_source(self):
        out = self.mod.build_carryover_out(
            [
                {
                    "id": "p-1",
                    "llm_score": 8.5,
                    "title": "P1",
                    "selection_source": "fresh_fetch",
                },
                {
                    "id": "p-2",
                    "llm_score": 7.9,
                    "title": "P2",
                    "selection_source": "fresh_fetch",
                },
            ],
            set(),
            5,
        )
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0].get("selection_source"), "carryover_cache")
        self.assertEqual(out[0].get("paper_id"), "p-1")

    def test_sanitize_items_keeps_selection_source(self):
        with tempfile.TemporaryDirectory():
            items = [
                {
                    "id": "p-1",
                    "_source": "new",
                    "selection_source": "fresh_fetch",
                }
            ]
            out = self.mod.sanitize_items(items)
            self.assertEqual(len(out), 1)
            self.assertNotIn("_source", out[0])
            self.assertEqual(out[0].get("selection_source"), "fresh_fetch")

    def test_load_recent_carryover_keeps_tag_time_independent(self):
        payload = {
            "generated_at": "2026-03-28T00:00:00+00:00",
            "tag_states": {
                "GENE": {
                    "updated_date": "20260328",
                    "carryover_days": 5,
                    "items": [
                        {
                            "id": "gene-1",
                            "paper_id": "gene-1",
                            "llm_score": 9.1,
                            "matched_query_tag": "query:GENE",
                            "carry_days": 1,
                        }
                    ],
                },
                "AHD": {
                    "updated_date": "20260326",
                    "carryover_days": 5,
                    "items": [
                        {
                            "id": "ahd-1",
                            "paper_id": "ahd-1",
                            "llm_score": 9.2,
                            "matched_query_tag": "query:AHD",
                            "carry_days": 1,
                        }
                    ],
                },
            },
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            path = pathlib.Path(tmpdir) / "carryover.json"
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            items, delta = self.mod.load_recent_carryover(
                str(path),
                self.mod.parse_date_str("20260328"),
                5,
                active_tags=["GENE"],
            )

        self.assertEqual(delta, 0)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], "gene-1")
        self.assertEqual(items[0]["carry_days"], 1)

    def test_build_carryover_payload_updates_only_active_tag(self):
        existing = {
            "generated_at": "2026-03-27T00:00:00+00:00",
            "tag_states": {
                "AHD": {
                    "updated_date": "20260327",
                    "carryover_days": 5,
                    "items": [
                        {
                            "id": "ahd-1",
                            "paper_id": "ahd-1",
                            "llm_score": 9.2,
                            "matched_query_tag": "query:AHD",
                            "carry_days": 2,
                        }
                    ],
                }
            },
        }
        payload = self.mod.build_carryover_payload(
            existing,
            [
                {
                    "id": "gene-1",
                    "paper_id": "gene-1",
                    "llm_score": 9.3,
                    "matched_query_tag": "query:GENE",
                    "llm_tags": ["gene"],
                    "carry_days": 1,
                }
            ],
            active_tags=["GENE"],
            carryover_days=5,
            updated_date="20260328",
        )

        self.assertIn("AHD", payload["tag_states"])
        self.assertIn("GENE", payload["tag_states"])
        self.assertEqual(payload["tag_states"]["AHD"]["updated_date"], "20260327")
        self.assertEqual(payload["tag_states"]["GENE"]["updated_date"], "20260328")
        self.assertEqual(payload["tag_states"]["GENE"]["items"][0]["id"], "gene-1")

    def test_collect_seen_ids_isolated_by_active_tag(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = pathlib.Path(tmpdir)
            recommend_dir = root / "20260327" / "recommend"
            recommend_dir.mkdir(parents=True, exist_ok=True)
            payload = {
                "deep_dive": [
                    {
                        "id": "paper-ahd",
                        "matched_query_tag": "query:AHD",
                    },
                    {
                        "id": "paper-gene",
                        "matched_query_tag": "query:GENE",
                    },
                ],
                "quick_skim": [],
            }
            (recommend_dir / "arxiv_papers_20260327.standard.json").write_text(
                json.dumps(payload, ensure_ascii=False),
                encoding="utf-8",
            )

            seen_gene = self.mod.collect_seen_ids(str(root), "20260328", active_tags=["GENE"])
            seen_ahd = self.mod.collect_seen_ids(str(root), "20260328", active_tags=["AHD"])
            seen_all = self.mod.collect_seen_ids(str(root), "20260328")

        self.assertEqual(seen_gene, {"paper-gene"})
        self.assertEqual(seen_ahd, {"paper-ahd"})
        self.assertEqual(seen_all, {"paper-ahd", "paper-gene"})

    def test_collect_seen_ids_uses_arxiv_base_dedup_key(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = pathlib.Path(tmpdir)
            recommend_dir = root / "20260520" / "recommend"
            recommend_dir.mkdir(parents=True, exist_ok=True)
            payload = {
                "deep_dive": [
                    {
                        "id": "2605.11710v1",
                        "source": "arxiv",
                        "matched_query_tag": "query:GENE",
                    },
                ],
                "quick_skim": [],
            }
            (recommend_dir / "arxiv_papers_20260520.standard.json").write_text(
                json.dumps(payload, ensure_ascii=False),
                encoding="utf-8",
            )

            seen = self.mod.collect_seen_ids(str(root), "20260521", active_tags=["GENE"])

        self.assertEqual(seen, {"arxiv:2605.11710"})


class SelectPapersDeepPriorityModeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = pathlib.Path(__file__).resolve().parents[1]
        src_dir = root / "src"
        if str(src_dir) not in sys.path:
            sys.path.insert(0, str(src_dir))
        cls.mod = _load_module("select_mod", src_dir / "5.select_papers.py")

    def test_process_mode_keeps_all_nine_plus_even_if_over_cap(self):
        candidates = [
            {"id": "p-1", "llm_score": 9.6},
            {"id": "p-2", "llm_score": 9.3},
            {"id": "p-3", "llm_score": 9.1},
            {"id": "p-4", "llm_score": 8.9},
            {"id": "p-5", "llm_score": 8.8},
        ]
        result = self.mod.process_mode(
            candidates=candidates,
            tag_count=1,
            mode="standard",
            cfg={"deep_base": 1, "deep_unlimited": False, "deep_strategy": "round_robin"},
            carryover_ratio=0.5,
        )
        self.assertEqual(result.get("stats", {}).get("deep_selected"), 3)
        deep_ids = [item.get("id") for item in result.get("deep_dive", [])]
        self.assertEqual(deep_ids, ["p-1", "p-2", "p-3"])

    def test_process_mode_nine_plus_full_then_fill_to_cap_with_regular(self):
        candidates = [
            {"id": "p-1", "llm_score": 9.8},
            {"id": "p-2", "llm_score": 8.9},
            {"id": "p-3", "llm_score": 8.7},
            {"id": "p-4", "llm_score": 8.6},
        ]
        result = self.mod.process_mode(
            candidates=candidates,
            tag_count=2,
            mode="standard",
            cfg={"deep_base": 1, "deep_unlimited": False, "deep_strategy": "score"},
            carryover_ratio=0.5,
        )
        self.assertEqual(result.get("stats", {}).get("deep_selected"), 3)
        deep_ids = {item.get("id") for item in result.get("deep_dive", [])}
        self.assertIn("p-1", deep_ids)
        self.assertTrue("p-2" in deep_ids or "p-3" in deep_ids)

    def test_process_mode_nine_plus_only_keeps_original_when_none(self):
        candidates = [
            {"id": "p-1", "llm_score": 8.9},
            {"id": "p-2", "llm_score": 8.6},
            {"id": "p-3", "llm_score": 8.4},
            {"id": "p-4", "llm_score": 7.9},
        ]
        result = self.mod.process_mode(
            candidates=candidates,
            tag_count=2,
            mode="standard",
            cfg={"deep_base": 3, "deep_unlimited": False, "deep_strategy": "score"},
            carryover_ratio=0.5,
        )
        self.assertEqual(result.get("stats", {}).get("deep_selected"), 3)
        deep_scores = [float(item.get("llm_score", 0)) for item in result.get("deep_dive", [])]
        self.assertEqual(deep_scores, sorted(deep_scores, reverse=True))

    def test_process_mode_dedupes_arxiv_versions_in_deep_section(self):
        candidates = [
            {"id": "p-1", "llm_score": 9.1},
            {"id": "2605.12145v1", "source": "arxiv", "llm_score": 9.0},
            {"id": "2605.12145v2", "source": "arxiv", "llm_score": 9.0},
        ]

        result = self.mod.process_mode(
            candidates=candidates,
            tag_count=0,
            mode="standard",
            cfg={"deep_base": 5, "quick_base": 10, "deep_unlimited": False, "deep_strategy": "score"},
            carryover_ratio=0.5,
        )

        deep_ids = [item.get("id") for item in result.get("deep_dive", [])]
        self.assertIn("2605.12145v2", deep_ids)
        self.assertNotIn("2605.12145v1", deep_ids)

    def test_process_mode_dedupes_arxiv_versions_in_quick_section(self):
        candidates = [
            {"id": "2605.11710v1", "source": "arxiv", "llm_score": 6.0},
            {"id": "2605.11710v2", "source": "arxiv", "llm_score": 6.0},
            {"id": "p-quick", "llm_score": 7.0},
        ]

        result = self.mod.process_mode(
            candidates=candidates,
            tag_count=0,
            mode="standard",
            cfg={"deep_base": 0, "quick_base": 10, "deep_unlimited": False, "deep_strategy": "score"},
            carryover_ratio=0.5,
        )

        quick_ids = [item.get("id") for item in result.get("quick_skim", [])]
        self.assertIn("2605.11710v2", quick_ids)
        self.assertNotIn("2605.11710v1", quick_ids)

    def test_profile_daily_limit_caps_deep_and_quick_independently_by_score(self):
        result = {
            "stats": {
                "deep_selected": 2,
                "quick_selected": 2,
            },
            "deep_dive": [
                {"id": "deep-1", "llm_score": 9.4, "matched_query_tag": "query:SR"},
                {"id": "deep-2", "llm_score": 8.8, "matched_query_tag": "query:SR"},
            ],
            "quick_skim": [
                {"id": "quick-low", "llm_score": 7.1, "matched_query_tag": "query:SR"},
                {"id": "quick-high", "llm_score": 7.9, "matched_query_tag": "query:SR"},
            ],
        }

        capped = self.mod.apply_profile_daily_limits(result, {"SR": {"deep": 1, "quick": 1}})

        self.assertEqual([item.get("id") for item in capped.get("deep_dive", [])], ["deep-1"])
        self.assertEqual([item.get("id") for item in capped.get("quick_skim", [])], ["quick-high"])
        self.assertEqual(capped.get("stats", {}).get("profile_limit_dropped"), 2)
        self.assertEqual(capped.get("stats", {}).get("profile_limit_dropped_by_tag"), {"SR": {"deep": 1, "quick": 1}})
        self.assertEqual(capped.get("stats", {}).get("deep_selected"), 1)
        self.assertEqual(capped.get("stats", {}).get("quick_selected"), 1)

    def test_profile_daily_limit_maps_child_tags_to_parent_limit(self):
        result = {
            "stats": {
                "deep_selected": 0,
                "quick_selected": 2,
            },
            "deep_dive": [],
            "quick_skim": [
                {"id": "child-low", "llm_score": 7.1, "matched_query_tag": "query:SR:other"},
                {"id": "child-high", "llm_score": 7.9, "matched_query_tag": "query:SR:composite"},
            ],
        }

        capped = self.mod.apply_profile_daily_limits(result, {"SR": {"deep": 10, "quick": 1}})

        self.assertEqual([item.get("id") for item in capped.get("quick_skim", [])], ["child-high"])
        self.assertEqual(capped.get("stats", {}).get("profile_limit_dropped_by_tag"), {"SR": {"deep": 0, "quick": 1}})
        self.assertEqual(capped.get("stats", {}).get("quick_selected"), 1)

    def test_select_by_recommend_mix_targets_two_to_three(self):
        candidates = [
            {"id": "core-1", "llm_score": 9.5, "relevance_track": "core", "core_relevance_score": 9.5},
            {"id": "core-2", "llm_score": 9.2, "relevance_track": "core", "core_relevance_score": 9.2},
            {"id": "core-3", "llm_score": 9.0, "relevance_track": "core", "core_relevance_score": 9.0},
            {"id": "insp-1", "llm_score": 9.4, "relevance_track": "inspiration", "inspiration_score": 9.4},
            {"id": "insp-2", "llm_score": 9.1, "relevance_track": "inspiration", "inspiration_score": 9.1},
            {"id": "insp-3", "llm_score": 8.9, "relevance_track": "inspiration", "inspiration_score": 8.9},
        ]

        picked = self.mod.select_by_recommend_mix(candidates, 5, {"core_ratio": 2, "inspiration_ratio": 3})
        lanes = [item.get("selection_lane") for item in picked]

        self.assertEqual(lanes.count("core"), 2)
        self.assertEqual(lanes.count("inspiration"), 3)

    def test_select_by_recommend_mix_lets_bridge_compete(self):
        candidates = [
            {"id": "core-1", "llm_score": 9.6, "relevance_track": "core", "core_relevance_score": 9.6},
            {"id": "core-2", "llm_score": 9.2, "relevance_track": "core", "core_relevance_score": 9.2},
            {"id": "insp-1", "llm_score": 9.7, "relevance_track": "inspiration", "inspiration_score": 9.7},
            {"id": "insp-2", "llm_score": 9.4, "relevance_track": "inspiration", "inspiration_score": 9.4},
            {"id": "insp-3", "llm_score": 9.1, "relevance_track": "inspiration", "inspiration_score": 9.1},
            {
                "id": "bridge-1",
                "llm_score": 8.0,
                "relevance_track": "bridge",
                "core_relevance_score": 8.0,
                "inspiration_score": 8.0,
                "rerank_inspiration_score": 0.8,
            },
        ]

        picked = self.mod.select_by_recommend_mix(candidates, 5, {"core_ratio": 2, "inspiration_ratio": 3})
        picked_by_id = {item.get("id"): item for item in picked}

        self.assertIn("bridge-1", picked_by_id)
        self.assertEqual(picked_by_id["bridge-1"].get("selection_lane"), "inspiration")

    def test_select_by_recommend_mix_zero_disables_lane(self):
        candidates = [
            {"id": "core-1", "llm_score": 9.9, "relevance_track": "core", "core_relevance_score": 9.9},
            {"id": "insp-1", "llm_score": 8.8, "relevance_track": "inspiration", "inspiration_score": 8.8},
            {
                "id": "bridge-1",
                "llm_score": 9.0,
                "relevance_track": "bridge",
                "core_relevance_score": 9.0,
                "inspiration_score": 9.0,
            },
        ]

        picked = self.mod.select_by_recommend_mix(candidates, 2, {"core_ratio": 0, "inspiration_ratio": 3})

        self.assertEqual({item.get("selection_lane") for item in picked}, {"inspiration"})
        self.assertNotIn("core-1", [item.get("id") for item in picked])


if __name__ == "__main__":
    unittest.main()
