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
