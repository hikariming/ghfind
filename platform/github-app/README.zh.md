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
App 默认只给 issue 和 pull request 打标；只有仓库管理员在[仓库设置](#仓库设置)里开启后，才会发评论或打意图标签。不会自动拦截、关闭或拒绝提交。
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
   同一登录也可进入 <https://bot.ghfind.com/admin> 的[仓库设置](#仓库设置)。
5. 安装时只初始化标签，不会自动处理已有的 issue 和 pull request。需要时由仓库管理员在[仓库设置](#仓库设置)里手动补扫。
6. 新建一条 issue 或 pull request，正文可以为空。任务异步处理，等待后刷新页面，
   应能看到 `ghfind-review[bot]` 添加的 `review:` 标签。
7. 如果仓库已启用旧的 **PR review level** Actions workflow，请停用它，避免和本 App 重复处理。

之后新建的 issue 和 pull request 分别由 `issues.opened` 和 `pull_request.opened` 打标。编辑或重新打开不会再次评分。GitHub App 每小时额度用尽时，这个安装下还没打完的任务会停到额度重置，不打 `review: no-score`；重置后由每分钟的定时任务继续打真正的分数。ghfind 评分服务没有返回可用分数时才打 `review: no-score`。超时或云端暂时失败会在 20 分钟和 60 分钟后再取一次分；60 分钟那次是最后一次自动重试，拿到分数后换掉标签。超过 60 分钟后，只有作者或仓库管理员在这条 issue 下评论 `@ghfind-review` 才会再评并更新标签。GitHub 账号不存在时不会自动重试。

## 已安装用户：接受新增的 Issues 权限

打开 [GitHub Settings → Applications → Installed GitHub Apps](https://github.com/settings/installations)，
找到 **ghfind Review → Configure**。如有权限升级提示，点击
**Review request → Accept new permissions**，接受新增的 Issues 读写权限。

首次安装会直接申请完整权限。已有安装仅修改 App 设置还不够，安装 owner 也需要接受新增权限。

## 仓库设置

用 GitHub 登录 <https://bot.ghfind.com/admin>（首页和状态页也有入口）。页面先列出你能访问的
App 安装，再列出该安装里你的 GitHub 账号能访问的仓库。设置以 GitHub 仓库 ID 为键保存（仓库 ID 全局唯一），
同一 owner 改名、卸载重装时设置仍在；记录里另存最后一次保存时所用的安装。转移到新 owner
时会重置 AI 开关、勾选的意图标签和自定义评论提示词，新 owner 必须重新主动开启。
查看需要仓库 write 或 admin 权限。

- **谁能看、谁能改。** 通过该安装拥有仓库 **write** 或 **admin** 权限的登录用户能查看设置。保存需要仓库 **admin** 权限，
  每次保存都用你的 GitHub 令牌实时校验（与 Retry 规则相同）；其他人看到的是只读表单。
  保存走同源表单并校验 CSRF 令牌。URL 里的安装 ID 或仓库 ID 本身不授予任何权限。
- **issue / pull request 开关。** 两个开关默认都开，分别控制是否给新 issue、新 PR 评分打标。
  开关在任务执行时检查，关闭后已排队的任务也会停下。
- **补扫已有条目。** 安装、仓库被加入安装、安装恢复和接受新权限时都只初始化标签。仓库页面上有单独的
  补扫表单：用一次 GitHub 请求按创建时间从新到旧排队处理最新的 1–100 条 Open 项（默认 25），遵守
  issue / PR 开关。权限、同源和 CSRF 校验与保存设置相同，所填数量会被记住；该仓库已有补扫在等待或运行时
  会拒绝新的补扫。页面会显示上次补扫的状态、时间和结果。每次补扫都会重新处理它选中的条目，包括以前处理过的，所以开启意图标签后再补扫一次，已有条目也会打上意图标签。
  补扫的条目既不发评分邮件，也不会收到 bot 评论。
- **意图标签（默认关闭）。** 管理员勾选 bot 可以使用的现有标签，`review:` 标签不在其中。
  每条新 issue 或 PR 的标题、正文前 8000 个字符（作为不可信数据传给模型），以及勾选标签和它们在
  GitHub 上的描述会发给 LLM，由它最多挑 3 个。bot 只添加已勾选且仍存在的标签，不创建、不改名、
  不移除标签；条目已经带有任一勾选标签时跳过。重评和 @ 提及任务不会再分类。
- **评论（默认关闭）。** 开启后，bot 在本仓库给每位作者最多发一条评分评论（no-score 评论每个仓库另有
  3 条上限）。可选的提示词决定语言和语气：LLM 只看到提示词和评分信息，看不到 issue 内容，
  在固定评分表上方写一句纯文本开场白。开场白会去掉链接、@ 提及、markdown 和 HTML，评分表不会被改动。
  没有提示词或 LLM 失败时只发评分表。补扫从不评论，重评只更新已有评论。

意图分类默认使用 `TRIAGE_PROVIDER=llm` 和可选的 `LLM_API_KEY`。
设置 `TRIAGE_PROVIDER=jev` 并配置 `OPENROUTER_API_KEY` 后，意图分类改用 OpenRouter Decisions API。
AI 开场白独立使用 `LLM_API_KEY`，不可用时评论退回为纯评分表。
分类凭据缺失时不执行意图打标。issue 和 PR 正文不会保存；开启意图分类后会发送到所配置的分类服务商。

## PC 管理后台

GitHub 登录后，`/admin` 打开所选安装的概览。侧栏提供仓库、任务、动态和安装切换。
统计仅覆盖当前 25 个仓库分页中有写入权限的仓库，页面明确显示统计范围。
任务和动态各自支持筛选和分页。旧动态记录没有安装和 owner 字段，属于仓库历史，不能作为安装级审计证明。

安装管理保留当前账户上下文，进入后仍可从侧栏访问其他子页。只有一个安装时显示账户名称和管理入口；
多个安装时提供支持键盘操作的账户菜单。切换账户会重置仓库相关筛选。
仓库表单返回时保留列表筛选、分页和语言，离开未保存的设置前会提示，提交时显示进度并防止重复提交。

仓库页分别提供处理、评论、意图标签、补处理和清理设置。处理开关实时校验管理员权限，
只影响后续事件；历史补处理仍需手动请求。意图预览用已保存且仍存在的标签和描述，
把虚构标题、正文发送给相同分类器，不写入 GitHub，也不保存示例。
每个仓库每分钟最多一次预览，服务商调用失败也计入限额。

在仓库根目录运行 `pnpm exec tsx platform/github-app/scripts/dev-dashboard.mts`，
打开 `http://127.0.0.1:4201/admin?installation_id=10` 可查看 PC 预览。
预览运行真实 Worker 和完整迁移后的隔离临时 D1，但 GitHub 身份、仓库和历史是虚构数据，
不允许写入 GitHub，不执行后台队列，默认也不调用模型。
显式加 `--jev` 才会从本地私有凭据文件读取密钥并启用真实模型调用；本地预览不能替代生产和 OAuth 验收。

使用 `--installations=0`、`=1`（默认）或 `=2` 分别检查无安装、单账户和多账户状态。
预览不加 `--jev` 时，可运行 `pnpm exec tsx platform/github-app/scripts/dashboard-ux-acceptance.mts`
验证实际导航、账户切换、表单、浏览器返回，以及英中阿三种语言在桌面和手机尺寸下的亮色、暗色和自动主题。
脚本会提交一次未配置分类服务的预览来检查错误状态，不发起真实模型调用。三个安装状态需依次在 4201 端口运行。

bot 收到成功打标响应后，才在 `triage_labels` 里记录仓库、issue 编号和标签名。清理时还会实时
校验标签事件的最新归属，不仅凭记录或标签存在就删除。设置修改、暂停、补扫、重试和清理都会写进 `audit_log`，包含操作的管理员和来源（网页或 API）。

## 清理

仓库页面有一个"清理"卡片，只删除 bot 自己写入的内容：

- bot 打上的 `review:` 标签（每个等级用一次搜索找出候选）；
- `triage_labels` 里记录过的意图标签候选；
- bot 自己的评分评论：作者是 `<slug>[bot]`，且正文以评论标记开头。只扫描仓库最新的 5000 条评论，更早的请再清理一次；
- 可选：删除未被使用的 `review:` 标签定义。删除前实时检查所有 Open/Closed issue 和 PR；
  组合清理先逐条删除确认属于 bot 的标签，任何残留使用都会保留该定义。意图标签定义永远不会删除。

逐条删除前，最多读取 5 页标签事件，仅当同名标签的最新事件为本 bot 的 `labeled` 才删除。
人工重新打的标签、未知作者、读取失败或事件超过页数上限都会保留。

清理先预览：队列任务统计候选条目（最多 5000 项，超过时预览会注明），不向 GitHub 写任何东西。
管理员需在 10 分钟内确认。网页上只有发起预览的管理员能确认；API 需要一次性的确认码。
执行时每步最多 40 次 GitHub 调用，遇到 App 配额用尽会像其他任务一样等待，可以在条目之间取消；
已不存在或需保留的条目记为跳过，最终删除数可能少于预览数，重复执行不会出错。每个仓库同一时间只能有一个进行中的清理。
评分标签仍开着时，预览会提醒新条目还会被打上标签，请先暂停。

## 给 agent 用的 CLI 和 API

仓库管理员（以及他们的 agent）可以用 ghfind CLI 在终端完成上面所有操作，凭据是在
<https://ghfind.com/integrations> 创建的个人 API Token，放在 `GHFIND_API_KEY`。
创建时必须显式勾选 **Manage the ghfind Review bot（管理 ghfind Review bot）**。
存量 Token 仍仅能扫描；若收到 `token_scope_required`，请创建带 bot 权限的新 Token。
所有 bot 命令（包括查看）都需要该权限，每次请求还会实时检查仓库权限：

```sh
ghfind bot status owner/repo                    # 设置、失败任务、上次清理、操作日志
ghfind bot pause owner/repo                     # 关闭 issue 和 PR 处理，取消已排队的任务
ghfind bot cleanup owner/repo --labels all --comments   # 只预览，输出确认码
ghfind bot cleanup confirm owner/repo <确认码> --wait     # 执行这次预览
ghfind bot resume owner/repo
ghfind bot settings set owner/repo --triage off
ghfind bot backfill owner/repo -n 25
ghfind bot retry owner/repo [job-id]
```

CLI 调用 `https://bot.ghfind.com/api/v1/repos/{owner}/{repo}`（`GET` 状态、`GET|PATCH /settings`、
`POST /pause|/resume|/backfill|/retry|/cleanups`、`GET /cleanups/{id}`、`POST /cleanups/{id}/confirm|/cancel`）。
bot 通过 service binding 把 token 发给 ghfind.com 的 `GET /api/account/whoami`，得到对应的 GitHub 账号，
再用安装令牌实时检查这个账号对仓库的权限，每次请求都查：读取需要 write 权限，任何修改都需要 admin。
CLI 不需要也不保存 GitHub 用户令牌。错误以 JSON `{"error": code}` 返回。App 未安装、仓库不存在、没有 write 权限
三种情况都返回 `not_found`，避免用 token 探测私有仓库。每个 GitHub 账号每分钟最多 60 次、每小时最多 600 次请求
（超出返回 `rate_limited` 和 `Retry-After`）。读取请求的权限检查结果缓存 1 分钟，拒绝结果也缓存 1 分钟，
轮询和探测不消耗 GitHub 配额；任何修改都会实时重新检查。重试失败任务时会先关闭原任务，所以只会重试一次，
新任务保留原来的类型（补扫的条目重试后仍然不发邮件、不评论）。

Scoped Token 上线顺序：在主站的 `ghfind` 数据库先应用 `migrations/0015_ghfind_api_tokens.sql`，再应用
`migrations/0018_ghfind_api_token_scopes.sql`，再部署主站（Token 创建、列表和
`/api/account/whoami`），最后部署要求 `bot` 权限的 bot。bot 的旧 `SCORE=ghfind` 服务绑定目标也必须部署新的 whoami
响应，CLI 才算就绪；缺少权限时一律拒绝。生产 bot 由 **Deploy production (Cloudflare)** 的最后一个
`deploy-bot` 任务部署：等待同一 SHA 的 legacy 主站部署及 smoke 成功，确认仍是当前 main，
串行执行 bot 迁移与部署。主站发布失败或 SHA 已过期时不会部署 bot；手动部署也必须保持此顺序。主站工作流只在 Worker
部署前应用明确获准的迁移，需要在 `ops/feed-application-schema-release.json`（dev 和 apps-production）
和 `ops/feed-production-schema-release.json`（完整 production）添加这两份迁移及其 SHA-256。
bot 独立数据库的迁移不会应用这份主站迁移。存量 Token 仍只有 `scan`。
滚动部署期间，缺少 scopes 列时按仅扫描读取，带 bot 权限的 Token 创建会被拒绝直到迁移完成；
whoami 未返回 `bot` 权限时，bot 会拒绝该 Token。

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
| 没有标签           | 确认 App 已安装到该仓库并已接受完整权限，并在仓库设置里打开了 issue 或 pull request 开关。已有条目要等管理员在仓库设置里点了补扫才会处理。从安装流程或安装设置进入状态页查看任务。 |
| 标签初始化失败     | 在仓库 Labels 页面检查标签是否归档、大小写是否冲突；修正后在状态页点击 **Retry (admin)**。                    |
| 状态页要求登录     | 登录用于验证你能查看哪些仓库，不是自动打标的前提。只有管理员可以重试失败任务。                                |
| 得到 `review: no-score` | 评分无效或暂时无法获取；不是零分。超时或云端失败会在 20 分钟和 60 分钟后再试，60 分钟是最后一次自动重试。之后只有作者或仓库管理员在这条 issue 下评论 `@ghfind-review` 才会再评并更新标签。账号不存在则保持 no-score。 |
| 想停止使用         | 在 GitHub 安装设置移除仓库、暂停或卸载 App；已有标签会保留。                                                   |

## 数据与权限

App 不读取源代码文件、不执行 issue 正文，也不会把正文送去评分。
GitHub webhook 会携带事件数据，服务验证原始签名后仅保留任务所需的安装 ID、仓库 ID/名称、
issue 编号、评分、状态，以及管理员保存的仓库设置（含保存者的 GitHub 用户名）。另外记录 bot 打过的意图标签
（issue 编号和标签名）以便清理，以及设置修改、补扫和清理的操作日志（含操作者的 GitHub 用户名）。作者用户名只用于查询公开 ghfind 评分。
issue 正文不会被保存；但管理员开启意图标签后，新 issue 或 PR 的标题和正文前 8000 个字符会发送给运营方配置的 LLM 服务商。
开启评论并填写提示词时，只有作者用户名和评分会发给该服务商。

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

部署新代码前先应用所有待执行的迁移。尤其是仓库设置这一版，必须先应用
`0006_repo_settings.sql` 再部署。缺表时读取设置会退回默认值，webhook 不会因此失败，但保存设置和补扫会失败，直到迁移应用为止。
清理和 API 这一版需要先应用 `0007_bot_operations.sql`（意图标签记录、操作日志、清理任务）；未应用时，
意图标签会跳过所有条目，而不是打一个无法记录的标签。

`ghfind bot` API 依赖 ghfind.com 的 `/api/account/whoami` 做认证。主站需要先于或同时部署这个路由，
在那之前 API 会返回 `auth_unavailable`。

`LLM_API_KEY` 是可选 secret，刻意没有放进 `secrets.required`。不配置时 AI 开场白不可用，
默认 `llm` 分类器也不可用；Jev 独立使用 OpenRouter secret。设置页分别提示这两种能力。
需要启用 AI 开场白和默认分类器时：

```sh
pnpm exec wrangler secret put LLM_API_KEY --env production
```

`LLM_BASE_URL`（默认 `https://api.stepfun.com/v1`）和 `LLM_MODEL`（默认 `step-3.7-flash`）是
`wrangler.jsonc` 里的可选变量，留空即用默认值，也可以改成其他 OpenAI 兼容服务。

Jev 使用 `TRIAGE_PROVIDER=jev`、可选 secret `OPENROUTER_API_KEY` 和固定模型
`JEV_MODEL=typesafe/jev-1.13`。`JEV_THRESHOLD=0.8` 是保守的初始值，尚不能当作准确率校准结果。
模型按 GitHub 标签描述逐项判断，最多添加三个达到阈值的允许标签；无效或不可用的结果不添加标签，也不切换到其他生成模型。

在仓库根目录运行 `pnpm exec tsx platform/github-app/scripts/jev-live.mts` 可重复执行真实模型测试。
脚本从其注明的本地私有文件读取密钥，不通过命令参数传入；输出仅包含虚构样例和脱敏状态。

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

issue 和 pull request 作者评分低于 40 分时不发送评分邮件，规则上线前已排队的待发邮件也会取消。检查发生在公开邮箱查找和发送额度扣减之前。恰好 40 分仍可发送；评分不可用时保留原有通知行为。

作者当前 GitHub 主页有公开邮箱时，默认发送评分邮件，无需先登录或订阅。缺少邮箱、无效地址、bot 和 GitHub noreply 地址会跳过。不会从 commit 中提取邮箱，因为提交元数据不能证明邮箱归属。发信前再次核对公开邮箱。作者可通过[邮件设置](https://bot.ghfind.com/notifications)主动授权已验证主邮箱、选择中英文或在退订后重新开启；私有邮箱仍需作者本人授权。

issue 打上标签后，作者可收到分数、区间、profile URL，以及可用时的
“超过 ghfind 已收录评分账号的比例”和站内评分排名。
这些是**站内评分统计**，不代表处理顺序，也不预测维护者多久回复；数据不可用时会明确说明。
新建的 pull request 打标后也可以发这封邮件，和 issue 共用同一个人、跨仓库 72 小时的静默期。管理员补扫的存量 issue 和 pull request 只打标，不发邮件。

邮件使用独立 D1 发件队列。同一人跨仓库每 72 小时最多一封；静默期内多出来的待发信会取消，不会留到 72 小时后再发。满 72 小时后，下一条打标的 issue 或 pull request 可以再发一封。全局每个 UTC 日最多 100 封。
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
