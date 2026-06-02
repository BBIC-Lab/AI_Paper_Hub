import importlib.util
import json
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

    def test_weekly_v2_chart_markup_uses_cloud_bundle_and_context_heatmap(self):
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
        self.assertIn("dominant-baseline", cloud_html)
        self.assertNotIn("<span", cloud_html)
        self.assertNotIn("dpr-weekly-word-cloud-glow", cloud_html)
        self.assertNotIn("<ellipse", cloud_html)

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
        self.assertIn("is-context", heat_html)
        for label in ["周一", "周二", "周三", "周四", "周五"]:
            self.assertIn(label, heat_html)
        self.assertEqual(heat_html.count("dpr-periodic-heat-cell"), 10)

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

    def test_weekly_v24_excludes_profile_tag_and_applies_topic_limits(self):
        window = self.mod.resolve_period_window("weekly", "2026-05-25", "2026-05-31")
        papers = []
        for idx in range(14):
            papers.append(
                {
                    "paper_id": f"p{idx}",
                    "title": f"AI4ND topic-{idx} topic-{(idx + 1) % 14} cooccurrence",
                    "date": f"2026-05-{25 + (idx % 5):02d}",
                    "score": 8.0,
                    "source": "arxiv",
                    "tags": [
                        {"kind": "query", "label": "AI4ND" if idx % 2 else "ai4nd"},
                        {"kind": "paper", "label": f"topic-{idx}"},
                        {"kind": "paper", "label": f"topic-{(idx + 1) % 14}"},
                    ],
                    "evidence": f"evidence for topic-{idx}",
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
        network_html = self.mod.cooccurrence_html(
            weekly["cooccurrence"],
            topic_limit=limits["cooccurrence_topics"],
            pair_limit=limits["cooccurrence_pairs"],
        )
        self.assertLessEqual(network_html.count('class="dpr-weekly-chord-arc"'), 4)
        self.assertLessEqual(network_html.count("dpr-weekly-chord-table-row"), 6)
        self.assertNotIn("AI4ND", network_html)
        self.assertNotIn("ai4nd", network_html)

    def test_llm_prompt_includes_weekly_summary_inputs_without_truncation_policy(self):
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
        self.assertIn("目标约 300 字", prompt_json)
        self.assertIn("硬上限 500 字", prompt_json)
        self.assertIn("Agent Retrieval", prompt_json)

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
        self.assertIn("summary_evidence_ids", interpretation)


if __name__ == "__main__":
    unittest.main()
