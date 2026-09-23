# ghfind Review GitHub App

[English](./README.md) · **中文** · [项目 README](../../README.zh.md)

**维护时间有限，别让每一次审查都从查账号开始。**

ghfind Review 根据作者的公开 ghfind 评分，为 **issue** 添加彩色等级标签。
分数直接出现在 issue 列表里，帮你先分清处理顺序。

[**为第一个仓库安装 ghfind Review**](https://github.com/apps/ghfind-review/installations/new)

## 把分数区间变成你的审查队列

用五个 `review:` 标签制定团队的分层处理规则：低分段低调显示，
高分段用低饱和的杏色和麦金色标出，亮色模式下不刺眼。

在仓库的 Issues 搜索框粘贴以下筛选条件：

| 处理队列                       | GitHub 搜索条件                                |
| ------------------------------ | ---------------------------------------------- |
| 高分段 issue                   | `is:open is:issue label:"review: high"`        |
| 最高分段 issue                 | `is:open is:issue label:"review: top"`         |
| 需要复核来源的低分段 issue     | `is:open is:issue label:"review: low"`         |
| 需要人工补充背景的评分不可用项 | `is:open is:issue label:"review: no-score"`    |

从适合你当前精力的队列开始。低分或评分不可用时，先复核来源和提交内容；
高分段则帮助你定位公开 profile 信号较强的作者。
让潜在低质量来源的提交先经过一轮筛查，减少无差别逐项排查的维护压力。

当前阈值固定为 **40、70、90**，尚不支持按仓库自定义阈值。
你可以通过 GitHub 标签筛选和团队流程决定各区间如何处理。
App 给 issue 打标，不处理 pull request，也不在讨论区发评论。不会自动拦截、关闭或拒绝 issue。
评分反映作者的公开 profile，不代表这次提交的质量；新贡献者可能只是公开记录较少。

缺失标签会自动初始化。操作由独立账号 **`ghfind-review[bot]`** 完成，使用 ghfind 专属头像。

## 安装与首次使用

[**安装 ghfind Review**](https://github.com/apps/ghfind-review/installations/new) ·
[服务主页](https://bot.ghfind.com) · [GitHub App 主页](https://github.com/apps/ghfind-review)

目前对所有安装者开放。使用托管 App **不需要自行注册 App、部署服务、添加 workflow，
也不需要在仓库配置个人访问令牌或 secret**。

1. 打开安装链接，选择账号，建议选择 **Only select repositories**，仅勾选需要接入的仓库。
2. 授权 **Issues: read and write**、**Pull requests: read and write**，以及 GitHub
   隐含要求的 **Metadata: read** 权限。个人仓库由账号 owner 安装；组织仓库可能需要组织 owner 批准。
3. App 自动补齐五个 `review:` 标签：`low`、`medium`、`high`、`top`、`no-score`。owner 自定义过的颜色或描述会保留；
   旧版 bot 创建的统一灰色默认标签会自动升级为下表配色。已经打过 `review-level:` 的 issue 仍保留原来较长的名字。
4. 安装后会进入状态页。可用 GitHub 登录查看有权访问的仓库及处理结果；
   **自动打标不要求登录状态页**。失败任务可由仓库管理员点击 **Retry (admin)** 重试。
5. 安装时读取当时 Open 的 issue 列表前两页（每页 100 条）。这张列表会混入 pull request，那些会被跳过。已关闭的不处理。第 3 页及更早的存量不会自动回填。
6. 新建一条 issue，正文可以为空。任务异步处理，等待后刷新页面，
   应能看到 `ghfind-review[bot]` 添加的 `review:` 标签。
7. 如果仓库已启用旧的 **PR review level** Actions workflow，请停用它，避免和本 App 重复处理。

之后新建的 issue 由 `issues.opened` 打标。编辑或重新打开一条已有 issue 不会再次评分。GitHub App 每小时额度用尽时，这个安装下还没打完的任务会停到额度重置，不打 `review: no-score`；重置后由每分钟的定时任务继续打真正的分数。ghfind 评分服务没有返回可用分数时才打 `review: no-score`。超时或云端暂时失败会在 20 分钟和 60 分钟后再取一次分；60 分钟那次是最后一次自动重试，拿到分数后换掉标签。超过 60 分钟后，只有作者或仓库管理员在这条 issue 下评论 `@ghfind-review` 才会再评并更新标签。GitHub 账号不存在时不会自动重试。

## 已安装用户：接受新增的 Issues 权限

打开 [GitHub Settings → Applications → Installed GitHub Apps](https://github.com/settings/installations)，
找到 **ghfind Review → Configure**。如有权限升级提示，点击
**Review request → Accept new permissions**，接受新增的 Issues 读写权限。

首次安装会直接申请完整权限。已有安装仅修改 App 设置还不够，安装 owner 也需要接受新增权限。

## 等级、区间和颜色

| 标签               | 分数区间                   | 颜色     | 色值      |
| ------------------ | -------------------------- | -------- | --------- |
| `review: low`      | 0 ≤ score < 40             | 低调灰白 | `#d9dee3` |
| `review: medium`   | 40 ≤ score < 70            | 浅蓝     | `#b6dfff` |
| `review: high`     | 70 ≤ score < 90            | 柔和杏色 | `#e2c0a2` |
| `review: top`      | 90 ≤ score ≤ 100           | 柔和麦金 | `#ded0a6` |
| `review: no-score` | 无有效评分，不属于数值区间 | 中性灰   | `#c3c7ce` |

分数越高，颜色越暖，饱和度压低，避免 GitHub 亮色模式下晃眼。
评分缺失、超出 0–100、不是有效数值，或评分重试预算耗尽时，使用 `no-score`，**不等于零分**。
这些标签反映作者的公开 profile 评分，不是对 issue 内容的代码审查，也不是合并建议。

初始化只补齐缺失标签，或升级同时满足“旧色值 `ededed` + bot 默认描述”的标签。
自定义标签、无关标签不会被覆盖；存在归档标签或大小写冲突时，会提示 owner 处理。

## 常见问题

| 现象               | 排查方式                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| 没有标签           | 确认 App 已安装到该仓库并已接受完整权限。安装只处理 Open issue 列表的前两页。从安装流程或安装设置进入状态页查看任务。 |
| 标签初始化失败     | 在仓库 Labels 页面检查标签是否归档、大小写是否冲突；修正后在状态页点击 **Retry (admin)**。                    |
| 状态页要求登录     | 登录用于验证你能查看哪些仓库，不是自动打标的前提。只有管理员可以重试失败任务。                                |
| 得到 `review: no-score` | 评分无效或暂时无法获取；不是零分。超时或云端失败会在 20 分钟和 60 分钟后再试，60 分钟是最后一次自动重试。之后只有作者或仓库管理员在这条 issue 下评论 `@ghfind-review` 才会再评并更新标签。账号不存在则保持 no-score。 |
| 想停止使用         | 在 GitHub 安装设置移除仓库、暂停或卸载 App；已有标签会保留。                                                   |

## 数据与权限

App 不读取源代码文件、不执行 issue 正文，也不会把正文送去评分。
GitHub webhook 会携带事件数据，服务验证原始签名后仅保留任务所需的安装 ID、仓库 ID/名称、
issue 编号、评分和状态。作者用户名只用于查询公开 ghfind 评分。

状态页会验证用户当前的仓库访问权限，用户令牌加密保存，会话一小时过期。
已完成或取消的任务记录 30 天后清理；失败任务保留供维护者处理。
详见[隐私说明](https://bot.ghfind.com/privacy)。

## 维护者：开发、部署与恢复

一般仓库 owner 只需按上文安装。下面用于维护服务或自行部署；
完整运行机制与运维细节见[英文维护文档](./README.md#runtime)。

### 本地检查

```sh
cd platform/github-app
pnpm install --frozen-lockfile
pnpm types
pnpm typecheck
pnpm test
pnpm build
```

测试在 workerd 中运行，使用真实本地 D1、原生 service binding 及模拟 GitHub 请求。
修改状态页 UI 后，还应运行仓库根目录的 `pnpm typecheck`、`pnpm lint`，并检查 Light、Dark、Auto。

### 注册独立 App

托管生产 App 已注册在 **AsperforMias** 名下，App ID 为 `4950248`。日常更新不要重复注册。
如果自行部署，应使用自己控制的域名和独立基础设施：

```sh
node scripts/register.mjs https://bot.example.com /absolute/private/credentials.json
```

打开命令输出的本地 URL，在 GitHub 注册。脚本仅监听 `127.0.0.1`，使用一次性随机状态，
将凭据保存为 `0600` 权限文件且拒绝覆盖已有文件。回调成功后关闭注册服务，**不要提交凭据**。

设置头像为 `assets/avatar.png`，webhook 为 `/webhook`，OAuth 回调为 `/callback`，
安装状态页为 `/setup`；申请 Issues、Pull requests 读写权限，并订阅 `issues` 和 `issue_comment`。`issue_comment` 用来接收作者或管理员对某条 `review: no-score` issue 的重评请求，不增加权限。
安装生命周期事件由 GitHub 自动投递。安装时不必强制 OAuth，只有查看状态页才需要登录。

### 生产部署

仓库中的生产配置绑定 ghfind 已有的 Cloudflare 账号及资源。自行部署必须改为自己的资源，
并预先创建 Worker、D1 和队列；不要直接复用其中的生产资源 ID。

非敏感配置为 `APP_ID`、`APP_CLIENT_ID`、`APP_SLUG`。secret 为 `APP_PRIVATE_KEY`、
`WEBHOOK_SECRET`、`APP_CLIENT_SECRET` 和随机生成的 `SESSION_SECRET`。
确认 `wrangler whoami`、D1 和队列属于目标账号后：

```sh
pnpm exec wrangler d1 migrations apply ghfind-bot --remote --env production
pnpm exec wrangler deploy --env production --secrets-file /absolute/private/worker-secrets.json
```

`ENABLED=true` 启用处理，`ALLOWED_ACCOUNTS=*` 对所有安装者开放；
独立试运行环境可以改为逗号分隔的仓库 owner 登录名列表。
secret 只通过私有文件或 Cloudflare secret 管理，不要放在命令参数、评论、截图或日志里。

### 状态查询、暂停与回滚

```sh
pnpm exec wrangler d1 execute ghfind-bot --remote --env production \
  --command "SELECT id,kind,state,attempts,result,updated FROM jobs ORDER BY updated DESC LIMIT 30"
```

队列发送失败由每分钟 cron 从 D1 恢复。生产队列并发是 **96**。同一条 issue 不会同时跑两个任务。
修正失败原因后，优先让仓库管理员在状态页重试。维护者重置失败任务预算的方法见
[Observe and recover](./README.md#observe-and-recover)。

暂停可将 `ENABLED=false` 后重新部署；已有任务保留。回滚使用
`pnpm exec wrangler rollback --env production`，不要回滚或删除 D1 schema。

### 真实端到端验收

在空白测试仓库安装 App，确认五个标签已创建，再新建一条空正文 issue。
核对 bot 身份、头像、标签颜色和分数区间。重复投递同一事件后，不应再改一次标签。
测试撤权时确认停止访问，保留既有标签。

```sh
node scripts/e2e.mjs prepare owner/test-repository
# 在 GitHub 安装到该测试仓库后：
node scripts/e2e.mjs open owner/test-repository
node scripts/e2e.mjs verify owner/test-repository app-slug issue-or-pr-number
```

`prepare`、`open` 会修改测试仓库；`verify` 只核对现有 issue 的标签。
需要单独新建 issue 时，可在 GitHub UI 操作。

## 作者评分邮件

作者当前 GitHub 主页有公开邮箱时，默认发送评分邮件，无需先登录或订阅。缺少邮箱、无效地址、bot 和 GitHub noreply 地址会跳过。不会从 commit 中提取邮箱，因为提交元数据不能证明邮箱归属。发信前再次核对公开邮箱。作者可通过[邮件设置](https://bot.ghfind.com/notifications)主动授权已验证主邮箱、选择中英文或在退订后重新开启；私有邮箱仍需作者本人授权。

issue 打上标签后，作者可收到分数、区间、profile URL，以及可用时的
“超过 ghfind 已收录评分账号的比例”和站内评分排名。
这些是**站内评分统计**，不代表处理顺序，也不预测维护者多久回复；数据不可用时会明确说明。
Pull request 不触发这封邮件。

邮件使用独立 D1 发件队列。同一人跨仓库每 72 小时最多一封；静默期内多出来的待发信会取消，不会留到 72 小时后再发。满 72 小时后，下一条打标的 issue 可以再发一封。全局每个 UTC 日最多 100 封。
邮件失败不会撤回已经添加的标签。发送结果不明确时记为 `uncertain`，
不自动重发，避免重复邮件；代价是这种故障下可能漏发，需运营者核实后处理。

每封邮件附带退订链接及一键退订邮件头。打开链接先确认，提交后删除加密邮箱订阅并取消待发邮件；
退订保留 GitHub 用户 ID 作为长期停发记录，跨仓库生效，不随邮件事件过期删除；仅本人主动重新订阅才解除。已经开始发送的邮件可能仍会送达。邮箱使用 `SESSION_SECRET` 加密保存，不记录收件地址或可能包含地址的服务商错误。
邮件事件记录保留 30 天。

### 运营者启用步骤

1. 使用 Wrangler D1 migrations 应用 `0002_author_email.sql` 和 `0003_email_delivery_receipt.sql`、`0004_default_author_email.sql` 等待执行迁移。
2. 在 GitHub App 的 **Account permissions** 中增加 **Email addresses: read**。
   作者必须本人授权，仓库 owner 不能代其同意。
3. 启用发信子域名，例如 `wrangler email sending enable mail.example.com`，验证 SPF、DKIM、DMARC，
   将 `EMAIL_FROM` 设为该域名的发件地址。
4. 配置 `EMAIL` binding，完成授权及自有收件邮箱 E2E 后再设 `EMAIL_ENABLED=true`；本地及 staging 默认关闭；官方生产 App 已在自有收件人测试后开启。
5. 定时任务处理发件队列。通过 `author_emails.state` 检查不确定发送，`provider_id` 保存服务商接收回执，`error_code` 仅保存脱敏错误码；通过 `email_daily_budget` 检查额度。
   暂停 bot 也会暂停发信。
