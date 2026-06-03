import importlib.util
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


def _load_module():
    root = Path(__file__).resolve().parents[1]
    src_dir = root / "src"
    if str(src_dir) not in sys.path:
        sys.path.insert(0, str(src_dir))
    src_path = src_dir / "periodic_reports.py"
    spec = importlib.util.spec_from_file_location("periodic_reports_mod", src_path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class PeriodicReportsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_module()

    def _write_recommend(self, root: Path, token: str, payload: dict) -> Path:
        path = root / "archive" / token / "recommend" / f"arxiv_papers_{token}.standard.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return path

    def test_resolve_weekly_and_monthly_windows_in_beijing_time(self):
        now = datetime(2026, 5, 31, 4, 0, 0, tzinfo=timezone.utc)

        weekly = self.mod.resolve_period_window("weekly", now=now)
        monthly = self.mod.resolve_period_window("monthly", now=now)

        self.assertEqual(weekly.key, "2026-W22")
        self.assertEqual(str(weekly.start), "2026-05-25")
        self.assertEqual(str(weekly.end), "2026-05-31")
        self.assertEqual(monthly.key, "2026-05")
        self.assertEqual(str(monthly.start), "2026-05-01")
        self.assertEqual(str(monthly.end), "2026-05-31")

    def test_collect_papers_discovers_artifacts_and_enriches_from_meta_without_readme(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            docs = root / "docs"
            meta_dir = docs / "202605" / "25"
            meta_dir.mkdir(parents=True)
            (meta_dir / "README.md").write_text("this should not be parsed", encoding="utf-8")
            (meta_dir / "papers.meta.json").write_text(
                json.dumps(
                    {
                        "papers": [
                            {
                                "paper_id": "202605/25/2505.00001-demo-paper",
                                "title_en": "Demo Paper",
                                "score": "8.7",
                                "tags": "query:agents, paper:benchmark",
                                "evidence": "useful evidence",
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            self._write_recommend(
                root,
                "20260525",
                {
                    "deep_dive": [
                        {
                            "id": "2505.00001v2",
                            "title": "Demo Paper",
                            "abstract": "A demo abstract",
                            "llm_score": 8.7,
                            "source": "arxiv",
                        }
                    ],
                    "quick_skim": [],
                },
            )
            window = self.mod.resolve_period_window("weekly", "2026-05-25", "2026-05-31")

            papers, artifacts, stats = self.mod.collect_papers(root, docs, window, 20, {}, "")

            self.assertEqual(len(artifacts), 1)
            self.assertEqual(stats["raw_records"], 1)
            self.assertEqual(len(papers), 1)
            self.assertEqual(papers[0]["href"], "#/202605/25/2505.00001-demo-paper")
            self.assertEqual([t["label"] for t in papers[0]["tags"]], ["agents", "benchmark"])

    def test_collect_papers_backfills_title_zh_from_markdown_front_matter(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            docs = root / "docs"
            meta_dir = docs / "202605" / "25"
            meta_dir.mkdir(parents=True)
            paper_id = "202605/25/2505.00002-title-demo"
            (docs / f"{paper_id}.md").write_text(
                "\n".join(
                    [
                        "---",
                        "title: Title Demo",
                        "title_zh: 中文标题回填",
                        "---",
                    ]
                ),
                encoding="utf-8",
            )
            (meta_dir / "papers.meta.json").write_text(
                json.dumps(
                    {
                        "papers": [
                            {
                                "paper_id": paper_id,
                                "title_en": "Title Demo",
                                "score": "8.7",
                                "tags": "paper:benchmark",
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            self._write_recommend(
                root,
                "20260525",
                {"deep_dive": [{"id": "2505.00002v1", "title": "Title Demo", "llm_score": 8.7}], "quick_skim": []},
            )
            window = self.mod.resolve_period_window("weekly", "2026-05-25", "2026-05-31")

            papers, _artifacts, _stats = self.mod.collect_papers(root, docs, window, 20, {}, "")

            self.assertEqual(papers[0]["title_zh"], "中文标题回填")

    def test_dedupe_prefers_deep_and_arxiv_base_id(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            docs = root / "docs"
            docs.mkdir()
            self._write_recommend(
                root,
                "20260525",
                {
                    "deep_dive": [
                        {"id": "2505.12345v1", "title": "Same Arxiv", "llm_score": 8.5, "tags": ["query:rl"]}
                    ],
                    "quick_skim": [
                        {"id": "2505.12345v2", "title": "Same Arxiv Updated", "llm_score": 9.2, "tags": ["query:rl"]}
                    ],
                },
            )
            window = self.mod.resolve_period_window("weekly", "2026-05-25", "2026-05-31")

            papers, _artifacts, stats = self.mod.collect_papers(root, docs, window, 20, {}, "")

            self.assertEqual(stats["duplicates_removed"], 1)
            self.assertEqual(len(papers), 1)
            self.assertEqual(papers[0]["section"], "deep")
            self.assertEqual(papers[0]["dedupe_key"], "arxiv:2505.12345")

    def test_metrics_and_report_outputs_include_charts_and_sidebar(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            docs = root / "docs"
            docs.mkdir()
            (docs / "_sidebar.md").write_text("* 首页\n* Daily Papers\n", encoding="utf-8")
            self._write_recommend(
                root,
                "20260526",
                {
                    "deep_dive": [
                        {
                            "id": "p1",
                            "title": "Agent Trends for Tool Use",
                            "title_zh": "工具使用智能体趋势",
                            "llm_score": 9.0,
                            "source": "arxiv",
                            "tags": ["query:agents", "paper:tool use"],
                            "evidence": "agent memory improves tool using workflows",
                        }
                    ],
                    "quick_skim": [
                        {
                            "id": "p2",
                            "title": "Benchmark Trends for Biomedical RAG",
                            "title_zh": "生物医学 RAG 基准趋势",
                            "llm_score": 7.2,
                            "source": "biorxiv",
                            "tags": ["paper:benchmark"],
                            "abstract": "retrieval augmented generation evaluation benchmark for biomedical literature",
                        }
                    ],
                },
            )
            window = self.mod.resolve_period_window("weekly", "2026-05-25", "2026-05-31")
            papers, artifacts, stats = self.mod.collect_papers(root, docs, window, 20, {}, "")
            metrics = self.mod.build_metrics(papers, artifacts, window, 10, stats, {})
            interpretation = self.mod.build_fallback_interpretation(window, metrics, papers)
            result = self.mod.write_report(
                docs,
                window,
                "artifacts",
                metrics,
                papers,
                artifacts,
                interpretation,
                "hash",
            )

            readme = Path(result["readme"]).read_text(encoding="utf-8")
            meta = json.loads(Path(result["meta"]).read_text(encoding="utf-8"))
            sidebar = (docs / "_sidebar.md").read_text(encoding="utf-8")
            weekly_index = (docs / "reports" / "weekly" / "README.md").read_text(encoding="utf-8")
            monthly_index = (docs / "reports" / "monthly" / "README.md").read_text(encoding="utf-8")

            self.assertIn("dpr-periodic-report", readme)
            self.assertIn("dpr-periodic-weekly-v5", readme)
            self.assertIn("本周小结", readme)
            self.assertIn("相关主题", readme)
            self.assertNotIn("本期重点", readme)
            self.assertNotIn("关注主题", readme)
            self.assertNotIn("其他主题", readme)
            self.assertIn("代表论文 2 篇", readme)
            self.assertIn("样本论文 2 篇", readme)
            self.assertIn("dpr-weekly-hero-chip-row is-primary", readme)
            self.assertNotIn("dpr-weekly-hero-chip-row is-topic", readme)
            self.assertIn("词频云", readme)
            self.assertNotIn("主题雷达", readme)
            self.assertIn("主题共现", readme)
            self.assertIn("周一", readme)
            self.assertIn("周五", readme)
            self.assertIn("dpr-weekly-evidence-strip", readme)
            self.assertIn('class="dpr-weekly-evidence-toggle"', readme)
            self.assertIn('class="dpr-weekly-evidence-count"', readme)
            self.assertIn("上一周报", readme)
            self.assertIn("下一周报", readme)
            self.assertIn("dpr-weekly-nav-arrow", readme)
            self.assertIn("⬅", readme)
            self.assertIn("➡", readme)
            self.assertNotIn("<details", readme)
            self.assertNotIn("基于日报 artifact", readme)
            self.assertNotIn("外溢", readme)
            self.assertNotIn("必读候选", readme)
            self.assertNotIn("统计窗口：", readme)
            self.assertNotIn("默认收起以减少首屏占用", readme)
            self.assertNotIn("阅读路线", readme)
            self.assertNotIn("来源分布 Source Mix", readme)
            self.assertNotIn("分数分布", readme)
            self.assertNotIn("精读 / 速读", readme)
            self.assertNotIn("时间分布", readme)
            self.assertEqual(meta["metrics"]["coverage"]["unique_papers"], 2)
            self.assertEqual(len(meta["evidence_index"]), 2)
            self.assertTrue(meta["weekly_summary"])
            self.assertIn("agents", [item["label"] for item in meta["related_topics"]])
            self.assertIn("agents", [item["label"] for item in meta["focus_topics"]])
            self.assertNotIn("Other", [item["label"] for item in meta["context_topics"]])
            self.assertIn("研究周报", sidebar)
            self.assertIn("#/reports/weekly/README", sidebar)
            self.assertIn("#/reports/monthly/README", sidebar)
            self.assertNotIn("#/reports/weekly/2026-W22/README", sidebar)
            self.assertIn("#/reports/weekly/2026-W22/README", weekly_index)
            self.assertNotIn("篇去重样本", weekly_index)
            self.assertNotIn("周期报告入口页", weekly_index)
            self.assertIn("dpr-periodic-index-mini-cloud", weekly_index)
            self.assertIn("研究月报", monthly_index)

    def test_weekly_v2_chart_markup_uses_cloud_bundle_and_single_heatmap_scale(self):
        words = [
            {"label": "agents", "count": 9},
            {"label": "benchmark", "count": 5},
            {"label": "retrieval", "count": 3},
        ]
        laid_out = self.mod.layout_word_cloud(words)
        self.assertGreaterEqual(len(laid_out), 3)
        self.assertEqual(laid_out[0]["label"], "agents")
        self.assertLess(abs(laid_out[0]["x"] - 450), 1)
        self.assertLess(abs(laid_out[0]["y"] - 210), 1)
        self.assertGreater(laid_out[0]["font_size"], laid_out[-1]["font_size"])

        cloud_html = self.mod.word_cloud_html(words)
        self.assertIn("<svg", cloud_html)
        self.assertIn('viewBox="0 0 900 420"', cloud_html)
        self.assertIn('preserveAspectRatio="xMidYMid meet"', cloud_html)
        self.assertIn("dominant-baseline", cloud_html)
        self.assertNotIn("<span", cloud_html)
        self.assertNotIn("dpr-weekly-word-cloud-glow", cloud_html)
        self.assertNotIn("<ellipse", cloud_html)
        self.assertNotIn("scale(1.34)", cloud_html)
        mini_cloud = self.mod.mini_word_cloud_html(words)
        self.assertNotIn("scale(1.34)", mini_cloud)

        network_html = self.mod.cooccurrence_html(
            [
                {"source": "agents", "target": "benchmark", "count": 2},
                {"source": "agents", "target": "retrieval", "count": 1},
            ]
        )
        self.assertIn("dpr-weekly-chord", network_html)
        self.assertIn("linearGradient", network_html)
        self.assertIn('stroke-opacity="', network_html)
        self.assertIn("dpr-weekly-chord-layout", network_html)
        self.assertIn("dpr-weekly-chord-table", network_html)
        self.assertNotIn("相关主题</strong>", network_html)
        self.assertLess(network_html.index("2 篇"), network_html.index("1 篇"))
        self.assertIn("dpr-weekly-chord-ribbon", network_html)
        self.assertIn("dpr-weekly-chord-arc", network_html)
        self.assertNotIn("network-core", network_html)
        self.assertIn("agents", network_html)
        self.assertIn("benchmark", network_html)

        points = [
            {"weekday": label, "date": f"2026-05-{day:02d}", "count": 1}
            for label, day in zip(["周一", "周二", "周三", "周四", "周五"], range(25, 30))
        ]
        heat_html = self.mod.weekday_heatmap_html(
            [
                {"topic": "agents", "kind": "focus", "points": points},
                {"topic": "retrieval", "kind": "context", "points": points},
            ]
        )
        self.assertNotIn("is-context", heat_html)
        self.assertNotIn("is-focus", heat_html)
        self.assertIn("dpr-weekly-heat-cells", heat_html)
        self.assertEqual(heat_html.count("dpr-weekly-heat-cells"), 3)
        for label in ["周一", "周二", "周三", "周四", "周五"]:
            self.assertIn(label, heat_html)
        self.assertEqual(heat_html.count("dpr-periodic-heat-cell"), 10)
        css = (Path(__file__).resolve().parents[1] / "app" / "app.css").read_text(encoding="utf-8").replace("\r\n", "\n")
        self.assertIn(
            ".dpr-weekly-heat-head,\n"
            ".dpr-weekly-heat-row {\n"
            "  display: grid;\n"
            "  grid-template-columns: minmax(0, 40%) minmax(0, 60%);",
            css,
        )
        self.assertIn(".dpr-weekly-heat-cells {\n  display: grid;", css)
        self.assertIn("  grid-template-columns: repeat(5, minmax(0, 1fr));", css)
        self.assertNotIn(".dpr-weekly-heat-row.is-context .dpr-periodic-heat-cell.level", css)

        many_heat_html = self.mod.weekday_heatmap_html(
            [{"topic": f"topic-{idx}", "kind": "focus", "points": points} for idx in range(13)]
        )
        self.assertEqual(many_heat_html.count("dpr-weekly-heat-row"), 10)
        self.assertIn("topic-9", many_heat_html)
        self.assertNotIn("topic-10", many_heat_html)

        completed = self.mod.complete_weekday_topic_timeline(
            [{"topic": "agents", "kind": "focus", "points": points}],
            [
                {"label": "agents", "count": 7},
                {"label": "retrieval", "count": 5},
                {"label": "reasoning", "count": 4},
            ],
            [
                {"label": "benchmark", "count": 6},
                {"label": "multimodal", "count": 4},
                {"label": "systems", "count": 3},
            ],
            self.mod.resolve_period_window("weekly", "2026-05-25", "2026-05-31"),
        )
        self.assertEqual(
            [row["topic"] for row in completed[:6]],
            ["agents", "retrieval", "reasoning", "benchmark", "multimodal", "systems"],
        )

    def test_word_cloud_filters_runtime_source_and_generic_words(self):
        papers = [
            {
                "paper_id": "p1",
                "title": "Retrieval augmented agents",
                "abstract": "They often compare with existing methods, but retrieval remains useful.",
                "evidence": "Existing baselines are discussed, but retrieval agents improve grounding.",
                "selection_source": "fresh_fetch",
                "tags": [{"kind": "paper", "label": "retrieval"}],
                "date": "2026-05-25",
            }
        ]

        words = self.mod.word_cloud_items(papers, 20, {}, set())
        labels = {item["label"] for item in words}

        self.assertIn("retrieval", labels)
        self.assertNotIn("fresh_fetch", labels)
        self.assertNotIn("fresh", labels)
        self.assertNotIn("fetch", labels)
        self.assertNotIn("but", labels)
        self.assertNotIn("they", labels)
        self.assertNotIn("often", labels)
        self.assertNotIn("existing", labels)

    def test_weekly_v24_excludes_profile_tag_and_applies_topic_limits(self):
        window = self.mod.resolve_period_window("weekly", "2026-05-25", "2026-05-31")
        papers = []
        for idx in range(14):
            papers.append(
                {
                    "paper_id": f"p{idx}",
                    "title": f"AI4ND ai4nd:composite topic-{idx} topic-{(idx + 1) % 14} cooccurrence",
                    "date": f"2026-05-{25 + (idx % 5):02d}",
                    "score": 8.0,
                    "source": "arxiv",
                    "tags": [
                        {"kind": "query", "label": "AI4ND" if idx % 2 else "ai4nd"},
                        {"kind": "paper", "label": "ai4nd:composite"},
                        {"kind": "ai4nd", "label": "composite"},
                        {"kind": "paper", "label": f"topic-{idx}"},
                        {"kind": "paper", "label": f"topic-{(idx + 1) % 14}"},
                    ],
                    "evidence": f"evidence for ai4nd:composite topic-{idx}",
                }
            )
        limits = {
            "related_topics": 5,
            "topic_timeline": 4,
            "cooccurrence_topics": 4,
            "cooccurrence_pairs": 6,
        }

        metrics = self.mod.build_metrics(
            papers,
            [],
            window,
            3,
            {},
            {},
            {"ai4nd"},
            limits,
        )
        weekly = metrics["weekly_v2"]

        self.assertEqual(len(weekly["related_topics"]), 5)
        self.assertEqual(len(weekly["weekday_topic_timeline"]), 4)
        self.assertLessEqual(len(weekly["word_cloud"]), 3)
        for bucket in ("related_topics", "weekday_topic_timeline", "word_cloud"):
            labels = [str(item.get("label") or item.get("topic")).casefold() for item in weekly[bucket]]
            self.assertNotIn("ai4nd", labels)
            self.assertNotIn("ai4nd:composite", labels)
            self.assertNotIn("composite", labels)
        network_html = self.mod.cooccurrence_html(
            weekly["cooccurrence"],
            topic_limit=limits["cooccurrence_topics"],
            pair_limit=limits["cooccurrence_pairs"],
        )
        self.assertLessEqual(network_html.count('class="dpr-weekly-chord-arc"'), 4)
        self.assertLessEqual(network_html.count("dpr-weekly-chord-table-row"), 6)
        self.assertNotIn("AI4ND", network_html)
        self.assertNotIn("ai4nd", network_html)
        self.assertNotIn("ai4nd:composite", network_html)

    def test_representative_evidence_uses_filtered_paper_topics(self):
        window = self.mod.resolve_period_window("weekly", "2026-05-25", "2026-05-31")
        paper = {
            "paper_id": "p1",
            "title": "Retrieval Benchmark",
            "date": "2026-05-25",
            "score": 9.0,
            "source": "arxiv",
            "href": "#/p1",
            "tags": [
                {"kind": "query", "label": "AI4ND"},
                {"kind": "paper", "label": "ai4nd:composite"},
                {"kind": "ai4nd", "label": "composite"},
                {"kind": "paper", "label": "retrieval"},
                {"kind": "paper", "label": "benchmark"},
            ],
            "evidence": "This paper compares retrieval benchmark protocols.",
        }
        papers = [paper]
        excluded = {"ai4nd"}
        metrics = self.mod.build_metrics(
            papers,
            [],
            window,
            10,
            {"raw_records": 1, "duplicates_removed": 0},
            {},
            excluded,
            self.mod.weekly_topic_limits({}),
        )
        related_topics = metrics["weekly_v2"]["related_topics"]

        display_topics = self.mod.paper_display_topic_labels(paper, {}, excluded, related_topics)
        self.assertIn("retrieval", display_topics)
        self.assertIn("benchmark", display_topics)
        self.assertNotIn("AI4ND", display_topics)
        self.assertNotIn("ai4nd:composite", display_topics)
        self.assertNotIn("composite", display_topics)

        row = self.mod.evidence_row_html(paper, 1, {}, excluded, related_topics)
        monthly_strip = self.mod.monthly_evidence_strip_html(papers, related_topics, 1, {}, excluded)
        for rendered in (row, monthly_strip):
            self.assertIn("retrieval", rendered)
            self.assertIn("benchmark", rendered)
            self.assertNotIn("AI4ND", rendered)
            self.assertNotIn("ai4nd:composite", rendered)
            self.assertNotIn(">composite<", rendered)

        payload = self.mod.build_llm_interpretation_payload(window, metrics, papers, {}, excluded)
        evidence_topics = payload["weekly_summary_inputs"]["representative_papers"][0]["topics"]
        self.assertIn("retrieval", evidence_topics)
        self.assertIn("benchmark", evidence_topics)
        self.assertNotIn("AI4ND", evidence_topics)
        self.assertNotIn("ai4nd:composite", evidence_topics)

        monthly_window = self.mod.resolve_period_window("monthly", "2026-05-01", "2026-05-31")
        monthly_metrics = self.mod.build_metrics(
            papers,
            [],
            monthly_window,
            10,
            {"raw_records": 1, "duplicates_removed": 0},
            {},
            excluded,
            self.mod.monthly_topic_limits({}),
        )
        monthly_payload = self.mod.build_llm_interpretation_payload(monthly_window, monthly_metrics, papers, {}, excluded)
        monthly_evidence_topics = monthly_payload["monthly_summary_inputs"]["representative_papers"][0]["topics"]
        self.assertIn("retrieval", monthly_evidence_topics)
        self.assertIn("benchmark", monthly_evidence_topics)
        self.assertNotIn("AI4ND", monthly_evidence_topics)
        self.assertNotIn("ai4nd:composite", monthly_evidence_topics)

        with tempfile.TemporaryDirectory() as tmpdir:
            result = self.mod.write_report(
                Path(tmpdir),
                window,
                "artifacts",
                metrics,
                papers,
                [],
                {"weekly_summary": "summary"},
                "hash",
                representative_papers=1,
                aliases={},
                excluded_labels=excluded,
                dry_run=True,
            )
        evidence_index_topics = result["payload"]["evidence_index"][0]["topics"]
        self.assertIn("retrieval", evidence_index_topics)
        self.assertIn("benchmark", evidence_index_topics)
        self.assertNotIn("AI4ND", evidence_index_topics)
        self.assertNotIn("ai4nd:composite", evidence_index_topics)

    def test_monthly_cooccurrence_legend_truncates_long_label_list(self):
        pairs = [
            {"source": "agents", "target": f"topic-{idx:02d}", "count": 20 - idx, "status": "stable"}
            for idx in range(14)
        ]

        network_html = self.mod.cooccurrence_html(
            pairs,
            topic_limit=20,
            pair_limit=18,
            title="主题共现图谱",
            section_extra_class="dpr-monthly-network-card",
            show_status=True,
        )

        self.assertEqual(network_html.count("dpr-weekly-chord-table-row"), 10)
        self.assertIn("dpr-weekly-chord-table-note", network_html)
        self.assertIn("标签数过多，已截断 4 条。", network_html)

    def test_monthly_v1_uses_weekly_visual_language_and_baseline(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            docs = root / "docs"
            docs.mkdir()
            (docs / "_sidebar.md").write_text("* 首页\n* Daily Papers\n", encoding="utf-8")
            window = self.mod.resolve_period_window("monthly", "2026-05-01", "2026-05-31")
            papers = [
                {
                    "paper_id": "p1",
                    "title": "Agent Memory Systems",
                    "date": "2026-05-01",
                    "score": 9.0,
                    "source": "arxiv",
                    "tags": [{"kind": "paper", "label": "agents"}, {"kind": "paper", "label": "memory"}],
                    "evidence": "agent memory improves long-horizon tool use",
                    "href": "#/p1",
                },
                {
                    "paper_id": "p2",
                    "title": "Retrieval Evaluation Benchmark",
                    "date": "2026-05-15",
                    "score": 8.2,
                    "source": "arxiv",
                    "tags": [{"kind": "paper", "label": "retrieval"}, {"kind": "paper", "label": "benchmark"}],
                    "evidence": "retrieval benchmarks compare evaluation protocols",
                    "href": "#/p2",
                },
            ]
            limits = self.mod.monthly_topic_limits(
                {
                    "topic_limits": {
                        "related_topics": 12,
                        "topic_timeline": 12,
                        "word_cloud_terms": 36,
                        "cooccurrence_topics": 12,
                        "cooccurrence_pairs": 18,
                        "comparison_topics": 10,
                    }
                }
            )
            metrics = self.mod.build_metrics(papers, [], window, 36, {}, {}, set(), limits)
            interpretation = self.mod.build_fallback_interpretation(window, metrics, papers)
            result = self.mod.write_report(
                docs,
                window,
                "artifacts",
                metrics,
                papers,
                [],
                interpretation,
                "hash",
            )

            readme = Path(result["readme"]).read_text(encoding="utf-8")
            meta = json.loads(Path(result["meta"]).read_text(encoding="utf-8"))
            monthly_index = (docs / "reports" / "monthly" / "README.md").read_text(encoding="utf-8")

            self.assertIn("dpr-periodic-monthly-v1", readme)
            self.assertIn("dpr-weekly-hero dpr-monthly-hero", readme)
            self.assertIn("dpr-weekly-bento dpr-monthly-bento", readme)
            self.assertIn("dpr-monthly-change-card", readme)
            self.assertIn("dpr-monthly-baseline-grid", readme)
            self.assertIn("首月主题基线", readme)
            self.assertIn("首月共现线索", readme)
            self.assertNotIn("暂无上月月报可用于环比", readme)
            self.assertIn("dpr-monthly-heat-cells", readme)
            self.assertIn("dpr-monthly-word-card", readme)
            self.assertIn("dpr-monthly-topic-board-card", readme)
            self.assertIn("dpr-monthly-topic-feature-grid", readme)
            self.assertIn("dpr-monthly-topic-board-row", readme)
            self.assertIn("dpr-monthly-network-card", readme)
            self.assertIn("dpr-monthly-evidence-strip", readme)
            self.assertIn("dpr-monthly-watchlist-card", readme)
            self.assertIn('<ul class="dpr-monthly-watchlist"><li>', readme)
            self.assertIn("dpr-monthly-watchlist-source", readme)
            self.assertIn("模板观察建议，非 LLM 生成", readme)
            self.assertNotIn("dpr-monthly-watchlist-dash", readme)
            self.assertIn("首月基线", readme)
            self.assertNotIn("dpr-periodic-layout", readme)
            self.assertNotIn("Source Mix", readme)
            self.assertIn("dpr-periodic-index-card is-monthly", monthly_index)
            self.assertIn("dpr-periodic-index-mini-cloud", monthly_index)
            self.assertIn('viewBox="0 0 960 300"', monthly_index)
            self.assertIn("aria-label=\"月报词频云\"", monthly_index)
            self.assertIn("dpr-periodic-index-monthly-meta", monthly_index)
            self.assertIn("篇去重样本", monthly_index)
            self.assertIn("dpr-periodic-index-summary", monthly_index)
            self.assertIn("monthly_v1", meta)
            self.assertTrue(meta["monthly_summary"])
            self.assertEqual(meta["monthly_summary_source"], "fallback")
            self.assertGreaterEqual(len(meta["monthly_v1"]["word_cloud"]), 4)
            self.assertLessEqual(len(meta["monthly_v1"]["word_cloud"]), 36)

    def test_monthly_v1_compares_previous_month_topics(self):
        window = self.mod.resolve_period_window("monthly", "2026-05-01", "2026-05-31")
        previous_meta = {
            "key": "2026-04",
            "input_hash": "prev-hash",
            "metrics": {
                "monthly_v1": {
                    "related_topics": [
                        {"label": "vision", "count": 4, "rank": 1},
                        {"label": "retrieval", "count": 3, "rank": 2},
                        {"label": "agents", "count": 2, "rank": 3},
                    ],
                    "cooccurrence": [
                        {"source": "vision", "target": "retrieval", "count": 2},
                    ],
                }
            },
        }
        papers = [
            {
                "paper_id": "p1",
                "title": "Agent Benchmark",
                "date": "2026-05-01",
                "score": 9.0,
                "tags": [{"kind": "paper", "label": "agents"}, {"kind": "paper", "label": "benchmark"}],
            },
            {
                "paper_id": "p2",
                "title": "Agent Retrieval",
                "date": "2026-05-08",
                "score": 8.5,
                "tags": [{"kind": "paper", "label": "agents"}, {"kind": "paper", "label": "retrieval"}],
            },
            {
                "paper_id": "p3",
                "title": "Agent Evaluation",
                "date": "2026-05-15",
                "score": 8.0,
                "tags": [{"kind": "paper", "label": "agents"}, {"kind": "paper", "label": "evaluation"}],
            },
            {
                "paper_id": "p4",
                "title": "Agent Planning",
                "date": "2026-05-22",
                "score": 7.8,
                "tags": [{"kind": "paper", "label": "agents"}, {"kind": "paper", "label": "retrieval"}],
            },
        ]

        metrics = self.mod.build_metrics(
            papers,
            [],
            window,
            36,
            {},
            {},
            set(),
            self.mod.monthly_topic_limits({}),
            previous_meta,
        )
        monthly = metrics["monthly_v1"]
        comparison = monthly["comparison"]

        self.assertEqual(comparison["previous_key"], "2026-04")
        self.assertTrue(comparison["has_previous"])
        self.assertIn("agents", [item["label"] for item in comparison["groups"]["rising"]])
        self.assertIn("benchmark", [item["label"] for item in comparison["groups"]["new"]])
        self.assertIn("vision", [item["label"] for item in comparison["groups"]["faded"]])
        self.assertEqual(len(monthly["topic_timeline"][0]["points"]), 5)

    def test_llm_prompt_includes_weekly_summary_inputs_with_length_policy(self):
        window = self.mod.resolve_period_window("weekly", "2026-05-25", "2026-05-31")
        metrics = {
            "coverage": {"artifact_files": 1, "unique_papers": 2},
            "weekly_v2": {
                "related_topics": [{"label": "agents", "count": 2}],
                "word_cloud": [{"label": "retrieval", "count": 3}],
                "cooccurrence": [{"source": "agents", "target": "retrieval", "count": 2}],
            },
        }
        papers = [
            {
                "paper_id": "p1",
                "title": "Agent Retrieval",
                "score": 9.0,
                "source": "arxiv",
                "tags": [{"label": "agents"}],
                "evidence": "agents and retrieval co-occur in this representative paper",
            }
        ]

        payload = self.mod.build_llm_interpretation_payload(window, metrics, papers)
        prompt_json = json.dumps(payload, ensure_ascii=False)

        self.assertIn("weekly_summary_inputs", payload)
        self.assertIn("related_topics", payload["weekly_summary_inputs"])
        self.assertIn("word_cloud", payload["weekly_summary_inputs"])
        self.assertIn("cooccurrence", payload["weekly_summary_inputs"])
        self.assertIn("representative_papers", payload["weekly_summary_inputs"])
        self.assertIn("200-400 字", prompt_json)
        self.assertNotIn("硬上限 400 字", prompt_json)
        self.assertNotIn("硬上限 500 字", prompt_json)
        self.assertIn("Agent Retrieval", prompt_json)

    def test_weekly_llm_summary_is_not_hard_truncated(self):
        long_summary = "这是一个用于测试周报小结长度限制的句子。" * 45
        interpretation = self.mod.normalize_interpretation({"weekly_summary": long_summary})

        self.assertEqual(interpretation["weekly_summary"], long_summary)

    def test_weekly_summary_and_related_topics_use_seven_to_five_grid_ratio(self):
        css = (self.mod.ROOT_DIR / "app" / "app.css").read_text(encoding="utf-8").replace("\r\n", "\n")

        self.assertIn(".dpr-weekly-summary-card {\n  grid-column: span 14;", css)
        self.assertIn(".dpr-weekly-topic-card.related {\n  grid-column: span 10;", css)

    def test_llm_prompt_includes_monthly_summary_inputs(self):
        window = self.mod.resolve_period_window("monthly", "2026-05-01", "2026-05-31")
        metrics = {
            "coverage": {"artifact_files": 4, "unique_papers": 12},
            "monthly_v1": {
                "related_topics": [{"label": "agents", "count": 4}],
                "topic_timeline": [{"topic": "agents", "points": [{"week": "W1", "count": 1}]}],
                "word_cloud": [{"label": "agents", "count": 8}],
                "cooccurrence": [{"source": "agents", "target": "retrieval", "count": 3}],
                "comparison": {"has_previous": True, "rising_count": 1, "new_count": 0},
                "watchlist": ["继续观察 agents"],
            },
        }
        papers = [{"paper_id": "p1", "title": "Agent Retrieval", "score": 9.0, "tags": [{"label": "agents"}]}]

        payload = self.mod.build_llm_interpretation_payload(window, metrics, papers)
        prompt_json = json.dumps(payload, ensure_ascii=False)

        self.assertIn("monthly_summary_inputs", payload)
        monthly_inputs = payload["monthly_summary_inputs"]
        self.assertIn("related_topics", monthly_inputs)
        self.assertIn("topic_timeline", monthly_inputs)
        self.assertIn("word_cloud", monthly_inputs)
        self.assertIn("cooccurrence", monthly_inputs)
        self.assertIn("comparison", monthly_inputs)
        self.assertIn("watchlist", monthly_inputs)
        self.assertIn("5-10 条下月观察建议", prompt_json)
        self.assertIn("圆点列表展示", prompt_json)
        self.assertNotIn("sources", monthly_inputs)

    def test_monthly_llm_cache_requires_monthly_source_and_watchlist(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            out_dir = Path(tmpdir)
            meta_path = out_dir / "report.meta.json"
            meta_path.write_text(
                json.dumps(
                    {
                        "period": "monthly",
                        "input_hash": "hash",
                        "interpretation": {
                            "monthly_summary": "LLM 月报小结",
                            "monthly_summary_source": "llm",
                            "watchlist": [f"- 观察主题 {idx}" for idx in range(1, 6)],
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            cached = self.mod.load_existing_interpretation(out_dir, "hash")

            self.assertIsNotNone(cached)
            self.assertEqual(cached["monthly_summary_source"], "llm")
            self.assertEqual(len(cached["watchlist"]), 5)
            self.assertEqual(cached["watchlist"][0], "观察主题 1")

            meta_path.write_text(
                json.dumps(
                    {
                        "period": "monthly",
                        "input_hash": "hash",
                        "interpretation": {
                            "monthly_summary": "LLM 月报小结",
                            "monthly_summary_source": "llm",
                            "watchlist": ["观察主题"],
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            self.assertIsNone(self.mod.load_existing_interpretation(out_dir, "hash"))

    def test_llm_interpretation_retries_reasoning_only_response_and_marks_source(self):
        window = self.mod.resolve_period_window("weekly", "2026-05-25", "2026-05-31")
        metrics = {
            "coverage": {"artifact_files": 1, "unique_papers": 1},
            "weekly_v2": {
                "related_topics": [{"label": "agents", "count": 1}],
                "word_cloud": [{"label": "agents", "count": 2}],
                "cooccurrence": [],
            },
        }
        papers = [{"paper_id": "p1", "title": "Agent Memory", "score": 8.5, "source": "arxiv"}]
        attempts = []

        class DummyLLMClient:
            def __init__(self, *args, **kwargs):
                self.kwargs = {}

            @staticmethod
            def build_json_object_response_format():
                return {"type": "json_object"}

            @staticmethod
            def parse_json_content(text):
                return json.loads(text)

            def chat(self, _messages, response_format=None):
                attempts.append(self.kwargs.get("max_tokens"))
                if len(attempts) < 3:
                    return {"content": "", "reasoning_content": "thinking only"}
                return {
                    "content": json.dumps({"weekly_summary": "这是 LLM 生成的小结。"}, ensure_ascii=False),
                    "reasoning_content": "",
                }

        old_client = self.mod.LLMClient
        env_names = ("DPR_LLM_API_KEY", "DPR_LLM_REPORT_MODEL", "DPR_LLM_SUMMARY_MODEL", "DPR_LLM_MODEL")
        old_env = {name: os.environ.get(name) for name in env_names}
        try:
            self.mod.LLMClient = DummyLLMClient
            os.environ["DPR_LLM_API_KEY"] = "demo-key"
            os.environ["DPR_LLM_REPORT_MODEL"] = "demo-report-model"
            os.environ.pop("DPR_LLM_SUMMARY_MODEL", None)
            os.environ.pop("DPR_LLM_MODEL", None)

            interpretation = self.mod.try_llm_interpretation(window, metrics, papers)
        finally:
            self.mod.LLMClient = old_client
            for name, value in old_env.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

        self.assertEqual(attempts, [2400, 3600, 5200])
        self.assertIsNotNone(interpretation)
        self.assertEqual(interpretation["weekly_summary_source"], "llm")
        self.assertEqual(interpretation["weekly_summary_model"], "demo-report-model")
        self.assertIn("demo-report-model", interpretation["weekly_summary_note"])

    def test_broken_chinese_title_is_not_rendered_as_question_marks(self):
        row = self.mod.evidence_row_html(
            {
                "title": "English Only",
                "title_zh": "????????",
                "href": "#/paper",
                "tags": [{"label": "agents"}],
                "evidence": "useful evidence",
            },
            1,
        )
        self.assertIn("English Only", row)
        self.assertNotIn("????????", row)
        self.assertNotIn("dpr-weekly-evidence-title-zh", row)

    def test_broken_body_text_falls_back_in_weekly_summary_and_evidence(self):
        window = self.mod.resolve_period_window("weekly", "2026-05-25", "2026-05-31")
        papers = [
            {
                "paper_id": "p1",
                "title": "Agent Memory",
                "date": "2026-05-25",
                "score": 8.5,
                "source": "arxiv",
                "tags": [{"kind": "paper", "label": "agents"}],
                "evidence": "????????????????????????",
                "href": "#/paper",
            }
        ]
        metrics = self.mod.build_metrics(
            papers,
            [],
            window,
            10,
            {"raw_records": 1, "duplicates_removed": 0},
            {},
            set(),
            self.mod.weekly_topic_limits({}),
        )
        html = self.mod.build_weekly_report_markdown(
            window,
            "artifacts",
            metrics,
            papers,
            {"weekly_summary": "????????????????????????????????"},
            "now",
        )

        self.assertIn("本周去重样本共", html)
        self.assertIn("模板小结，非 LLM 生成", html)
        self.assertIn("暂无推荐证据。", html)
        self.assertNotIn("????????", html)

    def test_llm_fallback_contains_weekly_summary(self):
        window = self.mod.resolve_period_window("weekly", "2026-05-25", "2026-05-31")
        metrics = {
            "coverage": {"artifact_files": 1, "unique_papers": 1},
            "topics": [{"label": "agents", "count": 1}],
            "sources": [{"label": "arxiv", "count": 1}],
            "weekly_v2": {
                "focus_topics": [{"label": "agents", "count": 1}],
                "context_topics": [{"label": "LLM Agents", "count": 1}],
            },
        }
        interpretation = self.mod.build_fallback_interpretation(
            window,
            metrics,
            [{"paper_id": "p1", "title": "Agent Memory", "score": 8.5}],
        )

        self.assertIn("weekly_summary", interpretation)
        self.assertTrue(interpretation["weekly_summary"])
        self.assertEqual(interpretation["weekly_summary_source"], "fallback")
        self.assertIn("summary_evidence_ids", interpretation)


if __name__ == "__main__":
    unittest.main()
