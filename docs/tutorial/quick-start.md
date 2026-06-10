# 从零开始配置

本教程带你从一个刚 Fork 的仓库开始，完成运行日报所需的最小配置。完成后，你应该能在 GitHub Actions 中手动触发一次日报，并在网页上看到更新后的首页和 Daily Papers。

## 开始前准备

- 一个可用的 GitHub 账号。
- 一个已经 Fork 或克隆的 AI Daily Paper Reader 仓库。
- 一个 OpenAI 兼容服务的 API Key、Base URL 和模型名。
- 如果你打算让站点自动发布，需要开启 GitHub Pages。

【截图占位：仓库 Fork 按钮与目标账号选择页面】

## Step 1：Fork 仓库并确认默认分支

1. 打开项目仓库，点击 Fork，把仓库复制到自己的账号或组织。
2. 进入 Fork 后的仓库，确认默认分支是 main。
3. 如果你是在本地开发，先拉取 main，并新建自己的工作分支；不要直接在 main 上反复试验。

检查点：仓库首页能看到 README、docs、app、src 和 .github/workflows 等目录。

【截图占位：Fork 后仓库首页与默认分支位置】

## Step 2：开启 GitHub Actions

1. 进入仓库的 Actions 页面。
2. 如果 GitHub 提示需要启用 workflows，点击启用。
3. 在左侧工作流列表中找到 Daily Paper Reader 相关工作流。

检查点：Actions 页面不再显示禁用提示，并且可以看到手动运行按钮。

【截图占位：Actions 启用提示与工作流列表】

## Step 3：配置模型访问密钥

1. 进入 Settings -> Secrets and variables -> Actions。
2. 新增模型访问所需的 Secrets。最小配置通常包括 API Key、Base URL 和模型名。
3. 如果你使用多个任务模型，可以再分别配置改写、过滤、总结等模型名；如果不确定，先使用同一个模型完成首次运行。

建议先用成本较可控的模型跑通流程，再逐步提升总结和精读质量。

【截图占位：Actions Secrets 新增页面】

## Step 4：开启 GitHub Pages

1. 进入 Settings -> Pages。
2. Source 选择 Deploy from a branch。
3. Branch 选择 main，目录选择根目录或仓库当前文档约定的发布目录。
4. 保存后等待 GitHub Pages 完成首次部署。

检查点：Pages 页面出现站点地址，打开后能看到 AI Daily Paper Reader 网页。

【截图占位：GitHub Pages 分支与目录设置页面】

## Step 5：完成网页端基础配置

1. 打开站点首页，进入配置或使用教程入口。
2. 按提示填写模型服务信息、研究方向和每日候选数量。
3. 保存配置后，确认页面没有报错，并且配置项能被重新读取。

如果你只想先跑通，可以先保留默认论文源，再添加一个最熟悉的研究主题作为查询。

【截图占位：网页端模型配置与保存按钮】

## Step 6：手动触发第一份日报

1. 回到 GitHub Actions。
2. 打开 Daily Paper Reader 工作流，点击 Run workflow。
3. 选择 main 或你的测试分支，启动运行。
4. 等待工作流完成后，刷新站点首页和 Daily Papers。

检查点：最新日报出现在首页，侧边栏 Daily Papers 下可以打开对应日期。

【截图占位：Run workflow 按钮与成功运行记录】

## 常见问题

| 现象 | 可能原因 | 处理方式 |
| --- | --- | --- |
| Actions 找不到手动运行按钮 | 工作流未启用或当前分支没有工作流文件 | 先启用 Actions，确认 .github/workflows 中存在日报工作流 |
| 页面打开后没有最新日报 | Pages 尚未部署完成，或日报生成失败 | 查看 Actions 日志，再刷新 Pages 地址 |
| LLM 步骤失败 | API Key、Base URL 或模型名不正确 | 先用同一模型跑通，再拆分多模型配置 |
| 论文数量过少 | 查询过窄或论文源未更新 | 放宽关键词，检查订阅配置和抓取时间窗口 |

下一步：继续阅读 [订阅与查询配置](/tutorial/configuration)，把默认配置改成你的研究方向。
