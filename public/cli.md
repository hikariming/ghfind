# ghfind CLI

ghfind.com 的官方命令行工具。需要 Node.js 18 或更新版本。单独安装 CLI：

```sh
npm install --global @hikariming/ghfind
```

同时安装 CLI 和 Agent Skill：

```sh
curl -fsSL https://ghfind.com/install.sh | bash
```

## 鉴权

`score`、`vs`、`search`、`leaderboard` 和 `developers` 是公开命令，不需要 Token。`scan` 和 `roast` 会调用受保护的扫描接口，在生产环境需要个人 API Token。先在 [CLI & API 页面](https://ghfind.com/integrations)通过 GitHub 登录并创建 Token，再将其保存到 `GHFIND_API_KEY` 环境变量；也可以使用 `--api-key` 参数。

```sh
export GHFIND_API_KEY=ghf_your_token
ghfind scan torvalds -o json
ghfind roast torvalds --lang zh -o markdown
```

网站登录产生浏览器会话，CLI 使用账户创建的个人 Bearer Token。可随时在 [CLI & API 页面](https://ghfind.com/integrations)撤销 Token。

## Agent Skill

运行上面的安装命令会同时安装 [ghfind-cli Skill](https://ghfind.com/skill)。Agent 可通过它了解可用命令，以及何时使用公开评分或需要鉴权的扫描。

完整接口说明：[API 文档](https://ghfind.com/docs) · [OpenAPI](https://ghfind.com/openapi.json) · [MCP](https://ghfind.com/mcp)
