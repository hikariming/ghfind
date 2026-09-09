# Feed GitHub 发布保护：管理员配置

此文档对应 `scripts/feed-github-protection.mjs`。脚本默认只执行 GET，并输出可以审核的配置计划；只有显式 `--apply` 才会写入 GitHub。它不创建 token、不写 secret、不部署 Cloudflare、不合并 PR。

目标固定为 `hikariming/ghfind`、ruleset `18206694`（`Protect main`）。当前账号具有 PR bypass 能力，但远端环境写入已返回 `403 Must have admin rights to Repository`；这不等于拥有仓库配置权限。2026-09-09 的只读核验也未返回 `bypass_actors`，该字段因缺少 ruleset 写权限而被 GitHub 隐藏，不能解释为没有 bypass 配置。[GitHub ruleset API](https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset)

## 预期变化

| 配置 | 必须达到的状态 |
| --- | --- |
| Protect main | 保留原有分支范围、active 状态、所有 review 条件、其他 rules 和 bypass actors；只移除 `squash`，保留已有 `merge` / `rebase` |
| Required checks | `Application checks`、`Feed storage contracts`、`Feed runtime builds`、`Complete local Feed E2E`；来源固定为已核验的 GitHub Actions integration `15368`；strict 模式 |
| Feed staging | 自定义 branch policy，仅 `main` 和 `codex/feed-*`；不允许 tag；不新增人工等待 |
| Feed staging operations | 仅 `main`；新增环境时 reviewer 为仓库 owner `hikariming`（User ID `23065064`） |
| Production | 仅 `main`；不新增 reviewer 或 wait timer，正常发布仍由 CI→staging→Production 自动推进 |

脚本检查本地 CI 配置中四个 job 都会在 PR 上报告结果，不选择只在 push 上执行的聚合任务作为 required check。完整本地 E2E 通过后才能推候选分支；准确 HEAD CI、PR merge 兼容性及真实 CF E2E 仍必须通过后才能合入。配置脚本不能替代这些验收。

GitHub 环境匹配的 `*` 不跨越 `/`，交付分支使用 `codex/feed-阶段名` 这种单层形式。[环境 branch policy API](https://docs.github.com/en/rest/deployments/branch-policies#create-a-deployment-branch-policy)

## 管理员执行顺序

1. 在已审核的候选 checkout 中，以仓库管理员身份登录现有 GitHub CLI。该脚本需要 Administration write、Actions read 和仓库 metadata 读取能力，不需要新增长期凭据。
2. 运行只读计划，输出路径必须尚不存在：

   ```sh
   node scripts/feed-github-protection.mjs --output /tmp/ghfind-protection-review.json
   ```

3. 检查 `current`、`currentHash`、`requiredPRChecks`、每一条 `operations.body`、`operations.expected` 和 `blockers`。只有 `readyToApply: true` 才可执行；非管理员生成的计划必须由管理员重新生成，不能手工补写被隐藏的 bypass 列表。
4. 复制所审核计划的 64 位 `currentHash`，明确执行同一计划：

   ```sh
   node scripts/feed-github-protection.mjs --apply \
     --plan /tmp/ghfind-protection-review.json \
     --expected-current-hash <审核过的64位currentHash> \
     --output /tmp/ghfind-protection-applied.json
   ```

5. 必须得到 `status: applied-and-verified`。结果包括每次写入后的读回 hash 和最终状态；再运行一次默认只读计划，应得到 `readyToApply: true`、`operations: []`。在 GitHub 的 Rules 和三个 Environments 页面复核同样的结果。

所有资源修改由同一个管理员串行执行。GitHub 这些 API 不支持跨资源原子事务，hash 检查也不是服务端 CAS：脚本在第一笔写入前、每笔后续写入前重新读取状态，并在每笔写入后验证目标及其他保护没有变化；仍需避免其他管理员同时修改配置。

## 漂移、失败与保留边界

- 既有 reviewer、wait timer、额外 required check 原样保留。已有 reviewer 列表的 GitHub 语义是任选一人批准，脚本不会通过追加不同 reviewer 来放宽既有要求。
- 遇到不同的非空 branch policy、protected-branches 策略，或需要 PUT 时存在不能通过该 API 保真的 custom / admin-bypass 保护，计划标记 `PROTECTION_DRIFT`，不自动覆盖。由管理员在 UI 处理具体差异，再重新生成计划。
- 当前状态 hash 改变、计划被改写、其他仓库/资源被替换、四个 PR checks 缺失、权限不足，均停止执行。
- 写入失败输出具体 method/path、`ADMIN_REQUIRED` 等原因和已读回成功的操作清单；不会把失败写成通过，也不会为回滚而删除刚添加的保护。若已部分完成，先重新读取实际状态再制定剩余操作。
- 若部分失败留下了非空但未完整的自定义 branch policy，脚本会要求管理员核对，而不会自动扩大它。根据原审核计划补齐固定名称后再重新读取。
- 环境 secret、变量、OAuth 身份和 CF 资源配置独立交付；本脚本没有访问它们的逻辑。[环境保护 API](https://docs.github.com/en/rest/deployments/environments#create-or-update-an-environment)


## Actions 部署前的只读门禁

在**没有 `environment:` 的独立 preflight job** 中运行以下命令，使用只有 `contents: read`、`actions: read` 的 `GITHUB_TOKEN`（通过 `GH_TOKEN` 环境变量传入）：

```sh
node scripts/feed-github-protection.mjs --verify-existing "$RUNNER_TEMP/feed-github-protection.json"
```

只有该 job 成功，声明 `Feed staging` 环境的部署 job 才能运行。这样 GitHub 不会因为 workflow 提及了一个缺失环境，就先自动创建没有保护的空环境。

该模式只执行 GET，不要求管理员身份，也不要求看到被隐藏的 bypass actors。它核验 active 的固定 ruleset、原有 PR review 约束、禁止 squash、来源固定的四个 strict required checks、三个环境的精确 branch allowlist，以及 operations 的 owner reviewer。既有更严格的 review、wait timer、额外 status checks 和保护规则不会被改写。

成功输出 `ghfind-github-protection-verification-v1` 证据，包含核验时间、状态 hash、checks 和环境策略；不包含 bypass 列表。任何缺失、策略不符或 403 等读取错误都会失败，且不生成可用的通过证据。`--verify-existing` 不能与 `--apply`、计划输入或其他输出选项混用。
