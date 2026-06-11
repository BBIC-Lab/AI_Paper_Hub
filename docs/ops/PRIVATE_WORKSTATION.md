# 私有下游工作站边界

更新时间：2026-06-11 13:02 HKT
范围：`/home/jy/BBIC_AI_Paper_Hub` 作为私有下游日常运行仓库；workflow 使用 spark-d326 本机推理服务，不记录任何 API Key。

## 仓库角色

- `upstream`：公开上游 `git@github.com:Jurio0304/AI_Daily_Paper_Reader.git`，只用于拉取开发维护代码。
- `origin`：私有下游 `git@github.com-bbic:BBIC-Lab/AI_Paper_Hub.git`，只向这里提交/推送私有运行结果。
- 禁止把下游运行态、密钥配置、缓存、日志或生成全文反推到公开上游。
- 首次 push 前必须确认私有仓库地址和权限；本次未执行 push。

## 本机 Git 保护

当前本机配置应保持：

```bash
git remote -v
git config branch.main.remote upstream
git config branch.main.pushRemote origin
git config remote.pushDefault origin
git config push.default current
```

保护措施：

- `upstream` 的 push URL 设置为 `DISABLED_NO_PUSH_TO_PUBLIC_UPSTREAM`。
- `main` 默认从 `upstream/main` 拉取，但默认只推送到 `origin`。
- `.git/hooks/pre-push` 阻止向非 `origin` 远端推送，并阻止任何指向 `AI_Daily_Paper_Reader` 的直接 push。
- 推送前先检查 `git remote -v`、`git status --short`、`git diff --check`。

## Daily workflow 私有部署

- `.github/workflows/daily-paper-reader.yml` 仅允许在私有仓库 `BBIC-Lab/AI_Paper_Hub` 运行。
- Runner 使用 `[self-hosted, linux, dpr-local-inference]`，对应 spark-d326 上的 self-hosted runner label。
- 定时任务为 `0 19 * * 0-4`，GitHub Actions cron 使用 UTC，即北京时间周一至周五 03:00；`workflow_dispatch` 保留用于手工测试。
- Embedding endpoint 默认 `http://127.0.0.1:8010/v1/embeddings`，reranker endpoint 默认 `http://127.0.0.1:8011/v1/rerank`；可用仓库 Variables 覆盖，但必须保持 127.0.0.1/localhost loopback。
- Preflight 会检查 `8010/health`、`8011/health`，再用 Bearer Key 请求 embedding/rerank 模型接口；日志只输出检查结论，不输出 Authorization Header 或 Key。
- 日报生成结果只执行 `git push origin HEAD:<branch>`；workflow 和本机 hook 都禁止推送到公开上游。

## 前端访问与模型配置

- GitHub Pages 站点预计为 `https://bbic-lab.github.io/AI_Paper_Hub/`；需在私有仓库 Settings -> Pages 中选择 `main` 分支和根目录或项目既有发布目录后访问。
- 前端访问后先完成 GitHub Token 登录；Token 需具备 `repo`、`workflow`、`gist` 权限，才能写入 Secrets/Variables 并触发 workflow。
- 进入设置页的“高级配置/模型服务”区域，选择自定义 Embedding/Reranker；endpoint 和模型名写入 GitHub Actions Variables，API Key 只写入 GitHub Actions Secrets。
- 私有部署建议值：`DPR_EMBED_ENDPOINT=http://127.0.0.1:8010/v1/embeddings`，`DPR_RERANK_ENDPOINT=http://127.0.0.1:8011/v1/rerank`；不要把模型端口开放到公网。

GitHub 私有仓库需要配置：

- Secrets：`MODEL_API_KEY`（本机 embedding/rerank Bearer Key）、`DPR_LLM_API_KEY`（如日报摘要仍需 LLM）。
- Variables：`DPR_EMBED_ENDPOINT`、`DPR_RERANK_ENDPOINT`、`DPR_EMBED_MODEL`、`DPR_RERANK_MODEL`；可选 `DPR_LLM_BASE_URL`、`DPR_LLM_MODEL`、`DPR_LLM_PROVIDER`、`DPR_LLM_REWRITE_MODEL`、`DPR_LLM_FILTER_MODEL`、`DPR_LLM_SUMMARY_MODEL`。

## 日常同步步骤

仅同步上游代码到私有下游：

```bash
cd /home/jy/BBIC_AI_Paper_Hub
git fetch upstream main
git merge --no-ff upstream/main
git diff --check
git status --short
```

确认无密钥和运行态误入暂存区后，才可提交到私有下游：

```bash
git add <确认过的路径>
git commit -m "chore: sync upstream into private workstation"
git push origin main
```

不要运行 `git push upstream ...`，不要把 `origin` 改成公开上游。

## 允许提交到私有下游的生成结果

这些内容可保留在私有下游，用于展示日报页面，但不得同步回公开上游：

- `docs/YYYYMM/DD/*.md`：生成后的日报 Markdown 页面。
- `docs/README.md`、`docs/_sidebar.md`：日报首页和侧栏索引。
- `docs/reports/**/README.md`、`docs/reports/**/report.meta.json`：私有周期报告页面与必要元数据。
- `docs/assets/figures/**`：被私有日报或报告页面引用的抽图资源。

## 不得提交的运行态内容

以下内容只留在工作站本地或安全运行环境，不提交到公开上游；默认也不应进入私有下游 Git 历史：

- 密钥和个性化凭据：`.env*`、`secret.private`、`secrets/`、`*.key`、`*.pem`、`credentials*.json`。
- 抓取/排序/推荐中间态：`archive/**`（除 `archive/.gitkeep`）、`runtime/`、`runs/`、`state/`。
- 缓存和模型文件：`hf_cache/`、`cache/`、`.cache/`、`.ruff_cache/`、`.mypy_cache/`。
- 日志和临时文件：`logs/`、`*.log`、`tmp_tests*/`、`.pytest_cache/`。
- 本地上传和原始材料：`docs/assets/local_pdfs/**`、`docs/local-pdf/**`、`paper_reader/**`、`*.pdf`。
- 生成日报中的全文/中间文件：`docs/YYYYMM*/**/*.txt`、`docs/YYYYMM*/**/*.json`、`docs/YYYYMM*/**/*.pdf`、`docs/YYYYMM*/**/*.html`。
- 本地数据库和运行队列：`*.db`、`*.sqlite*`、`trash/**`、`actions-runner/`、`_work/`、`_diag/`。

## 密钥处理

- 不把 API Key、Token、Cookie、SSH 私钥或服务凭据写入仓库文件。
- 需要运行时使用环境变量、`.env`、`secret.private` 或 GitHub Secrets；这些路径已被 `.gitignore` 排除。
- 如果发现密钥进入 Git 历史，立即停止同步并轮换密钥。
