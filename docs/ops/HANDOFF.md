# 私有论文工作站初始化交接

审计时间：2026-06-11 11:28 HKT
主机：spark-d326
范围：私有下游工作站仓库初始化与同步边界配置；已安装 self-hosted runner，未改 workflow，未启动/停止模型服务，未改防火墙，未推送代码。
敏感信息规则：本文件不记录 Token、API Key、凭据值；后续也不要把密钥写入本文件、终端日志或 Git。

## 环境结论

- OS：Ubuntu 24.04.3 LTS；Kernel：Linux 6.11.0-1016-nvidia。
- CPU 架构：aarch64；在线线程数：20。
- 当前用户：jy；uid=1007，groups=jy,users。
- sudo：`sudo -n true` 返回 rc=1，当前无法无交互 sudo，可能需要密码或未授权。
- 磁盘：根分区 `/` 为 ext4，3.7T 总量，536G 已用，3.0T 可用，使用率 16%。
- 工具：`python3` 3.12.3、`git` 2.43.0、`curl` 8.5.0、`systemctl`/systemd 255、`tmux` 3.4 均可用；`python` 命令缺失。
- systemd：PID 1 为 systemd，`XDG_RUNTIME_DIR` 已设置。

## 仓库状态

### `/home/jy/AI_Daily_Paper_Reader`

- 存在且是 Git 仓库。
- 当前分支：`main`，工作区干净，状态为 `main...origin/main [ahead 10]`。
- 远端（已脱敏）：
  - `origin`: `git@github.com:Jurio0304/AI_Daily_Paper_Reader.git`
  - `private`: `git@github.com:Jurio0304/AI_Daily_Paper_Reader_Private.git`
- 本次未修改公开上游工作目录或远端配置，未 push。

### `/home/jy/BBIC_AI_Paper_Hub`

- 已从本机公开上游工作目录 `/home/jy/AI_Daily_Paper_Reader` 初始化为 Git 工作目录。
- 当前分支：`main`，跟踪 `upstream/main`，状态为 `main...upstream/main [ahead 10]`。
- 远端：
  - `upstream`: `git@github.com:Jurio0304/AI_Daily_Paper_Reader.git`，fetch only；push URL 为 `DISABLED_NO_PUSH_TO_PUBLIC_UPSTREAM`。
  - `origin`: `git@github.com-bbic:BBIC-Lab/AI_Paper_Hub.git`，作为私有下游推送目标；`github.com-bbic` 使用本机 BBIC 专用 SSH key。
- 本机 Git 保护：
  - `branch.main.remote=upstream`，默认从公开上游拉取。
  - `branch.main.pushRemote=origin`、`remote.pushDefault=origin`、`push.default=current`，默认只向私有下游推送。
  - `.git/hooks/pre-push` 阻止向非 `origin` 远端推送，并阻止直接推送到 `AI_Daily_Paper_Reader`。
- 已只读检查 `git@github.com-bbic:BBIC-Lab/AI_Paper_Hub.git`，访问成功且当前为空仓库。

## 下游生成结果边界

- 可提交到私有下游、但不得同步回公开上游：`docs/YYYYMM/DD/*.md`、`docs/README.md`、`docs/_sidebar.md`、`docs/reports/**/README.md`、`docs/reports/**/report.meta.json`、被页面引用的 `docs/assets/figures/**`。
- 不得提交到公开上游；默认也不应进入私有下游 Git 历史：`.env*`、`secret.private`、`secrets/`、凭据文件、`archive/**`（除 `archive/.gitkeep`）、`hf_cache/`、日志、缓存、临时文件、`docs/assets/local_pdfs/**`、`docs/local-pdf/**`、`paper_reader/**`、生成全文/原始 PDF/本地数据库。
- 详细日常步骤见 `docs/ops/PRIVATE_WORKSTATION.md`。

## 本地模型服务

- Embedding health：`http://127.0.0.1:8010/health` 返回 HTTP 200，响应体 0 bytes。
- Reranker health：`http://127.0.0.1:8011/health` 返回 HTTP 200，响应体 0 bytes。
- 监听地址：
  - `8010`: `127.0.0.1:8010`
  - `8011`: `127.0.0.1:8011`
- 结论：两个模型服务当前均仅监听 `127.0.0.1`，未发现绑定 `0.0.0.0` 或公网地址。

## Workflow 检查

当前 workflow 文件均仍使用 `runs-on: ubuntu-latest`：

- `.github/workflows/daily-paper-reader.yml:34`
- `.github/workflows/email-daily-brief.yml:26`
- `.github/workflows/local-pdf-deep-read.yml:36`
- `.github/workflows/maintain-biorxiv.yml:29`
- `.github/workflows/maintain-chemrxiv.yml:27`
- `.github/workflows/maintain-medrxiv.yml:27`
- `.github/workflows/maintain-supabase.yml:25`
- `.github/workflows/periodic-report.yml:47`
- `.github/workflows/privacy-guard.yml:15`
- `.github/workflows/reset-content.yml:20`
- `.github/workflows/sync.yml:18`

未按本次任务修改任何 workflow。

## Self-hosted runner

- runner 名称：`spark-d326-bbic`。
- 自定义 label：`dpr-local-inference`。
- 服务状态：`systemd --user`，当前 `enabled` 且 `active (running)`；以普通用户 `jy` 运行。

## 配置项控制矩阵

### LLM Chat / Summary / Refine

来源：`src/llm.py:700`、`src/llm.py:707`、`src/llm.py:713`、`src/llm.py:722`、`src/llm.py:730`。

- Provider：`DPR_LLM_PROVIDER`，兼容 `LLM_PROVIDER`；支持 OpenAI-compatible/generic/custom 类配置。
- Endpoint/Base URL：`DPR_LLM_BASE_URL`，兼容 `LLM_BASE_URL`、`OPENAI_BASE_URL`；未配置时默认 OpenAI-compatible base URL。
- Model Name：优先显式参数，其次任务变量 `DPR_LLM_REWRITE_MODEL`、`DPR_LLM_FILTER_MODEL`、`DPR_LLM_SUMMARY_MODEL`、`DPR_LLM_CHAT_MODEL`，再回退 `DPR_LLM_MODEL`、`LLM_MODEL`；周期报告另用 `DPR_LLM_REPORT_MODEL` 回退到 summary/default。
- API Key：`DPR_LLM_API_KEY`，兼容 `LLM_API_KEY`、`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`。

### Embedding

来源：`src/model_loader.py:115`、`src/model_loader.py:117`、`src/model_loader.py:136`、`src/model_loader.py:140`、`src/main.py:553`、`app/subscriptions.manager.js:221`。

- Provider/Profile：`DPR_EMBED_PROFILE` 控制 local/default/custom；`DPR_EMBED_PROVIDER` 控制协议，支持 `legacy` 和 `openai` 类别。
- Endpoint：`DPR_EMBED_ENDPOINT`，兼容 `EMBED_ENDPOINT`、`DPR_EMBED_API_URL`；可通过 `DPR_INFERENCE_BASE_URL`/`INFERENCE_BASE_URL` 拼接；默认 profile 还可用 `DPR_EMBED_DEFAULT_API_URL`。
- Model Name：`DPR_EMBED_MODEL`；未配置时 Step 2.2 默认 `BAAI/bge-small-en-v1.5`。
- API Key：custom 使用 `DPR_EMBED_API_KEY`，兼容 `EMBED_API_KEY`、`EMBED_KEY`；default profile 使用 `DPR_EMBED_DEFAULT_API_KEY`。
- 其他：`DPR_EMBED_API_TIMEOUT` 控制超时，`DPR_EMBED_REMOTE_FALLBACK` 控制本地回退或失败。

### Reranker

来源：`src/reranker.py:97`、`src/reranker.py:98`、`src/reranker.py:99`、`src/reranker.py:111`、`src/main.py:212`、`app/subscriptions.manager.js:282`。

- 启停：`DPR_SKIP_RERANK`；默认跳过 rerank，显式禁用跳过后才会尝试远程 rerank。
- Provider：`DPR_RERANK_PROVIDER`；支持 OpenAI-compatible/vLLM 归一为 `openai`。
- Endpoint：`DPR_RERANK_ENDPOINT`，兼容 `RERANK_ENDPOINT`；可通过 `DPR_INFERENCE_BASE_URL`/`INFERENCE_BASE_URL` 拼接。
- Model Name：`DPR_RERANK_MODEL`，或命令行 `--rerank-model`。
- API Key：`DPR_RERANK_API_KEY`，兼容 `RERANK_API_KEY`、`RERANK_KEY`。
- 其他：`DPR_RERANK_API_TIMEOUT` 控制超时。

## 风险点

- 私有下游远端已切换为 `git@github.com-bbic:BBIC-Lab/AI_Paper_Hub.git`；当前为空仓库，首次 push 前仍需确认要公开给该私有组织的内容边界。
- 下游工作目录基于本机公开上游 HEAD 初始化；该 HEAD 比 `upstream/main` 超前 10 个提交。
- 个性化 `config.yaml` / `docs/config.yaml` 若包含私有订阅或服务参数，不得同步回公开上游；API Key 仍必须走环境变量、`.env`、`secret.private` 或 GitHub Secrets。
- 当前用户无法无交互 sudo；runner 已采用 `systemd --user` 运行，`Linger=no`，重启后若需无人登录自启需手工启用 linger。
- `python` 命令缺失；脚本应优先使用 `python3` 或项目指定运行器。
- 健康端点仅返回 HTTP 200 且空响应体；只能确认端口和 HTTP 层存活，不能确认模型权重或推理质量。

## 需要手工提供的信息

- 私有 GitHub 仓库地址和权限已确认：`git@github.com-bbic:BBIC-Lab/AI_Paper_Hub.git`。
- runner 已注册：名称 `spark-d326-bbic`，label `dpr-local-inference`，以普通用户 `jy` 运行。
- GitHub Secrets 中需要配置的非公开值：LLM、Embedding、Reranker、Supabase/SMTP 等密钥值；仅通过 GitHub Secrets 或安全通道设置。
- 私有工作站部署分支策略：跟随 `origin/main`、固定私有分支，还是使用当前审计分支。

## 本次修改

- 初始化私有下游工作目录：`/home/jy/BBIC_AI_Paper_Hub`。
- 配置 `upstream` / `origin` 远端、默认拉取/推送策略和本机 `pre-push` 误推保护。
- 切换 `origin` 到 `BBIC-Lab/AI_Paper_Hub`，并配置本机 `github.com-bbic` SSH host alias。
- 更新下游 `.gitignore`，排除运行态、缓存、日志、凭据、本地上传、全文/原始 PDF 等内容。
- 新增非敏感边界说明：`docs/ops/PRIVATE_WORKSTATION.md`。
- 更新本交接文件：`docs/ops/HANDOFF.md`。
- 安装并启动 self-hosted runner：名称 `spark-d326-bbic`，label `dpr-local-inference`，服务状态为 `systemd --user enabled/active`。
