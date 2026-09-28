<div align="center">

# ghfind 🔥

### 发现最佳开发者，也成为其中之一。

一个基于真实公开数据的平台：**发现**优秀开发者、**看清**自己的位置、并从这里**成长**。

先来一发扎在公开数据上的 **0–100 分价值与信任评分**：看清差距、知道往哪努力；再逛发现榜找到同技术栈的高手、值得较量的「对家」，也让世界发现你自己的作品。

[English](./README.md) · **中文**

[**🔍 测测 GitHub 成色**](https://ghfind.com) · [**🏆 发现最佳开发者**](https://ghfind.com/leaderboard) · [**🤖 安装 GitHub Bot**](https://github.com/apps/ghfind-review/installations/new) · [**⭐ 查看源码**](https://github.com/hikariming/ghfind)

</div>

[![ghfind 中文开发者主页预览](./show_img/usercard_cn.png)](https://ghfind.com/u/hikariming)

## 看清、成长、发现

### 📊 30 秒看清自己的位置

输入 GitHub 用户名，即可得到 **0–100 分**的价值与信任评分、五档等级（🏆 夯 / 🥇 顶级 / 💪 人上人 / 🫥 NPC / 💩 拉完了），外加一句扎在公开数据上的毒舌点评。六大评分维度与十类刷量信号，专治刷星号、AI 机器人、收藏夹开发者，以及自产自销自审自合的 PR farmer——让分数告诉你哪些是真本事、下一步往哪走。

### 🧭 发现值得认识的开发者

ghfind 不只负责打分，更是一台开发者发现引擎。你可以通过排行榜和公开开发者主页，找到真正活跃的开源贡献者、同技术栈伙伴、潜在合作者，也能看看那些与你旗鼓相当、值得较量的「对家」——同时让对的人发现你。

[![ghfind 开发者排行榜](./show_img/leaderboard.png)](https://ghfind.com/leaderboard)

### 🪪 把开发经历变成可炫耀的身份卡

每次测评都可以生成实时更新的评分徽章，以及适配明暗主题的开发者大卡。把它放进 GitHub 个人主页、项目 README、作品集或个人网站，让公开贡献替你说话。下面就是一个真实示例：

<div align="center">

[![ghfind 评分徽章](https://ghfind.com/api/badge/hikariming)](https://ghfind.com/u/hikariming)

<a href="https://ghfind.com/u/hikariming">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://ghfind.com/api/card/hikariming?theme=dark">
    <source media="(prefers-color-scheme: light)" srcset="https://ghfind.com/api/card/hikariming?theme=light">
    <img alt="hikariming 的 ghfind 开发者卡片" src="https://ghfind.com/api/card/hikariming?theme=light" width="720">
  </picture>
</a>

</div>

评分核心来自开源 Claude 技能 `github-account-value`。网站把它的 Python 打分逻辑 **逐行移植成 TypeScript**，并用单元测试锁定二者输出一致。

## GitHub App：少一点排查来源，多一点时间维护项目

**每一条 issue 都在争取你的注意力。投入处理前，先看清作者的公开贡献背景。**

安装 **ghfind Review**，为新建 issue 打上作者的公开 ghfind 评分标签。
彩色 `review:` 区间帮你整理待办，不必先逐个打开账号。

- **按区间安排处理优先级。** 用 `review:` 标签筛选 issue，为团队制定分层规则。
- **让更强的 profile 信号更醒目。** 低分段用灰白、浅蓝弱化显示，高分段用低饱和的杏色和麦金色标出，亮色模式下不刺眼。
- **在深入处理前先筛查来源。** 将低分或没有评分的 issue 纳入人工来源复核。

当前分档阈值固定为 40、70、90。App 给 issue 和 pull request 打标，
不在讨论区发评论，不会自动拦截或关闭提交。
账号评分是处理线索，不能直接证明贡献质量；新贡献者同样值得认真对待。

**从一个仓库开始，让下一条 issue 自带评分标签。**
App 自动补齐标签，无需在仓库添加 workflow 或 secret。

[**安装 GitHub App**](https://github.com/apps/ghfind-review/installations/new) ·
[**中文安装与使用指南**](./platform/github-app/README.zh.md) ·
[**English guide**](./platform/github-app/README.md)

## 工作原理

```
浏览器 ─▶ /api/scan ─▶ [Redis 缓存?] ─▶ lib/github.ts  (GitHub REST + GraphQL, 运营方 PAT)
                                   └─▶ lib/score.ts   (确定性打分, 与 Python 技能一致)
                                   └─▶ 写入缓存 24h
        ─▶ /api/roast (流式) ─▶ LLM judge pass (受限评分校准)
                                  └─▶ LLM writer pass (只写毒舌与报告)
                                  └─▶ lib/llm.ts (OpenAI 兼容; 默认 StepFun 阶跃; 可自带 Key)
```

- **基础分是确定性的**,由 `lib/score.ts` 在服务端算出。
- 大模型分两层:务实 judge 只做事实复核和**至多 ±10** 的受限校准;writer 只根据固定结果写标签、顶部毒舌和完整报告,不能改分。
- 6 个维度(账号成熟度 / 原创项目质量 / 贡献质量 / 外部生态贡献 / 社区影响力 / 活跃真实性)+ 10 条刷量 red flag,权重向**难以造假**的信号(合并进真实仓库的 PR、持续活跃)倾斜,对**可购买**的信号(star、粉丝)压低权重。
- 站点还包含分享卡片、README 小徽章、个人页评论、GitHub 登录后的个人页反应。

## ghfind API、MCP 服务器与 SDK

站点全部能力都可编程调用,完整参考见 **[ghfind API 文档](https://ghfind.com/docs)**:

- **REST API** — `GET https://ghfind.com/api/score/{username}` 拿确定性 0–100 分(无需认证、不经过 LLM);OpenAPI 3.1 规范见 [ghfind.com/openapi.json](https://ghfind.com/openapi.json)
- **MCP 服务器** — Streamable HTTP,位于 [ghfind.com/mcp](https://ghfind.com/mcp);加进 Claude、Cursor 或任意 MCP 客户端即可在 Agent 内评分和对比 GitHub 账号
- **SDK** — [`@hikariming/ghfind`](https://www.npmjs.com/package/@hikariming/ghfind)(npm)· [`ghfind`](https://pypi.org/project/ghfind/)(PyPI)
- **面向 AI Agent** — [ghfind.com/llms.txt](https://ghfind.com/llms.txt) 链接所有机器可读入口

## 本地开发

```bash
pnpm install
cp .env.example .env.local
```

使用 Docker 启动本地 HTTP libSQL 服务（也可以使用托管的 Turso 数据库）：

```bash
docker run -d --name ghfind-libsql -p 127.0.0.1:8080:8080 \
  -v ghfind-libsql-data:/var/lib/sqld \
  ghcr.io/tursodatabase/libsql-server:latest
```

Apple Silicon 请使用 `latest-arm` 镜像标签，详见
[libSQL Docker 指南](https://github.com/tursodatabase/libsql/blob/main/docs/DOCKER.md)。
命名卷将数据库文件保存在仓库之外。已有容器可用 `docker start ghfind-libsql` 重新启动。

启动应用前，在 `.env.local` 中设置：

```dotenv
GITHUB_TOKEN=<你的 GitHub PAT>
TURSO_DATABASE_URL=http://127.0.0.1:8080
TURSO_AUTH_TOKEN=
```

使用托管 Turso 时，改为对应的数据库 URL 和认证 token。应用首次访问本地 libSQL
数据库时会自动建表。当前使用的 web 客户端不支持 `file:` URL。
使用服务端付费模型生成锐评文字还需配置 `LLM_API_KEY`；确定性扫描和评分不需要它。

```bash
pnpm dev
```

> **务必配置 `GITHUB_TOKEN`。** 没有 token 时,GitHub 的 GraphQL 贡献/活跃度/外部贡献等维度会全部归零(评分被严重低估),且 REST 限速只有 60/h。一个只读 PAT 即可把限速提到 5000/h 并解锁全部维度。

### 命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 本地开发 |
| `pnpm start` 或 `pnpm build/start` | 一键生产构建并运行 |
| `pnpm build` / `pnpm start:prod` | 仅构建 / 运行已有生产构建 |
| `pnpm cli:build` | 构建独立的 `./bin/ghfind` CLI（需要 Go 1.23+） |
| `pnpm test` | Vitest 测试套件(打分、prompt、DB、UI helper、reaction 等) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |

### Agent CLI

CLI 是网站 API 的远程调用封装,不会在本地运行 GitHub 扫描、评分或 LLM
逻辑。

安装 Go 1.23+ 后构建独立二进制：

```bash
pnpm cli:build
./bin/ghfind commands --json
./bin/ghfind update check -o json
./bin/ghfind score hikariming -o json
./bin/ghfind roast hikariming --lang zh -o markdown
./bin/ghfind leaderboard --view trending --window all -o json
./bin/ghfind developers --type language -o json
```

独立 CLI 构建为 `./bin/ghfind`。单独发布的 npm SDK 也提供 `ghfind` 可执行命令，
但根工作区不会安装该 SDK。

默认服务端域名是 `https://ghfind.com`。本地联调可以覆盖:

```bash
GHFIND_HOST=http://localhost:3000 ./bin/ghfind roast hikariming --lang zh
```

`GITHUB_ROAST_HOST` 仍作为旧版本兼容别名保留。

生产环境的 `/api/scan` 对浏览器走 Turnstile。agent/CLI 调用可以在服务端设置
`GITHUB_ROAST_CLI_API_KEY`,并在 CLI 侧用 `GHFIND_API_KEY` 或 `--api-key` 传入;
CLI 会向同一个 `/api/scan` 端点发送
`Authorization: Bearer ...`。
`GITHUB_ROAST_API_KEY` 仍作为旧版本兼容别名保留。

`/api/scan` 会先检查机器认证或 Turnstile,然后才读取 scan 缓存或使用服务端
GitHub token。如果生产环境没有配置 `GITHUB_ROAST_CLI_API_KEY` 且启用了
Turnstile,未认证的 CLI 请求可能在查缓存之前就失败,即使服务端本身有
GitHub token 和 Redis 缓存。

版本/更新管理:

```bash
ghfind --version
ghfind update check -o json
ghfind update install --method binary --dry-run -o json
ghfind update install --method binary
ghfind update npm --dry-run -o json
ghfind update npm
ghfind update pip
ghfind update brew
```

`update check` 会对比本地 CLI 版本和 GitHub 最新 release,输出
`update_available`、`latest_version` 和 `release_url`。它只做检查和提示,不会自动
修改已安装的二进制。

`update install --method binary` 会下载当前平台对应的 GitHub release asset,写到
当前二进制旁边,再通过 rename 替换本地 `ghfind`。建议先加 `--dry-run` 查看会选择
哪个 asset 和目标路径。包管理器快捷命令会执行对应升级命令:

- `ghfind update npm`: `npm install -g @hikariming/ghfind@latest`
- `ghfind update pip`: `python3 -m pip install --upgrade ghfind`
- `ghfind update brew`: `brew upgrade ghfind`

这些命令只有在被显式调用时才会修改本地安装;`update check` 不会触发自动升级。

已接入的网站 API:

- `scan` / `score`: `POST /api/scan`,客观结构化评分数据。
- `roast`: `POST /api/scan` + `POST /api/roast`,网页端同款 roast 报告。
- `stats`: `GET /api/stats`,平台聚合统计。
- `leaderboard`: `GET /api/leaderboard`,缓存的榜单/发现入口。
- `developers`: `GET /api/developers`,按 language/org/repo 的开发者发现目录。

agent 要判断单个账号时应使用 `scan` 或 `score`;排行榜和开发者目录只作为发现/
候选人入口,不是单账号的最新评分事实来源。

## 环境变量

见 [`.env.example`](./.env.example)。本地扫描需要 `GITHUB_TOKEN` 和可连接的数据库（`TURSO_DATABASE_URL`，以及数据库要求认证时的 `TURSO_AUTH_TOKEN`）。新扫描必须成功保存结果才能返回成功。使用服务端付费模型生成锐评文字时再配置 `LLM_API_KEY`（默认 StepFun 阶跃，也支持其他 OpenAI 兼容服务）。Redis 缓存/限流、Turnstile 和 GitHub OAuth 对本地扫描是可选项，配置后启用对应功能。首页能打开不代表扫描已经可用。生产环境需要 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN`：限流服务不可用时，受保护且未命中缓存的计费路由返回带 `Retry-After` 的 `503`，边缘缓存响应和普通浏览仍可用。`RATE_LIMIT_FAIL_OPEN=1` 仅供运维应急使用，正常运行时不要设置。

## 排行榜 + 百分位(Cloudflare D1)

生产环境使用 `wrangler.jsonc` 中的 Cloudflare D1 绑定 `GHFIND_D1`。部署前请按
[Cloudflare 部署手册](./docs/operations/cloudflare-deployment-runbook.md)核对目标账号和数据库；`TURSO_*`
只保留给本地开发/维护脚本，不是生产数据库。
每次扫描把账号的最新分数 upsert 进库(一账号一行);百分位 = 库里分数严格低于你的占比。
**公开榜只收录 ≥60 分的账号**,低分号仍参与百分位统计但不被公开点名(防骚扰)。数据库未配置时排行榜展示可以降级，但新扫描需要可用的持久化存储。

```bash
# 仅本地开发
TURSO_DATABASE_URL=http://127.0.0.1:8080
```

## 部署到 Cloudflare Workers

当前前端和后端由同一个 OpenNext Cloudflare Worker 承载。账号/资源预检、
Secrets、冒烟验证和回滚请看
[Cloudflare 部署手册](./docs/operations/cloudflare-deployment-runbook.md)。

```bash
pnpm exec wrangler whoami
pnpm cf:build
pnpm cf:deploy:dev       # dev.ghfind.com
pnpm cf:deploy:prod      # ghfind.com
```

生产部署也会由 `main` 分支触发
[Cloudflare GitHub Actions](./.github/workflows/deploy-cf-production.yml)。
Secrets 用 `wrangler secret put --env <env>` 配置，不要提交密钥值；Cloudflare
D1/R2 绑定统一维护在 [`wrangler.jsonc`](./wrangler.jsonc)。

## 自带模型 / API Key

点页面上的「用自己的模型」,填 Base URL + API Key + Model。兼容任意 OpenAI 接口(OpenAI / OpenRouter / Groq / DeepSeek / 本地)。**Key 只存在你自己的浏览器 localStorage,调用时直传,绝不上传到服务器、绝不落库。**

## 重新生成打分一致性测试的基准

`src/lib/__tests__/score-fixtures.json` 是用 Python 技能的 `score()` 跑出来的 ground truth。技能公式更新后,用 `github-account-value/scripts/fetch_github_profile.py` 的 `score()` 对相同输入重跑并覆盖该文件,再 `pnpm test` 验证移植未走样。

## 免责声明

本站仅基于 GitHub **公开数据**自动生成评分与点评,吐槽的是账号的公开行为与数据,非针对个人,不构成事实认定,请勿用于骚扰。私有贡献不计入,可能低估私有组织的活跃员工。

## 赞助与公正性声明

本项目欢迎赞助以覆盖运营成本(GitHub API、大模型、托管)。但请注意:

- **赞助不影响任何评分与排名。** 分数由 `src/lib/score.ts` 确定性算出,赞助方无法购买更高的分数、排名或「洗白」。赞助位与榜单数据在产品中物理隔离。
- 赞助方权益仅为署名/展示位,不涉及评分逻辑。

## 开源协议

本项目采用 **[GNU AGPL-3.0](./LICENSE)** 开源协议。

- 你可以自由使用、修改、自部署本项目。
- **若你修改本项目并以网络服务形式对外提供**(SaaS / 在线服务),AGPL 要求你**同样以 AGPL 开源你的修改版**(包括通过网络交互的用户也有权获取源码)。
- 评分核心移植自开源 Claude 技能 `github-account-value`,保持单一事实来源。

> **商标声明:** 「ghfind / 毒舌 GitHub 评分」名称、Logo 及域名**不在本开源协议授权范围内**,版权保留。你可以基于本代码自部署,但请勿使用本项目的名称/品牌冒充官方或制造混淆。
