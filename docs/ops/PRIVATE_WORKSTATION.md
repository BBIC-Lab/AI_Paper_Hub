# 私有下游工作站边界

更新时间：2026-06-10 21:12 HKT
范围：`/home/jy/BBIC_AI_Paper_Hub` 作为私有下游日常运行仓库；不安装 runner，不修改模型服务，不记录任何 API Key。

## 仓库角色

- `upstream`：公开上游 `git@github.com:Jurio0304/AI_Daily_Paper_Reader.git`，只用于拉取开发维护代码。
- `origin`：私有下游 `git@github.com:Jurio0304/BBIC_AI_Paper_Hub.git`，只向这里提交/推送私有运行结果。
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
