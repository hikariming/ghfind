<div align="center">

# ghfind 🔥

### 发现最佳开发者，也成为其中之一。

一个基于真实公开数据的平台：**发现**优秀开发者、**看清**自己的位置、并从这里**成长**。

[English](./README.md) · **中文**

[**🔍 测测 GitHub 成色**](https://ghfind.com) · [**🏆 发现最佳开发者**](https://ghfind.com/leaderboard) · [**🤖 安装 GitHub App**](https://github.com/apps/ghfind-review/installations/new) · [**📚 文档**](./docs/README.md)

</div>

[![ghfind 中文开发者主页](./show_img/usercard_cn.png)](https://ghfind.com/u/hikariming)

## 能做什么

- **看清自己。** 输入 GitHub 用户名，得到六个维度的确定性 **0–100 分**、等级与评级、背后的风险信号，以及可选的 AI 毒舌报告。
- **发现开发者。** 浏览开发者榜、语言 / 组织 / 仓库目录、项目榜和人才库，或者让两位开发者正面 PK。
- **展示身份。** 每个个人页都有实时更新的 README 徽章和适配明暗主题的开发者卡片。
- **辅助维护。** ghfind Review GitHub App 给新 issue 和 PR 打上作者评分区间标签。
- **接入集成。** 同一套数据可通过 REST API、MCP 服务器、SDK 和 CLI 调用。

[![ghfind 开发者对决](./show_img/vs_cn.png)](https://ghfind.com/vs/torvalds/yyx990803)

## 评分怎么算

- **确定性。** 六个维度——账号成熟度、原创项目、贡献质量、外部生态贡献、社区影响力、活跃真实性——外加封顶的风险规则，识别刷星 / 刷 fork、自产自合 PR、PR 刷量和机器人等模式。同一评分版本、同一份证据，结果相同。
- **难以造假的信号优先。** 合并进真实项目的 PR 和持续活跃比可购买的 star、粉丝更重要。只使用 GitHub 公开数据，主要在私有组织工作的开发者可能被低估。
- **等级与评级。** `Lv = floor(分数)`；30 分起每 10 分一级，恰在分界上归入更高一级：

  | 分数 | < 30 | 30 | 40 | 50 | 60 | 70 | 80 | 90+ |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | 评级 | 练气 | 筑基 | 金丹 | 元婴 | 化神 | 炼虚 | 合体 | 大乘 |

- **AI 不改分。** 报告模型只根据已确定的分数写标签与文字。
- **公开、可验证。** 评分公式、风险规则和评级阶梯是公开模块 [`scoring/`](./scoring)（TypeScript、Go 及 Python 端口，由共享夹具锁定一致）。SDK（0.2 起）可在本地重算任一已发布扫描：`ghfind verify scan.json`。
- **超级新人红利。** 有采样证据、各项表现都优秀的新账号，成熟度内最多额外加 4 分，满 3 年衰减为零，详见[算法与边界](./docs/scoring/super-newcomer.md)。

## 展示你的主页

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

## GitHub App：ghfind Review

安装 **ghfind Review** 后，新建的 issue 和 pull request 会带上作者的公开评分区间标签
（`review:` 区间阈值为 40、70、90；无评分时为 `review: no-score`）。默认不发评论，
也从不拦截或关闭提交——账号评分是分流线索，不代表这次贡献的质量。App 自动补齐
标签，无需在仓库添加 workflow 或 secret。

[**安装**](https://github.com/apps/ghfind-review/installations/new) · [中文安装与使用指南](./platform/github-app/README.zh.md) · [English guide](./platform/github-app/README.md)

## API、MCP 与 SDK

完整参考见 **[ghfind API 文档](https://ghfind.com/docs)**。

- **REST** — `GET https://ghfind.com/api/score/{username}` 返回确定性分数，无需认证、不经过 LLM。OpenAPI 3.1：[ghfind.com/openapi.json](https://ghfind.com/openapi.json)。
- **MCP** — Streamable HTTP，位于 [ghfind.com/mcp](https://ghfind.com/mcp)，可接入 Claude、Cursor 等任意 MCP 客户端。
- **SDK + CLI** — [`@hikariming/ghfind`](https://www.npmjs.com/package/@hikariming/ghfind)（npm）· [`ghfind`](https://pypi.org/project/ghfind/)（PyPI）· [Go CLI](./docs/development/cli.md)。
- **面向 Agent** — [ghfind.com/llms.txt](https://ghfind.com/llms.txt) 汇总所有机器可读入口。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| [`scoring/`](./scoring) | 公开评分模块：公式、风险规则、评级阶梯、夹具（npm `@ghfind/scoring` + Go module） |
| `src/`、`apps/` | Web 应用：Astro 页面（`apps/web`）、Hono API（`apps/api`）、路由与配套 Worker，`src/` 为共享的 Next 代码 |
| `internal/`、`cmd/` | Go：CLI、旧版 API 与可移植 Feed 运行时 |
| `packages/` | `ghfind-js`、`ghfind-py` SDK 与共享 `i18n` |
| `platform/` | GitHub App 与 Feed 平台 |
| [`docs/`](./docs/README.md) | 架构、运维手册、契约与发布记录 |

各部分在生产中如何协作，见[系统概览](./docs/architecture/overview.md)。

## 本地开发

需要 Node 22（与 CI 一致）、pnpm 11；CLI 与 Go 测试另需 Go 1.23+。

```bash
pnpm install
cp .env.example .env.local     # 至少设置 GITHUB_TOKEN
pnpm run init                  # 本地 D1 schema、合成数据、已登录的测试身份
pnpm dev:local                 # http://127.0.0.1:4390
```

`pnpm dev` 直接运行 `next dev`，使用 Wrangler 本地 D1 模拟器，不连接 Cloudflare。首次需执行
`pnpm exec wrangler d1 migrations apply ghfind --local`（以及 `ghfind-feed-dev`）。
测试身份见[本地测试账号](./docs/development/local-accounts.md)。

**务必设置 `GITHUB_TOKEN`**（只读 PAT 即可）：没有 token 时 GraphQL 维度全部归零，REST 每小时仅
60 次。`LLM_API_KEY` 只在由运营方承担 AI 报告费用时需要。[`.env.example`](./.env.example)
中的其余变量（Turnstile、OAuth、Upstash、Mosoo、Feed）用于开启对应的可选功能。

| 命令 | 用途 |
| --- | --- |
| `pnpm test` / `pnpm typecheck` / `pnpm lint` | Vitest、TypeScript、ESLint |
| `go test ./...` | Go 包（公开模块另跑 `cd scoring && go test ./...`） |
| `pnpm scoring:boundary` | 保持 `scoring/` 纯净（无网络、环境变量、token 或私有依赖） |
| `pnpm frontend-stack:check` | 校验 [`AGENTS.md`](./AGENTS.md) 中的前端依赖规则 |
| `pnpm cf:build` | Cloudflare 生产构建（OpenNext） |
| `pnpm cli:build` | 构建 `./bin/ghfind` |

贡献者与编码 Agent 请先阅读 [`AGENTS.md`](./AGENTS.md)。

## 部署

生产运行在 Cloudflare Workers，由 `hikariming/ghfind` 的 `main` 分支 CI 部署，部署后冒烟失败会
自动回滚。按 [Cloudflare 部署手册](./docs/operations/cloudflare-deployment-runbook.md)操作，切勿提交密钥。

## 自带模型

在页面上选择「用自己的模型」，填入任意 OpenAI 兼容服务的 Base URL、API Key 和模型名。Key 只
保存在你浏览器的 localStorage 中，随请求直接发送，不会上传或保存到服务器。

## 免责声明

评分与点评完全基于 **GitHub 公开数据**自动生成，描述的是公开行为，不是对个人的评判，也不构成
事实认定，不得用于骚扰。

## 赞助与公正性

赞助用于支付 GitHub API、LLM 与托管费用，不会影响任何分数、排名或风险结论——分数只来自公开的
[`scoring/`](./scoring) 模块；赞助展示与榜单数据相互分离。

## 许可证

[GNU AGPL-3.0](./LICENSE)。你可以使用、修改和自托管本项目；如果把修改后的版本作为网络服务提供，
AGPL 要求你以同一许可证公开修改。评分公式最初移植自开源 Claude 技能 `github-account-value`，之后在
本仓库 [`scoring/`](./scoring) 中持续演进，现以此为准。

> **商标：** 「ghfind / 毒舌 GitHub 评分」名称、Logo 与域名不在开源许可范围内，保留所有权利。请勿用于
> 冒充官方站点。
