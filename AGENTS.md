# Codex 降费操作规范

本文件只放会话自动加载时最需要的降费约束。详细项目流程、隐私边界、发布与验证规则保留在 `.codex/skills/ai-paper-reader/SKILL.md`，按任务需要使用该 skill。

## 仓库角色

- 默认修改主开发仓库 `Jurio0304/AI_Daily_Paper_Reader`（本地 `origin`）。
- `Jurio0304/AI_Daily_Paper_Reader_Private`（本地 `private`）仅作为辅助同步目标。
- 不要把 `private/main` 整体反推到 `origin/main`；只能把 `origin/main` 的公开安全内容同步到 `private/main`。

## 命令语义

- 用户提到“提交”“推送”“发布”时，默认代表：提交到 `origin/main`，再运行提交且同步脚本 `scripts/publish-dual.ps1` 把公开安全变更同步到 `private/main`。
- 用户提到“同步”“仅同步”“更新私有库”时，默认代表：只运行 `scripts/sync-origin-to-private.ps1`，把 `origin/main` 的新提交中公开安全的文件同步到 `private/main`，不修改 `origin`。
- 同步脚本必须严格保留私有运行态边界：不得同步或删除 `secret.private`、个性化 `config.yaml` / `docs/config.yaml`、`docs/20*`、`docs/assets/figures/`、`archive/`、`.codex/`、`TODO.md`、环境文件、日志和缓存。

## 上下文预算

- 先按用户给定范围行动；范围不明时，先做最小安全检查，不要主动扩大到生成内容目录。
- 先用 `rg` / `rg --files` 精确定位，再读取必要的小片段。
- 默认只看：`app/`、`src/`、`tests/`、`.github/`、`scripts/`、`docs_init/`、`README.md`。
- 未经明确要求，不要读取、展开或总结：`docs/20*`、`docs/assets/figures/`、`archive/`、`figs/`、`others/`、日志、缓存、生成报告全文。
- 如果确实需要生成内容示例，先只抽取 1 个最小文件片段。

## 输出预算

- 不要粘贴大段文件、日志、diff、测试输出；优先摘要并给路径/行号。
- 回答默认简短；只有用户要求时再展开细节。

## 前端验证预算

- 前端改动不要默认打开浏览器；只有用户明确要求、涉及可见布局/交互、或代码检查无法判断时才做浏览器验证。
- 浏览器验证只打开最小目标页面和目标区域，避免打开 `docs/20*`、Daily Papers、生成报告全文页面。
- 不输出完整 DOM、可访问性树、console、网络日志或截图长描述；只写关键观察和是否通过。
- 每个前端任务最多做 1 轮浏览器验证；需要更多轮时先说明原因。

## 审查意识

- 默认假设 Codex 辅助开发的过程、代码变更、命令记录和最终结论都会受到 Claude 审查。
- 任何结论都必须能追溯到实际文件、命令结果或明确假设；无法验证时直接说明，不得包装成已确认事实。
- 交付前按审查视角自检：变更是否最小、是否混入无关文件、是否有验证依据、是否存在未说明风险。
- 验证说明只列命令、结果和关键路径；不得为了“看起来完整”输出长篇解释。
