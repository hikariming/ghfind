# 生产 Feed 手动止损

`Feed production pause (containment only)` 只把 Web 切到明确指定、已经捕获的 Go-only paused 版本。它保留独立 runtime、服务绑定目标和数据库事实，继续使用源 outbox；Feed 返回暂停状态。**这不是恢复服务，也不是已经验收的历史应用回滚。**

在 GitHub Actions 选择该 workflow，使用 `main`，输入：

- `source_sha`：该暂停版本发布时记录的完整 40 位 SHA。
- `paused_web_version`：生产发布 `web-paused.json` 或同类已核实证据中的不可变 Web UUID；不得填写 `latest`、猜测前一个版本或选择 legacy。

工作流先读取现有 GitHub 发布保护；只有 Production 环境已受 main 分支约束，才进入持有既有 `CF_API_TOKEN` 的操作 job。它与正常生产发布使用相同 concurrency 锁，因此排队等待正在运行的发布，不并行改变生产 Web。

控制脚本来自本次 main checkout。它验证目标 SHA 是 main 历史的祖先，在独立临时 checkout 中运行可信 main 的 `feed-ci-evidence.mjs verify-ci-remote`，验证目标真实 CI、准确 tree、全部必需 jobs 和完整双 profile 本地 E2E。它不执行旧 checkout 的脚本。

当前采用保守范围：现有 CI verifier 要求该 SHA 仍是对应 CI 分支的当前 HEAD，证据创建不超过 24 小时、artifact 未过期且最新 CI 已通过。目标过旧、分支已前进或证据缺失时，操作会在修改 Cloudflare 之前失败。重跑旧 CI 不能消除 current HEAD 限制。此次同 SHA 暂停锚点可使用；不要据此声称跨历史版本回滚或五分钟服务恢复已经验收。

随后只读目标 `ghfind` immutable version，验证：准确 `production-SHA` tag、Go backend、paused mode、0 basis points、生产核心/Feed D1、固定 FEED_RUNTIME 服务、源 outbox 已启用及 preview 关闭。通过之后仅执行一次明确 UUID 的 `wrangler rollback`，不自动选择备用版本。完成后重新读取实际 100% 活跃 UUID、暂停配置和 preview，并再次确认 deployment 未在读回期间变化。

结果保存在 Actions artifact 中的 `pause.json` 和 `ci.json`，包含工作流 run/attempt、来源 SHA、目标 UUID 和实际读回。原始 binding 清单、OAuth/provider 数据与凭据不会写入产物。失败也保留阶段及是否已尝试 rollback；如果 rollback 或读回失败，状态保持 failed，必须先读取实际生产状态，不把脚本失败理解成“远端未发生修改”。

本地默认只读/计划：

```sh
node scripts/feed-production-pause.mjs --source-sha <40hex> --paused-web-version <UUID> --directory <fresh-absolute-directory>
```

`--apply` 仅允许固定仓库、main、手动 Actions workflow；本地禁止修改。此工具不关闭数据库 writer fence，不提升存储、不修改 runtime、不恢复 legacy，也不新建任何凭据。打开 Feed 应使用正常的准确 SHA CI/E2E 生产发布路径。
