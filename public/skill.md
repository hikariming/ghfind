---
name: ghfind-cli
description: >
  使用 ghfind CLI 评分、扫描、锐评、对比 GitHub 账号，并在终端浏览 ghfind.com
  榜单和开发者目录。当用户想评估账号、识别刷量、生成评分徽章，或按语言、组织、仓库
  发现开发者时使用。若只需直接调用 REST/MCP、无需安装 CLI，优先使用 ghfind-score skill。
license: AGPL-3.0-or-later
---

# ghfind CLI

`ghfind` 是 ghfind.com 开发者价值与可信度评分引擎的命令行客户端，分数为 0–100，
评分核心不使用 LLM。CLI 不在本地扫描或评分，每条命令都会请求网站 API。
不要在本地重新实现评分，也不要导入项目内部模块。

## 安装

运行 `curl -fsSL https://ghfind.com/install.sh | bash`，同时安装官方 CLI 和此 Skill。
如只安装 CLI，运行 `npm install -g @hikariming/ghfind`。需要 Node.js 18 或更新版本。

预编译程序：https://github.com/hikariming/ghfind/releases

## 配置

- 默认访问 `https://ghfind.com`。可用 `GHFIND_HOST` 或 `--host` 指定其他站点，
  例如本地服务 `--host http://localhost:3000`。
- `score`、`vs`、`search`、`exists`、`stats`、`leaderboard` 和 `developers`
  是公开命令，无需鉴权。`scan` 和 `roast` 使用的 `POST /api/scan` 在生产环境
  需要个人 API Token。在 https://ghfind.com/integrations 使用 GitHub 登录并创建，
  再设置 `GHFIND_API_KEY` 或传入 `--api-key`；请求使用 `Authorization: Bearer`。
  浏览器 OAuth 会话 Cookie 不能作为 CLI 凭证。
- 不要把 GitHub Token 或 LLM API Key 传给普通评分命令，这些密钥由服务端管理。
  例外：`exists --github-token` 使用调用者配额提高 GitHub 请求上限；
  `roast --byo-*` 使用用户自己的 OpenAI 兼容模型服务生成锐评。

## 命令

供程序读取时优先使用 `-o json`。在运行时查看完整命令列表：

```bash
ghfind commands --json
ghfind commands show roast --json
```

评分与证据（基于事实、结果确定）：

```bash
ghfind score <username> -o json     # 优先调用：公开 GET /api/score，支持缓存，
                                    # 首次查询的账号会实时评分
ghfind scan <username> -o json      # 完整证据：指标、仓库、PR、维度分、风险信号；
                                    # 生产环境需要 API Token
```

展示与对比：

```bash
ghfind roast <username> --lang zh -o markdown
ghfind vs <a> <b> -o json
```

工具与发现：

```bash
ghfind exists <username> -o json
ghfind search <query> -o json
ghfind badge <username> --markdown
ghfind card <username>
ghfind stats -o json
ghfind leaderboard --view trending --window 7d -o json
ghfind developers --type language -o json
ghfind developers --type org --value apache -o json
ghfind auth status -o json
```

自行更新（仅在用户明确要求升级时执行；自动化流程先运行 `--dry-run`）：

```bash
ghfind update check -o json
ghfind update install --method binary --dry-run -o json
```

## 管理 ghfind Review bot（`ghfind bot`）

用户是某个仓库的管理员，并且装了 ghfind Review GitHub App 时，可以用 `ghfind bot` 代他查看和处理 bot。
需要个人 API Token（`GHFIND_API_KEY`，`ghf_` 开头）。Token 必须由用户本人在
https://ghfind.com/integrations 创建，并显式勾选 **Manage the ghfind Review bot（管理 ghfind Review bot）**，
不要尝试替用户创建。所有 bot 命令（包括查看）都需要 `bot` 权限；存量 Token 仍仅能扫描。
收到 `token_scope_required` 时，引导用户创建带该权限的新 Token，不要重复请求或尝试绕过。
bot 每次请求都会实时检查该 GitHub 账号对仓库的权限：
查看需要 write 权限，任何修改都需要 admin。

```bash
ghfind bot status owner/repo -o json                 # 设置、失败任务、最近清理、操作日志
ghfind bot settings get owner/repo
ghfind bot settings set owner/repo --triage off      # 只改给出的开关
ghfind bot pause owner/repo                          # 关闭 issue 和 PR 处理，取消排队任务
ghfind bot resume owner/repo
ghfind bot backfill owner/repo -n 25
ghfind bot retry owner/repo [job-id]
ghfind bot cleanup owner/repo --labels all --comments -o json   # 只预览，返回 confirm_token
ghfind bot cleanup confirm owner/repo <confirm_token> --wait    # 执行预览过的清理
ghfind bot cleanup status owner/repo <cleanup-id>
ghfind bot cleanup cancel owner/repo <cleanup-id>
```

bot 出问题时的标准流程：

1. `ghfind bot status owner/repo -o json`：看 `settings`、`jobs.failed`、`jobs.recent` 和 `cleanup`，先弄清原因。
2. 需要立刻止损时运行 `ghfind bot pause owner/repo`。
3. 需要撤销 bot 写入的内容时，先预览：`ghfind bot cleanup owner/repo --labels review|triage|all [--comments] [--delete-label-definitions] -o json`。
   把 `summary` 里的候选数量告诉用户。执行前会验证同名标签的最新事件属于 bot；人工重新打的标签、
   未知归属或读取失败会保留，`skipped` 包含已不存在和保留的条目。标签定义只在没有任何 issue/PR 使用时删除。`summary.bot_active` 为 true 时先暂停。
4. 用户明确同意这次预览后，才运行 `ghfind bot cleanup confirm owner/repo <confirm_token> --wait`。
   确认码 10 分钟后过期，过期就重新预览。不要在用户没看到预览时直接确认。
5. 问题解决后按用户意愿 `ghfind bot resume owner/repo`，失败任务用 `ghfind bot retry` 重试。

清理只会删除 bot 自己写入的内容：`review:` 标签、bot 记录过的意图标签、bot 自己的评分评论，
可选删除 5 个 `review:` 标签定义。人工打的标签和意图标签的定义永远不会被删除。
常见错误码：`invalid_token`（Token 无效或已撤销）、`not_found`（App 没装在该仓库、仓库不存在或没有 write 权限，
三者不作区分）、`admin_required`、`rate_limited`（每个账号每分钟 60 次、每小时 600 次）、`cleanup_busy`、
`confirm_token_expired`。

## 结果含义

- `score` / `scan` 返回事实性评分数据，包括 `final_score`、`tier`、
  `sub_scores`、`red_flags` 和百分位。自动化判断应使用这些字段。
- `roast` 返回网站面向人的锐评，包括标签、`roast_line` 和带有玩笑、讽刺的
  Markdown。只能将它用于面向用户的文案，不能把锐评文字当成独立事实证据。
- `vs` 的胜者和分差区间由确定性规则给出；判词由 LLM 生成，也可能为空。
  两个账号必须已经评分，否则返回 `404 need_both`。
- `stats` / `leaderboard` / `developers` 是缓存的发现数据。对某个账号
  作具体判断前，应调用 `score` 或 `scan`。
- 低分仅反映账号公开的 GitHub 足迹；私有组织中的工作不在评分范围内。
