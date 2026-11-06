# AGENTS.md (FindAny/ghfind)

本仓库是 ghfind 的公开仓库：评分模块、SDK、CLI，以及**全部 CI/CD 与生产部署工作流**（部署中枢）。
完整产品规则（业务规则、Frontend Stack Rules 等）在私有仓库 `ghfind-server` 的 `AGENTS.md`；组装后的工作区根目录使用那一份。
三仓库模型见 [`docs/architecture.md`](docs/architecture.md)。

## 规则

- **评分纯净与三端一致**：评分公式、风险规则、评级阶梯只在 `scoring/` 定义；不得联网、读环境变量、碰 token、时钟或随机数，Go 只用标准库白名单。修改时 TypeScript、Go、Python 三端与 `scoring/fixtures/` 在同一 PR 内同步，见 [`scoring/README.md`](scoring/README.md)。`pnpm scoring:boundary` 必须通过。
- **工作流是生产关键路径**：`.github/workflows`、`.github/compose`、`.github/actions` 决定生产部署。修改须保持 `ghfind-server` 中 `scripts/check-cf-release-workflow.mts` 的发布契约通过（在组装后的工作区运行 `pnpm ci:check-cf-release-workflow` 与 `node --test scripts/check-cf-release-workflow.test.mjs`），生产作业只在 `deploy` 分支的组装提交上运行（`require-manifest: true`）。
- **不放私有代码与凭据**：不得把 `ghfind-server` / `ghfind-frontend` 的文件、组装产物或任何密钥提交到本仓库；`deploy` 分支只允许 release bot 写入，提交内容只能是公开发布树加 `components.manifest.json`。不要在工作流里打印私有源码或把它作为 artifact 上传（日志公开）。
- **不使用 `pull_request_target`**；fork PR 拿不到密钥，完整 CI 作业对 fork 自动跳过。
- 前端规则（shadcn/ui Nova、Lucide、Motion 等）见 `ghfind-server` 的 `AGENTS.md`。

## 完成前检查

| 改动 | 必跑 |
| --- | --- |
| `scoring/` | `pnpm --filter @ghfind/scoring typecheck && pnpm --filter @ghfind/scoring test`、`(cd scoring && go test ./...)`、`(cd packages/ghfind-py && python3 -m pytest -q)`、`pnpm scoring:boundary` |
| SDK | `packages/ghfind-js`：`npm ci && npm run typecheck && npm test`；`packages/ghfind-py`：`python3 -m pytest -q` |
| CLI | `go test ./internal/agentcli && go build -o bin/ghfind ./cmd/ghfind` |
| 工作流 / 组装工具 | 在组装后的工作区（见 `docs/architecture.md`）运行发布契约检查与 `pnpm test` |
