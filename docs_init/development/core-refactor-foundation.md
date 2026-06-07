# 核心重构基础边界

本文记录 `codex/core-refactor-foundation` 阶段的边界，目标是保留现有运行外壳，同时把可替换的核心能力先收敛到轻量模块。

## 当前边界

- 运行外壳：`src/main.py`、GitHub Actions、CLI 参数、环境变量和 Docsify 页面结构保持不变，继续按 Step 1 到 Step 6 串联执行。
- 核心 pipeline：召回、融合、LLM refine、选择推荐仍由现有脚本实现；本阶段只把日期、路径、JSON artifact 和共享数据结构抽到 `src/core/`。
- 外部 adapter：LLM、Embedding、论文源、Supabase/VectorStore、Renderer 先通过 `src/core/ports.py` 描述接口，不替换现有实现。
- 输出 contract：`archive/<run_date>/filtered`、`archive/<run_date>/rank`、`archive/<run_date>/recommend` 下的 JSON 文件名保持 `arxiv_papers_<run_date>*.json`。

## 文件分类

- 公开安全：`src/`、`tests/`、`docs_init/`、默认配置模板、workflow 和脚本文档。
- 运行态：`archive/**`、`docs/20*`、`docs/reports/**`、`docs/assets/figures/**`，只由实际运行或明确生成任务维护。
- 私有态：`secret.private`、个人化 `config.yaml` / `docs/config.yaml`、环境文件、日志、缓存、`.codex/` 和本地 TODO。

## 第一阶段接入

- `src/core/paths.py`：repo root、config/docs/archive 路径、运行日期 token、filtered/rank/recommend artifact 路径。
- `src/core/artifacts.py`：JSON 读写、稳定 artifact 文件名、推荐和召回 payload 的基础结构校验。
- `src/core/contracts.py`：`PaperRecord`、`QuerySpec`、`RecallPayload`、`RecommendationPayload` 等兼容数据结构。
- `src/core/ports.py`：后续替换 LLM、Embedding、PaperSource、VectorStore、Renderer 时使用的协议接口。

## 下一阶段优先级

1. 从 `src/6.generate_docs.py` 抽出 text extraction、summary payload 和 renderer。
2. 把 sidebar/index 更新逻辑从渲染主流程中分离，减少 Docsify 输出和推荐 JSON 之间的耦合。
3. 为 Supabase RPC、远程 embedding、LLM 请求建立 adapter 包装层，但保持现有配置字段和环境变量兼容。

## 外部服务绑定审计

- Supabase：当前 RPC 名、REST endpoint、headers 和表名仍由 `src/supabase_source.py`、`src/source_config.py`、配置模板和 SQL 共同约束。本阶段只登记为 `VectorStorePort` 后续适配对象，不改 RPC 名、SQL 或数据库部署流程。
- 远程 embedding：`src/model_loader.py` 仍承担本地/远程 embedding 加载与请求逻辑。下一阶段应优先抽 `EmbeddingPort` adapter，并把 endpoint、API key、timeout 统一收敛为 env/config 输入，先用 mock 测试覆盖未配置远程时的本地 fallback。
- GitHub API：前端设置、workflow dispatch、Secrets 写入和发布脚本 fallback 仍直接调用 GitHub API。后续应先抽薄 wrapper 统一 repo 推断、API base、fetch/error 处理，不重写 UI。
- CDN：Docsify、KaTeX、js-yaml、libsodium、PDF.js 仍由页面直接加载。本阶段不 vendoring；后续可引入 asset manifest 或本地 fallback。
- pdffigures2：workflow 构建和 `src/paper_figures.py` 调用方式保持不变。后续以 `RendererPort` / figure extractor 方向拆分，避免影响 Step 6 报告图片排序。
