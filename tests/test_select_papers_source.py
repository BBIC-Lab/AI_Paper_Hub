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


class SelectPapersUnifiedSplitModeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = pathlib.Path(__file__).resolve().parents[1]
        src_dir = root / "src"
        if str(src_dir) not in sys.path:
            sys.path.insert(0, str(src_dir))
        cls.mod = _load_module("select_mod", src_dir / "5.select_papers.py")

    def test_process_mode_splits_unified_rank_into_deep_then_quick(self):
        candidates = [
            {"id": "core-top", "llm_score": 9.8, "relevance_track": "core", "source": "biorxiv"},
            {"id": "insp-second", "llm_score": 9.7, "relevance_track": "inspiration", "source": "arxiv"},
            {"id": "carry-third", "llm_score": 9.6, "relevance_track": "core", "selection_source": "carryover_cache"},
            {"id": "core-fourth", "llm_score": 9.5, "relevance_track": "core", "source": "medrxiv"},
            {"id": "insp-fifth", "llm_score": 9.4, "relevance_track": "inspiration", "source": "arxiv"},
        ]
        result = self.mod.process_mode(
            candidates=candidates,
            tag_count=0,
            mode="standard",
            cfg={"deep_base": 2, "quick_base": 3, "deep_unlimited": False, "deep_strategy": "round_robin"},
            carryover_ratio=0.5,
            profile_recommend_mix={"SR": {"core_ratio": 0, "inspiration_ratio": 3}},
        )
        deep_ids = [item.get("id") for item in result.get("deep_dive", [])]
        quick_ids = [item.get("id") for item in result.get("quick_skim", [])]
        all_ids = deep_ids + quick_ids
        self.assertEqual(deep_ids, ["core-top", "insp-second"])
        self.assertEqual(quick_ids, ["carry-third", "core-fourth", "insp-fifth"])
        self.assertEqual(len(all_ids), len(set(all_ids)))
        self.assertEqual(result.get("stats", {}).get("selection_strategy"), "unified_rank_slice")

    def test_process_mode_deep_takes_top_cap_by_unified_rank(self):
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
        deep_ids = [item.get("id") for item in result.get("deep_dive", [])]
        self.assertEqual(deep_ids, ["p-1", "p-2", "p-3"])

    def test_all_quick_mode_keeps_full_candidate_diagnostics_snapshot(self):
        result = self.mod.process_mode(
            candidates=[
                {"id": "picked", "llm_score": 8.5, "selection_score": 8.5},
                {"id": "below-threshold", "llm_score": 7.5, "selection_score": 7.5},
            ],
            tag_count=0,
            mode="standard",
            cfg={"all_quick_min_score": 8.0},
            carryover_ratio=0.5,
        )

        self.assertEqual([item.get("id") for item in result.get("quick_skim", [])], ["picked"])
        self.assertEqual([item.get("id") for item in result.get("papers", [])], ["picked", "below-threshold"])
        below = next(item for item in result.get("papers", []) if item.get("id") == "below-threshold")
        self.assertEqual(
            below.get("diagnostics", {}).get("stage_ranks", {}).get("selection", {}).get("selected"),
            False,
        )

    def test_process_mode_outputs_comparable_pipeline_diagnostics(self):
        stage_ranks = {
            "bm25": {"rank": 5, "score": 0.12},
            "embedding": {"rank": 3, "score": 0.82},
            "rrf": {"rank": 2, "score": 0.03},
            "rerank": {"rank": 1, "score": 0.91},
            "llm": {"rank": 1, "score": 8.8},
        }
        result = self.mod.process_mode(
            candidates=[
                {
                    "id": "diag-paper",
                    "llm_score": 8.8,
                    "selection_score": 8.8,
                    "diagnostics": {"stage_ranks": dict(stage_ranks)},
                }
            ],
            tag_count=0,
            mode="standard",
            cfg={"deep_base": 1, "quick_base": 0, "deep_unlimited": False, "deep_strategy": "score"},
            carryover_ratio=0.5,
        )

        paper = result["papers"][0]
        stages = paper["diagnostics"]["stage_ranks"]
        for stage in ("bm25", "embedding", "rrf", "rerank", "llm", "selection"):
            self.assertIn(stage, stages)
            self.assertIn("rank", stages[stage])
            self.assertIn("score", stages[stage])
        self.assertEqual(stages["selection"]["selected"], True)
        self.assertEqual(result["stats"]["diagnostics_stage_coverage"]["llm"]["present"], 1)
        self.mod.validate_recommend_payload(result, output_path="recommend.json")

    def test_validate_recommend_payload_rejects_missing_candidate_snapshot(self):
        with self.assertRaisesRegex(RuntimeError, "papers"):
            self.mod.validate_recommend_payload(
                {"deep_dive": [{"id": "selected", "llm_score": 9.0}], "quick_skim": []},
                output_path="recommend.json",
            )

    def test_process_mode_downgrades_narrow_inspiration_and_backfills_deep(self):
        candidates = [
            {
                "id": "narrow-app",
                "llm_score": 9.9,
                "relevance_track": "inspiration",
                "inspiration_score": 9.9,
                "method_substance_score": 8.0,
                "domain_breadth_score": 4.0,
                "transfer_specificity_score": 8.0,
            },
            {
                "id": "broad-method",
                "llm_score": 9.1,
                "relevance_track": "inspiration",
                "inspiration_score": 9.1,
                "method_substance_score": 8.0,
                "domain_breadth_score": 8.0,
                "transfer_specificity_score": 8.0,
            },
            {
                "id": "second-broad",
                "llm_score": 8.8,
                "relevance_track": "inspiration",
                "inspiration_score": 8.8,
                "method_substance_score": 7.5,
                "domain_breadth_score": 7.5,
                "transfer_specificity_score": 7.0,
            },
        ]

        result = self.mod.process_mode(
            candidates=candidates,
            tag_count=0,
            mode="standard",
            cfg={"deep_base": 2, "quick_base": 2, "deep_unlimited": False, "deep_strategy": "score"},
            carryover_ratio=0.5,
        )

        deep_ids = [item.get("id") for item in result.get("deep_dive", [])]
        quick_ids = [item.get("id") for item in result.get("quick_skim", [])]
        self.assertEqual(deep_ids, ["broad-method", "second-broad"])
        self.assertIn("narrow-app", quick_ids)
        narrow = next(item for item in result.get("papers", []) if item.get("id") == "narrow-app")
        self.assertEqual(narrow.get("selection_downgrade_reason"), "general_method_quality_below_threshold")
        selection_diag = narrow.get("diagnostics", {}).get("stage_ranks", {}).get("selection", {})
        self.assertEqual(
            selection_diag.get("selected"),
            True,
        )
        self.assertEqual(selection_diag.get("section"), "quick")
        self.assertEqual(result.get("stats", {}).get("deep_quality_downgraded"), 1)

    def test_process_mode_downgrades_weak_bridge_quality(self):
        candidates = [
            {
                "id": "weak-bridge",
                "llm_score": 9.8,
                "relevance_track": "bridge",
                "core_relevance_score": 9.8,
                "inspiration_score": 9.8,
                "method_substance_score": 8.0,
                "domain_breadth_score": 8.0,
                "transfer_specificity_score": 5.0,
            },
            {"id": "core-fill", "llm_score": 8.0, "relevance_track": "core", "core_relevance_score": 8.0},
        ]

        result = self.mod.process_mode(
            candidates=candidates,
            tag_count=0,
            mode="standard",
            cfg={"deep_base": 1, "quick_base": 2, "deep_unlimited": False, "deep_strategy": "score"},
            carryover_ratio=0.5,
        )

        self.assertEqual([item.get("id") for item in result.get("deep_dive", [])], ["core-fill"])
        weak = next(item for item in result.get("papers", []) if item.get("id") == "weak-bridge")
        self.assertEqual(weak.get("selection_downgrade_reason"), "bridge_quality_below_threshold")

    def test_process_mode_deep_can_include_lower_scores_when_cap_allows(self):
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
        self.assertEqual(result.get("stats", {}).get("deep_selected"), 4)
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

    def test_profile_daily_limit_uses_score_not_recommend_mix_lane(self):
        result = {
            "stats": {
                "deep_selected": 2,
                "quick_selected": 0,
            },
            "deep_dive": [
                {"id": "insp-high", "llm_score": 9.5, "relevance_track": "inspiration", "matched_query_tag": "query:SR"},
                {"id": "core-low", "llm_score": 8.1, "relevance_track": "core", "matched_query_tag": "query:SR"},
            ],
            "quick_skim": [],
        }

        capped = self.mod.apply_profile_daily_limits(
            result,
            {"SR": {"deep": 1, "quick": 10}},
            {"SR": {"core_ratio": 1, "inspiration_ratio": 0}},
        )

        self.assertEqual([item.get("id") for item in capped.get("deep_dive", [])], ["insp-high"])

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
                "llm_score": 8.7,
                "relevance_track": "bridge",
                "core_relevance_score": 8.7,
                "inspiration_score": 8.7,
                "rerank_inspiration_score": 0.8,
                "rerank_inspiration_rank": 1,
            },
        ]

        picked = self.mod.select_by_recommend_mix(candidates, 5, {"core_ratio": 2, "inspiration_ratio": 3})
        picked_by_id = {item.get("id"): item for item in picked}

        self.assertIn("bridge-1", picked_by_id)
        self.assertEqual(picked_by_id["bridge-1"].get("selection_lane"), "inspiration")

    def test_select_by_recommend_mix_does_not_let_tail_rerank_override_llm(self):
        candidates = [
            {
                "id": "strong",
                "llm_score": 8.0,
                "relevance_track": "core",
                "core_relevance_score": 8.0,
            },
            {
                "id": "tail-rerank",
                "llm_score": 7.0,
                "relevance_track": "core",
                "core_relevance_score": 7.0,
                "rerank_core_score": 1.0,
                "rerank_core_rank": 60,
            },
        ]

        picked = self.mod.select_by_recommend_mix(candidates, 1, {"core_ratio": 1, "inspiration_ratio": 0})

        self.assertEqual([item.get("id") for item in picked], ["strong"])

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
