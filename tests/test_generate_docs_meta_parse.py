import importlib.util
import html
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


class GenerateDocsMetaParseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1]
        if "fitz" not in sys.modules:
            import types

            fitz_stub = types.ModuleType("fitz")
            fitz_stub.open = lambda *args, **kwargs: None
            sys.modules["fitz"] = fitz_stub
        if "llm" not in sys.modules:
            import types

            llm_stub = types.ModuleType("llm")

            class DummyLLMClient:
                def __init__(self, *args, **kwargs):
                    pass

            llm_stub.LLMClient = DummyLLMClient
            llm_stub.make_task_client = lambda *args, **kwargs: DummyLLMClient()
            sys.modules["llm"] = llm_stub
        if "paper_figures" not in sys.modules:
            import types

            paper_figures_stub = types.ModuleType("paper_figures")
            paper_figures_stub.ensure_paper_figures = lambda **kwargs: []
            paper_figures_stub.ensure_paper_figures_from_file = lambda **kwargs: []
            sys.modules["paper_figures"] = paper_figures_stub

        src_path = root / "src" / "6.generate_docs.py"
        spec = importlib.util.spec_from_file_location("gen6_mod", src_path)
        cls.mod = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(cls.mod)

    def test_parse_meta_from_front_matter(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "paper.md"
            path.write_text(
                "\n".join(
                    [
                        "---",
                        'title: "Attention Is All You Need"',
                        "title_zh: 注意力即一切",
                        "authors: Ashish Vaswani, Noam Shazeer",
                        'tags: ["query:transformer", "paper:attention"]',
                        "date: 20170612",
                        "pdf: https://arxiv.org/pdf/1706.03762",
                        "selection_source: fresh_fetch",
                        "---",
                        "",
                        "## Abstract",
                        "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.",
                    ]
                ),
                encoding="utf-8",
            )
            item = self.mod._parse_generated_md_to_meta(str(path), "pid", "quick")
            self.assertEqual(item["title_en"], "Attention Is All You Need")
            self.assertEqual(item["title_zh"], "注意力即一切")
            self.assertTrue(item["authors"].startswith("Ashish Vaswani"))
            self.assertIn("query:transformer", item["tags"])
            self.assertEqual(item["date"], "20170612")
            self.assertIn("https://arxiv.org/pdf", item["pdf"])
            self.assertEqual(item["selection_source"], "fresh_fetch")

    def test_format_beijing_time_converts_utc_with_label(self):
        generated_at = self.mod.format_beijing_time(
            datetime(2026, 5, 23, 20, 41, 46, tzinfo=timezone.utc)
        )

        self.assertEqual(generated_at, "2026-05-24 04:41:46 北京时间")

    def test_beijing_date_token_matches_display_date(self):
        token = self.mod.beijing_date_token(
            datetime(2026, 5, 23, 20, 41, 46, tzinfo=timezone.utc)
        )

        self.assertEqual(token, "20260524")

    def test_parse_fallback_to_legacy_meta_lines(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "paper.md"
            path.write_text(
                "\n".join(
                    [
                        "---",
                        "selection_source: fresh_fetch",
                        "title: Legacy title",
                        "---",
                        "**Authors**: Legacy A, Legacy B",
                        "**Date**: 20260301",
                        "**PDF**: https://example.com/paper.pdf",
                        "**TLDR**: legacy tldr text",
                        "",
                        "## Abstract",
                        "abstract body",
                    ]
                ),
                encoding="utf-8",
            )
            item = self.mod._parse_generated_md_to_meta(
                str(path),
                "legacy",
                "deep",
                "cache_hint",
            )
            self.assertEqual(item["authors"], "Legacy A, Legacy B")
            self.assertEqual(item["date"], "20260301")
            self.assertEqual(item["pdf"], "https://example.com/paper.pdf")
            self.assertEqual(item["tldr"], "legacy tldr text")
            self.assertEqual(item["selection_source"], "cache_hint")

    def test_parse_source_from_front_matter(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "paper.md"
            path.write_text(
                "\n".join(
                    [
                        "---",
                        "title: Test title",
                        "source: biorxiv",
                        "selection_source: fresh_fetch",
                        "---",
                        "## Abstract",
                        "abstract body",
                    ]
                ),
                encoding="utf-8",
            )
            item = self.mod._parse_generated_md_to_meta(str(path), "pid", "quick")
            self.assertEqual(item["source"], "biorxiv")
            self.assertEqual(item["selection_source"], "fresh_fetch")

    def test_extract_sidebar_tags_hides_composite_suffix(self):
        paper = {
            "llm_score": 8.0,
            "llm_tags": [
                "query:sr:composite",
                "query:sr",
                "keyword:equation-discovery",
            ],
        }
        tags = self.mod.extract_sidebar_tags(paper)
        self.assertEqual(tags[0], ("score", "8.0"))
        self.assertIn(("query", "sr"), tags)
        self.assertIn(("query", "equation-discovery"), tags)
        self.assertNotIn(("query", "sr:composite"), tags)
        self.assertEqual(tags.count(("query", "sr")), 1)

    def test_extract_reader_topic_tags_uses_short_sources(self):
        paper = {
            "topic_tags": [
                "continual learning",
                "使用偏信息分解分析多模态语言模型中的模态交互",
            ],
            "keywords": ["domain generalization"],
            "llm_tags": [
                "query:ai4nd",
                "paper:ai4nd:composite",
                "paper:domain adaptation",
            ],
            "llm_evidence_en": "continual learning, domain generalization, replay control",
            "canonical_evidence": "使用偏信息分解分析多模态语言模型中的模态交互",
        }

        topics = self.mod.extract_reader_topic_tags(paper)

        self.assertEqual(
            topics,
            ["continual learning", "domain generalization", "domain adaptation", "replay control"],
        )
        self.assertNotIn("ai4nd", " ".join(topics).lower())
        self.assertFalse(any("使用偏信息" in topic for topic in topics))
        self.assertEqual(
            self.mod.extract_reader_topic_tags({"canonical_evidence": "symbolic regression, equation discovery"}),
            ["symbolic regression", "equation discovery"],
        )
        self.assertEqual(
            self.mod.extract_reader_topic_tags(
                {
                    "canonical_evidence": (
                        "This paper proposes Frobenius reinitialization, and improves "
                        "the stability-plasticity tradeoff."
                    )
                }
            ),
            [],
        )
        self.assertEqual(
            self.mod.extract_reader_topic_tags({"canonical_evidence": "本文提出稳定性和可塑性平衡方法，适合当前订阅方向"}),
            [],
        )

    def test_extract_reader_topic_tags_prefers_english_professional_terms(self):
        eva_topics = self.mod.extract_reader_topic_tags(
            {
                "title": "EVA-Net: Subject-Independent EEG Motor Decoding with Video-Derived Motor Priors",
                "primary_category": "cs.AI",
                "categories": ["cs.AI"],
                "llm_evidence_en": (
                    "EEG motor decoding with video-derived semantic priors via cross-modal alignment"
                ),
                "canonical_evidence": "通过跨模态对齐的视频语义先验进行EEG运动解码",
                "matched_query_text": (
                    "Prioritize papers on multimodal alignment, cross modal representation learning, "
                    "or latent representation matching that could inspire neural decoding."
                ),
            }
        )

        self.assertEqual(
            eva_topics,
            [
                "EEG motor decoding",
                "video-derived semantic priors",
                "cross-modal alignment",
                "Artificial Intelligence",
            ],
        )
        self.assertFalse(any("Prioritize" in topic or "通过" in topic for topic in eva_topics))

        edit_topics = self.mod.extract_reader_topic_tags(
            {
                "title": "Do Text Edits Generalize to Visual Generation? Benchmarking Cross-Modal Knowledge Editing in UMMs",
                "categories": ["cs.CL", "cs.CV"],
                "llm_evidence_en": "cross-modal knowledge editing in multimodal models",
                "canonical_evidence": "多模态模型中的跨模态知识编辑",
                "matched_query_text": "multimodal alignment",
            }
        )

        self.assertEqual(
            edit_topics,
            [
                "cross-modal knowledge editing",
                "multimodal models",
                "multimodal alignment",
                "NLP",
                "Computer Vision",
            ],
        )

    def test_update_sidebar_payload_includes_short_topic_tags(self):
        with tempfile.TemporaryDirectory() as d:
            sidebar_path = Path(d) / "_sidebar.md"
            sidebar_path.write_text("* Daily Papers\n", encoding="utf-8")

            self.mod.update_sidebar(
                str(sidebar_path),
                "20260522",
                [
                    (
                        "202605/22/test-paper",
                        "Test Paper",
                        "测试论文",
                        [("score", "9.0"), ("query", "ai4nd")],
                    )
                ],
                [
                    (
                        "202605/22/quick-paper",
                        "Quick Paper",
                        "速读论文",
                        [("score", "7.0"), ("paper", "bridge")],
                    )
                ],
                {
                    "202605/22/test-paper": "使用偏信息分解分析多模态语言模型中的模态交互",
                    "202605/22/quick-paper": "methodological bridge",
                },
                "2026-05-22",
                paper_topic_tags_by_id={
                    "202605/22/test-paper": [
                        "continual learning",
                        "domain generalization",
                        "使用偏信息分解分析多模态语言模型中的模态交互",
                    ],
                    "202605/22/quick-paper": ["methodological bridge"],
                },
                paper_date_by_id={
                    "202605/22/test-paper": "2026-05-20",
                    "202605/22/quick-paper": "2026-05-21T00:00:00+00:00",
                },
            )

            content = sidebar_path.read_text(encoding="utf-8")
            payloads = [
                json.loads(html.unescape(chunk.split('"', 1)[0]))
                for chunk in content.split('data-sidebar-item="')[1:]
            ]
            payload_by_title = {payload["title"]: payload for payload in payloads}
            payload = payload_by_title["Test Paper"]
            self.assertEqual(payload["date"], "2026-05-20")
            self.assertEqual(payload["published"], "2026-05-20")
            self.assertEqual(payload["topic_tags"], ["continual learning", "domain generalization"])
            self.assertEqual(payload["reader_section"], "deep")
            self.assertEqual(payload["tags"], [{"kind": "query", "label": "ai4nd"}])
            self.assertEqual(payload_by_title["Quick Paper"]["date"], "2026-05-21")
            self.assertEqual(payload_by_title["Quick Paper"]["reader_section"], "quick")

    def test_build_markdown_content_writes_figures_json_front_matter(self):
        paper = {
            "title": "Figure Test",
            "authors": ["Ada Lovelace"],
            "published": "2026-03-26T00:00:00+00:00",
            "link": "https://arxiv.org/pdf/1234.5678",
            "abstract": "abstract body",
            "source": "arxiv",
            "_figure_assets": [
                {
                    "url": "assets/figures/arxiv/1234.5678/fig-001.webp",
                    "caption": "",
                    "page": 2,
                    "index": 1,
                    "width": 1280,
                    "height": 720,
                }
            ],
        }
        md = self.mod.build_markdown_content(paper, "quick", "", "", [])
        meta = self.mod._parse_front_matter(md)
        self.assertIn("figures_json", meta)
        figures = json.loads(meta["figures_json"])
        self.assertEqual(len(figures), 1)
        self.assertEqual(figures[0]["url"], "assets/figures/arxiv/1234.5678/fig-001.webp")

    def test_build_markdown_content_writes_score_label(self):
        paper = {
            "title": "Subscription Score Test",
            "authors": ["Ada Lovelace"],
            "published": "2026-05-27",
            "abstract": "abstract body",
            "source": "local-pdf",
            "llm_score": 8.5,
            "score_label": "订阅评分",
        }
        md = self.mod.build_markdown_content(paper, "deep", "", "", [])
        meta = self.mod._parse_front_matter(md)
        self.assertEqual(meta["score"], "8.5 订阅评分")
        self.assertEqual(meta["score_label"], "订阅评分")

    def test_research_direction_prompt_context_mentions_configured_source(self):
        text = self.mod.build_research_direction_prompt_context(
            {
                "source": "configured",
                "directions": ["symbolic regression", "equation discovery"],
            }
        )

        self.assertIn("用户手动配置", text)
        self.assertIn("- symbolic regression", text)
        self.assertIn("- equation discovery", text)

    def test_subscription_score_label_still_maps_to_stars(self):
        self.assertEqual(self.mod.score_to_star_rating("8.5 订阅评分"), 4.5)
        html = self.mod.build_sidebar_stars_html("8.5 订阅评分")
        self.assertIn("订阅评分", html)
        self.assertIn("评分：8.5/10", html)

    def test_maybe_generate_paper_figures_accepts_biorxiv(self):
        calls = []

        def fake_ensure_paper_figures(**kwargs):
            calls.append(kwargs)
            return [{"url": "assets/figures/biorxiv/pid/fig-001.webp"}]

        original = self.mod.ensure_paper_figures
        self.mod.ensure_paper_figures = fake_ensure_paper_figures
        try:
            figures = self.mod.maybe_generate_paper_figures(
                {
                    "id": "biorxiv-abc",
                    "source": "biorxiv",
                },
                docs_dir="docs",
                paper_id="202603/26/biorxiv-abc",
                pdf_url="https://www.biorxiv.org/content/test.full.pdf",
            )
        finally:
            self.mod.ensure_paper_figures = original

        self.assertEqual(len(figures), 1)
        self.assertEqual(calls[0]["source_key"], "biorxiv")

    def test_home_readme_does_not_create_or_include_promo_placeholder(self):
        with tempfile.TemporaryDirectory() as d:
            docs_dir = Path(d)
            content = self.mod.build_home_readme_content(
                docs_dir=str(docs_dir),
                date_str="20260519",
                date_label="2026-05-19",
                generated_at="2026-05-19 00:00:00 UTC",
                recommend_exists=False,
                deep_entries=[],
                quick_entries=[],
                paper_evidence_by_id={},
            )

            self.assertFalse((docs_dir / "_home_notice.md").exists())
            self.assertFalse((docs_dir / "_home_promo.md").exists())
            self.assertIn("<h3>最新日报</h3>", content)
            self.assertNotIn("## 最新日报", content)
            self.assertNotIn("<h3>日报 · 2026-05-19</h3>", content)
            self.assertNotIn("Start Here", content)
            forbidden_phrases = [
                "".join(["宣传", "占位"]),
                "".join(["欢迎 Star / Fork", " 本项目"]),
                "".join(["欢迎提交 Issue", " 与 PR"]),
                "".join(["宣传", "模块为空"]),
            ]
            for phrase in forbidden_phrases:
                self.assertNotIn(phrase, content)

    def test_daily_report_card_includes_chinese_title(self):
        content = self.mod.build_daily_report_html(
            date_str="20260528",
            date_label="2026-05-28",
            generated_at="2026-05-28 09:30:00 北京时间",
            recommend_exists=True,
            deep_entries=[
                (
                    "202605/28/test-paper",
                    "Test Paper Title",
                    "测试论文标题",
                    [("score", "9.0"), ("query", "alignment")],
                )
            ],
            quick_entries=[],
            paper_evidence_by_id={"202605/28/test-paper": "matches the subscription"},
            summary="今日推荐 1 篇论文。",
        )

        self.assertIn('class="dpr-daily-paper-title"', content)
        self.assertIn('<div class="dpr-daily-paper-title-zh">测试论文标题</div>', content)

    def test_update_sidebar_removes_initial_empty_daily_placeholder(self):
        with tempfile.TemporaryDirectory() as d:
            sidebar_path = Path(d) / "_sidebar.md"
            sidebar_path.write_text(
                "\n".join(
                    [
                        "* <a class=\"dpr-sidebar-root-link\" href=\"#/\">首页</a>",
                        "* Daily Papers",
                        "  * 暂无日报，完成首次工作流后会自动生成",
                        "* Other",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            self.mod.update_sidebar(
                str(sidebar_path),
                "20260522",
                [("202605/22/test-paper", "Test Paper", [("score", "9.0")])],
                [],
                {"202605/22/test-paper": "why it matters"},
                "2026-05-22",
            )

            content = sidebar_path.read_text(encoding="utf-8")
            self.assertNotIn("暂无日报", content)
            self.assertIn("2026-05-22 <!--dpr-date:20260522-->", content)
            self.assertIn("* 📄 本地 PDF 解析", content)
            self.assertIn('href="#/local-pdf">📝 上传解析</a>', content)
            self.assertIn("#/reader-library", content)
            self.assertIn("* 🗂️ 近期日报", content)
            self.assertNotIn("* Daily Papers\n", content)
            self.assertEqual(content.count('class="dpr-sidebar-daily-note"'), 1)
            self.assertIn("#/reports/weekly/README", content)
            self.assertIn("#/reports/monthly/README", content)
            self.assertIn(
                '<a class="dpr-sidebar-brief-link" href="#/202605/22/README">📝 今日简报</a>',
                content,
            )
            self.assertIn("Test Paper", content)
            self.assertIn("* Other", content)

    def test_update_sidebar_handles_template_without_trailing_newline(self):
        with tempfile.TemporaryDirectory() as d:
            sidebar_path = Path(d) / "_sidebar.md"
            sidebar_path.write_text("* Daily Papers", encoding="utf-8")

            self.mod.update_sidebar(
                str(sidebar_path),
                "20260522",
                [("202605/22/test-paper", "Test Paper", [])],
                [],
                {},
                "2026-05-22",
            )

            content = sidebar_path.read_text(encoding="utf-8")
            self.assertIn('* 📄 本地 PDF 解析\n  * <a class="dpr-sidebar-brief-link" href="#/local-pdf">📝 上传解析</a>\n* 🗂️ 近期日报', content)
            self.assertIn("* 🗂️ 近期日报\n  * 2026-05-22", content)
            self.assertEqual(content.count('class="dpr-sidebar-daily-note"'), 1)
            self.assertIn("📝 今日简报", content)
            self.assertNotIn("* Daily Papers  * 2026-05-22", content)

    def test_update_sidebar_repairs_existing_same_line_daily_item(self):
        with tempfile.TemporaryDirectory() as d:
            sidebar_path = Path(d) / "_sidebar.md"
            sidebar_path.write_text(
                "\n".join(
                    [
                        "* Daily Papers  * 2026-05-22",
                        "    * 旧条目",
                        "* Other",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            self.mod.update_sidebar(
                str(sidebar_path),
                "20260522",
                [("202605/22/test-paper", "Test Paper", [])],
                [],
                {},
                "2026-05-22",
            )

            content = sidebar_path.read_text(encoding="utf-8")
            self.assertIn('* 📄 本地 PDF 解析\n  * <a class="dpr-sidebar-brief-link" href="#/local-pdf">📝 上传解析</a>\n* 🗂️ 近期日报', content)
            self.assertIn("* 🗂️ 近期日报\n  * 2026-05-22", content)
            self.assertEqual(content.count('class="dpr-sidebar-daily-note"'), 1)
            self.assertIn("📝 今日简报", content)
            self.assertNotIn("* Daily Papers  * 2026-05-22", content)
            self.assertNotIn("旧条目", content)
            self.assertIn("* Other", content)

    def test_update_sidebar_keeps_latest_seven_daily_blocks_with_note(self):
        with tempfile.TemporaryDirectory() as d:
            sidebar_path = Path(d) / "_sidebar.md"
            old_days = [
                "20260509",
                "20260508",
                "20260507",
                "20260506",
                "20260505",
                "20260504",
                "20260503",
                "20260502",
                "20260501",
            ]
            sidebar_path.write_text(
                "\n".join(
                    ["* Daily Papers"]
                    + [
                        f"  * 2026-05-{day[-2:]} <!--dpr-date:{day}-->\n    * <a class=\"dpr-sidebar-brief-link\" href=\"#/{day[:6]}/{day[-2:]}/README\">旧日报</a>"
                        for day in old_days
                    ]
                    + ["* Other"]
                )
                + "\n",
                encoding="utf-8",
            )

            self.mod.update_sidebar(
                str(sidebar_path),
                "20260510",
                [("202605/10/test-paper", "Test Paper", [])],
                [],
                {},
                "2026-05-10",
            )

            content = sidebar_path.read_text(encoding="utf-8")
            self.assertIn("* 🗂️ 近期日报", content)
            self.assertEqual(content.count('class="dpr-sidebar-daily-note"'), 1)
            kept_days = ["20260510", "20260509", "20260508", "20260507", "20260506", "20260505", "20260504"]
            positions = [content.index(f"<!--dpr-date:{day}-->") for day in kept_days]
            self.assertEqual(positions, sorted(positions))
            self.assertNotIn("<!--dpr-date:20260503-->", content)
            self.assertNotIn("<!--dpr-date:20260502-->", content)
            self.assertNotIn("<!--dpr-date:20260501-->", content)
            self.assertGreater(content.index("dpr-sidebar-daily-note"), content.index("<!--dpr-date:20260504-->"))
            self.assertLess(content.index("dpr-sidebar-daily-note"), content.index("* Other"))


if __name__ == "__main__":
    unittest.main()
