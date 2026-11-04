# AGENTS.md

本文件约束在本仓库工作的所有 agent（含子代理）。`CLAUDE.md` 与 `apps/web/AGENTS.md` 都指向这里。

- **先读的部分**：所有人读「仓库地图」「工作约定」「完成前检查」；做前端读 Frontend Stack Rules、Frontend Theme Checks、Astro Migration；改评分读「评分与开源边界」；改产品行为读「业务规则」。
- **事实来源**：代码与本文件优先。README、`docs/` 或旧注释与实现不一致时，以实现为准，并顺手修正文档或在交付中说明差异；不要把设计文档里的计划写成已上线能力。
- **系统全貌**：[`docs/architecture/overview.md`](docs/architecture/overview.md)；文档索引：[`docs/README.md`](docs/README.md)。

## 仓库地图

| 模块 | 位置 | 说明 |
| --- | --- | --- |
| 评分（公开） | `scoring/`（npm `@ghfind/scoring` + Go module；Python 端口在 `packages/ghfind-py`） | 纯函数：证据 → `RawMetrics` → 六维 + 风险 → 0–100 分与评级阶梯。不得联网、读环境变量、碰 token 或时钟 |
| 后端 | `src/lib`、`src/app/api`、`apps/api`、`apps/coord`、`apps/talent`、`internal/backend` + `cmd/*`（Go） | GitHub 采集与 token 池、扫描准入与缓存、D1 存储、AI 报告、项目评估、Feed、人才匹配。只经 `src/lib/score.ts`、`internal/backend/scoring_bridge.go` 等转发层使用评分 |
| 前端 | `apps/web`（Astro + React islands）、`src/app` + `src/components`（Next，迁移中）、`packages/i18n` | 页面、分享卡、徽章；评级名称与视觉在 `src/lib/realm.ts` |
| SDK / CLI | `packages/ghfind-js`、`packages/ghfind-py`、`cmd/ghfind` + `internal/agentcli` | 远程 API 客户端；SDK 只能本地复算（verify-only），不爬取 |
| GitHub App | `platform/github-app` | ghfind Review |
| 生产路由 | `apps/router/src/routes.ts` | `ghfind-router` 按路径分发到 `ghfind-web`、`ghfind-api` 或旧 Next Worker `ghfind` |

## 工作约定

- 修改业务规则时，先核对实现、测试和用户文案，再同步本文件与相关文档（见文末「产品资料与实现入口」）。
- 不提交密钥、token、cookie 或 storageState；生产 Cloudflare 账号固定在 `wrangler.jsonc`，不得改用其他账号部署（见 [Cloudflare 部署手册](docs/operations/cloudflare-deployment-runbook.md)）。
- 不要改写已应用到任何环境的 migration（`migrations/`、`migrations-feed/`）：D1 按文件名记录，改写不会重跑，只会让环境之间产生偏差。需要变更时新增 migration。
- 机器闸门（`pnpm frontend-stack:check`、`pnpm scoring:boundary`、ESLint 限制、split manifest 检查）不得删除、跳过或降级为 warning。
- 新文档放进 `docs/` 对应目录并更新 `docs/README.md`；过时文档在顶部标注后移入 `docs/archive/`，不要改写历史记录。

## 完成前检查

按改动范围运行，交付时如实报告结果（失败要附输出，跳过要说明）。

| 改动 | 必跑 |
| --- | --- |
| 任意 TS | `pnpm typecheck`、`pnpm lint`、`pnpm test`（或相关 vitest 文件） |
| 前端 | 以上 + `pnpm frontend-stack:check`；亮/暗主题与约 390px 宽度手动检查，PR 附截图 |
| `apps/web` / `apps/router` | `pnpm --filter @ghfind/web typecheck`、`pnpm --filter @ghfind/router typecheck`；迁移页面另跑 SEO diff（见 Astro Migration） |
| 评分 `scoring/` | `pnpm --filter @ghfind/scoring test`、`(cd scoring && go test ./...)`、`(cd packages/ghfind-py && python3 -m pytest -q)`、`pnpm scoring:boundary` |
| Go | `go test ./...` |
| 文件增删或移动 | `node ops/open-core/split.mjs check`（新文件需在 `ops/open-core/split-manifest.json` 有归属） |
| Next / OpenNext 依赖 | 见「升级 Next.js」 |
| 登录态或受保护功能 | 见「本地用户态验证」 |

## Frontend Stack Rules（约束所有 agent）

所有前端工作（含子代理）必须先读本节，并在实现时遵守。规范原文（owner，逐字）：

> 前端提示词。优先复用成熟库、组件源代码可控、统一设计语言、严格限制重复依赖。再配合指定好各种库，就算 oneshot 也能出很不错的前端。UI 风格统一使用 shadcn/ui Nova；图标统一使用 Lucide；动画统一使用 Motion；布局库 react-resizable-panels；拖拽 dnd-kit；状态管理 Zustand。

补充约束（同样强制）：

- 信息卡片紧凑、纵向密集（不要又高又啰嗦）。
- 必须支持亮/暗主题（见 Frontend Theme Checks），必须移动端响应式（含约 390px 宽度）。
- 每个库单一版本，禁止重复/替代依赖（例如 framer-motion 与 motion 并存、多个图标库、多个状态库）。
- 新的 UI 原语必须落在 `src/components/ui`（shadcn/ui Nova + Radix 封装）。页面和功能组件只从 `@/components/ui` 取控件，不要直接从 `@radix-ui/*` 或其它 UI 套件引用。
- `components.json` 的 `style` 必须是 `radix-nova`，`iconLibrary` 必须是 `lucide`。已生成的控件不要为换肤整站重写；新 `shadcn add` 与新组件按 Nova 密度（更紧的 padding/margin）写。
- 分类白名单（只许这些，且同类只一个版本）：图标 `lucide-react`；动画 `motion`（不要 `framer-motion`）；状态 `zustand`；拖拽 `@dnd-kit/*`；可调分栏 `react-resizable-panels`；UI 套件为 `src/components/ui` 中的 shadcn 源码，`@radix-ui/*` 只允许出现在该目录。
- 机器闸门：`pnpm frontend-stack:check`（依赖白名单 / 锁文件单版本 / `components.json` / 本段原文）、ESLint `no-restricted-imports`、CI Application checks。

### Reviewer checklist（每个前端 PR）

独立 reviewer 必须逐条打勾，不合规打回：

- [ ] 依赖：上述分类无替代库、无重复版本
- [ ] 组件来源：新控件在 `src/components/ui`，功能代码不直接引用 Radix / 其它 UI 套件
- [ ] 图标只有 Lucide，动画只有 Motion
- [ ] 信息卡片紧凑、纵向密集
- [ ] 亮/暗主题都检查过
- [ ] 移动端（含 390px）可用

## Frontend Theme Checks

站点支持亮色、暗色和自动三种主题。凡影响布局、颜色、卡片、字体、控件、弹窗、报告、榜单、分享面或浮动评论的改动，都要在亮、暗两种实际主题下检查。

- 新增或修改 Tailwind 类时，不要只写暗色背景而缺少亮色对应。优先沿用现有语义写法（如 `border-white/10`、`bg-white/[0.02]`、`bg-white/5`）以及 `src/app/globals.css` 中 `html[data-theme="light"]` 的全局映射。
- 交付前：用导航栏主题切换依次切到亮 / 暗 / 自动；逐一检查改动页面的文字对比度、卡片边框、hover、表单、弹窗、页脚、AI 报告 markdown，以及相关的移动端与导航界面。
- 留意背景接缝、亮色下过暗的半透明面板、暗色下过亮的边框。

## Astro Migration (apps/)

页面正从 Next 应用迁到 `apps/web`（Astro + React islands），由 `apps/router` 按路径选择 Worker（`src/routes.ts`）。语言路由逻辑在 `packages/i18n`，`src/proxy.ts` 与 `apps/web/src/middleware.ts` 共用，两套栈对访客的路由必须一致。

- 迁移后页面的 URL、metadata 与 hreflang 必须不变：运行 `pnpm tsx scripts/seo-diff.mts <next-base> <astro-base> <paths...>`，零未放行差异后才能加入路由表。
- 复用 `src/components` 中的组件作为 island（见 `apps/web/src/islands`）；`next-intl` 与 `@/i18n/navigation` 已有 shim。
- island 只拿到页面 `pickMessages(...)` 传入的消息命名空间。组件新用了 `useTranslations("x")` 时，所有挂载它的页面都要传 `"x"`，否则线上显示原始 key；`apps/web/src/lib/__tests__/island-messages.test.ts` 会检查。
- 另跑 `pnpm --filter @ghfind/web typecheck` 与 `pnpm --filter @ghfind/router typecheck`。

## 评分与开源边界

- **唯一来源**：评分公式、风险规则、评级阶梯只在 `scoring/` 定义。修改时 TS、Go、Python 三端与 `scoring/fixtures/` 同一次评审内同步；输出变化时提升后端评分版本（`config/release-versions.json`），并检查对外说明。
- **保持纯净**：`scoring/` 只能依赖自身与 `scoring/rules/`，不得联网、读 `process`/环境变量、用计时器、随机数、存储或加密 API，Go 只用标准库白名单；不得 import `src/`、`internal/` 等私有代码。`pnpm scoring:boundary` 强制执行。
- **token 池永不公开**：生产扫描使用多位用户授权的 GitHub token。采集、token 池、队列、限流、存储只属于后端；不得把它们或任何凭据移入 `scoring/`、SDK 或其它公开模块，也不得在公开代码中重新实现爬取。SDK 只做本地复算（`verifyScan` / `verify_scan`）。
- **开源拆分**：公开 / 私有归属见 `ops/open-core/split-manifest.json`，背景与切换步骤见 [`docs/architecture/open-core-split.md`](docs/architecture/open-core-split.md)。公开文件不得引用私有代码（`node ops/open-core/split.mjs blockers` 必须为 0）。

## 产品定位

ghfind 的主张是「发现最佳开发者，也成为其中之一」。产品围绕 GitHub 公开贡献，帮助用户认识开发者、理解自己的公开贡献表现、发现值得采用的开源项目，并把这些信息带到协作与职业场景中。

- **开发者本人**：查看账号评分、贡献证据和改进建议，通过个人页、徽章、分享卡或简历展示自己。
- **寻找开发者或项目的人**：通过榜单、开发者目录、人才广场和项目评估，找到值得进一步了解的人与作品。
- **开源维护者与工具集成方**：通过 ghfind Review、CLI、API、MCP 和 SDK，把公开账号信号接入自己的审查或发现流程。

账号评分与锐评是主要入口；开发者发现、项目发现、职业工具和维护者工具共同构成产品。评分描述的是可观察的公开贡献，不能代表一个人的全部能力、职业价值或某次提交的质量。锐评的趣味表达应服务于理解证据与改进，不能替代事实说明。

当前导航将人才广场 `/talent` 标为 Beta，将岗位 `/jobs` 与简历 `/resume` 放在 Beta 职业工具组。保持这些能力的实际边界，不把待接入的数据、设计文档中的计划或尚未完成的流程描述成已提供的服务。

## 核心用户流程

下列路径省略语言前缀；各语言入口应保持相同的产品含义。

| 用户目的 | 主要流程与结果 |
| --- | --- |
| 了解一个开发者 | 首页输入 GitHub 用户名 → 扫描公开数据并计算评分 → 查看维度、风险信号与证据 → 按需生成 AI 锐评 → 在 `/u/{username}` 查看个人页、分享徽章或卡片。评分与 AI 文案是两个独立步骤。 |
| 比较与持续关注 | 在 `/vs` 选择两个账号比较公开表现；从个人页关注账号，在 `/following` 回看关注对象。比较结果仍受数据覆盖范围约束。 |
| 发现开发者 | 从 `/leaderboard`、`/developers` 或语言、组织、仓库相关发现入口筛选 → 打开个人页核对贡献；也可从 `/talent` 的职业资料和 `/collections` 专题了解人选。榜单分数、人才资料和专题编排不是同一种排序依据。 |
| 发现与评估项目 | 在 `/projects` 浏览宝藏榜、经典榜或全部评估 → 提交公开 GitHub 仓库及可选 ref → 跟踪异步评估状态 → 在 `/projects/analyses/{id}` 阅读产品判断、验证程度与采用风险。符合规则的评估才进入相应榜单。 |
| 展示职业资料 | 在 `/resume` 编辑、保存和打印简历，登录后使用云端保存；在 `/talent` 自荐或推荐他人，选择可公开字段、预览并提交待审核资料；在 `/jobs` 浏览岗位与公司信息。保存简历不会自动发布人才资料。 |
| 辅助维护与集成 | 从 `/github-bot` 了解并安装 ghfind Review，给新 issue/PR 添加作者评分标签；从 `/integrations` 使用 CLI/API/MCP/SDK 获取同一套账号评分能力。安装授权、站内登录和机器调用凭证分别处理。 |

## 业务规则

### 账号评分、报告与证据

- **确定性评分**：账号总分为 0–100，六个维度是账号成熟度、原创项目质量、贡献质量、外部生态贡献、社区影响力、活跃真实性；风险规则会影响最终分数。同一评分版本和数据快照应得到相同结果。维度上限以 `scoring/src/score-presentation.ts` 为准（变更流程见「评分与开源边界」）。
- **评级阶梯统一**：当前评级为 30–100 分、每 10 分一级：`分数 < 30：练气`、`30–40：筑基`、`40–50：金丹`、`50–60：元婴`、`60–70：化神`、`70–80：炼虚`、`80–90：合体`、`90–100：大乘`，恰在分界上归入更高一级；`Lv = floor(分数)`，限定 1–100。规则只在 `scoring/src/rating.ts`（Go：`scoring/rating.go`）定义，`src/lib/realm.ts` 只负责名称与视觉，CLI 与 SDK 由 `scoring/fixtures/rating-ladder.json` 锁定。页面、分享内容与接口不能各自推导评级；翻译键在 `realms.<id>`。
- **旧五档仅为存量字段**：`Scoring.tier`（`90 夯 / 80 顶级 / 70 人上人 / 40 NPC / 其余 拉完了`）仍由 `tierFor` 写入快照并用于 Bot 标签分桶，保持不变以免影响存量快照与评分版本；新功能使用评级阶梯。退役旧五档需单独做版本化评分变更。
- **AI 不决定分数**：当前锐评沿用扫描结果的分数和等级，调整量为 0；AI 负责标签、短评与报告文字。不要沿用旧注释中的「LLM ±10 分校准」行为。AI 生成的判断不是新增事实证据，也不能用重新生成文案来改变分数。
- **分数必须有来源**：当前公开分数应来自已成功保存、具备对应评分版本和采集来源的结果；历史报告、旧缓存和迁移回退不能冒充最新扫描。新扫描保存失败时不能宣称扫描成功或发布不完整评分。缓存命中、历史查看与重新扫描应保留各自的时间和状态含义。
- **明确数据边界**：评分基于 GitHub 公开数据，私有贡献不计入，可能低估主要在私有组织工作的开发者。保留采集时间、覆盖范围和缺失信息；不能把快速扫描说成完整审计，也不能把低分、缺少公开记录或风险信号直接写成作弊事实。
- **保持公正**：更重视可核验的真实贡献与持续活动，不能简单把 star、粉丝或提交数量等同于质量。赞助只获得署名或展示位，不改变评分、排名或风险结论；赞助展示与榜单数据分开。

### 发现、排名与公开范围

- **名次与百分位有不同口径**：站内名次和百分位都基于本站已评分的有效样本，不代表整个 GitHub。名次排除隐藏账号；百分位统计包含隐藏账号。展示精度为 0.1 分时，同一分桶视为并列；无可用统计时保留未知状态，不编造排名。
- **全 GitHub 位置是另一种口径**：个人页「在全 GitHub 中的位置」和项目页的全 GitHub 名次，只比较公开原始数据（仓库 star 数、账号注册时间），不比较 ghfind 分数。数据来自离线采集的 GitHub Search 计数快照，由 `scripts/github-population.mts` 生成；线上只查表，不调用 GitHub API。插值得到的结果标注「约」或「≈」，并显示快照日期。不能把它和站内名次混用，也不能写成 ghfind 分数在全 GitHub 的排名。
- **公开访问与搜索收录分开**：公开账号主榜默认门槛为 60 分；低于 60 分的个人页仍可访问和分享，但不进入 sitemap，并设置 `noindex`。保留隐藏账号过滤，不能把主榜门槛当作评分查询权限。
- **PK 有独立门槛**：双方都达到 55 分才满足 PK 的 AI 判词与搜索收录门槛；不要套用个人页的 60 分门槛。阈值统一读取 `src/lib/site.ts`。
- **不同目录保持来源区别**：人才目录可以包含人工整理资料，专题可以有编辑编排，不能把它们的推荐顺序包装成算法评分排名。人才资料中的 GitHub handle 也不等于账号归属已验证。

### 项目评估

- **评估对象是项目**：项目产品分、评估置信度、验证程度、社区信号和曝光度分别表达不同信息；不要用开发者账号分数、star 数或热度直接替代产品质量。报告必须区分只看元数据、读过源码、构建成功和实际执行核心流程。
- **提交、完成与上榜是三个状态**：提交返回任务不代表评估完成；失败、取消或过期不能展示为成功报告。完成并保存的评估可以进入评估列表，但是否进入宝藏榜或经典榜还要满足各自规则。
- **两类榜单的目标不同**：宝藏榜寻找低曝光或初露头角、已有源码验证依据的项目；经典榜寻找已有知名度且处于持续演进、稳定维护或功能完备阶段的项目。两者均设产品分与置信度门槛，并排除存在 critical 采用风险的项目。具体阈值以 `src/lib/project-ranking.ts` 为准，不能只按热度混排两类榜单。

### 个人资料、身份与授权

- **公开查询不证明身份**：`GET /api/score/{username}` 无需登录；扫描、AI 生成、云端简历、关注操作和机器调用各有自己的鉴权或防滥用规则。不能因为评分可公开查询，就取消受保护操作的校验，也不能给普通公开浏览强加统一登录门槛。
- **简历保存不等于公开发布**：本地保存与登录后的云端保存应明确区分；云端冲突或保存失败时保留本地修改，不能提示已同步。模板示例不是用户真实经历，不应写入用户草稿。
- **人才提交需要审核**：自荐和推荐他人的资料先保存为 `pending`，公开目录只展示 `published`。GitHub 录入当前只检查 handle 格式，不验证账号存在性或自动抓取资料，不能承诺提交后已同步 GitHub。
- **公开字段由用户选择**：从简历导入人才表单时只填充当前草稿，导入字段默认不公开，不自动带入法定姓名，也不修改原简历。推荐他人不导入提交者的简历，不携带对方的联系方式等私密字段；确认前提供公开内容预览。

### ghfind Review 的行为边界

- **辅助人工分流**：默认给新 issue 和 PR 添加作者评分标签，不自动拦截、关闭或拒绝提交。作者评分不代表本次提交质量；评分不可用使用 `review: no-score`，不能当作 0 分。Bot 标签区间是 40、70、90，对应 low/medium/high/top，与网站评级阶梯不同。
- **额外动作由仓库管理员开启**：意图标签和评分评论默认关闭；安装只初始化标签，已有条目由管理员主动补扫。开启意图分类后只从管理员勾选的现有标签中选择，不能创建或移除标签；补扫不发评分评论。仓库管理权限必须按实际 GitHub 权限校验，不能由 URL 中的仓库或安装 ID 推定。

### Feed 内容范围

`/feed` 包含 X 内容镜像和 ghfind 本地帖子，主流不混排项目、人才、文章或招聘。顶层仅推荐和关注；收藏是私有互动，可从菜单查看，不增加第三个频道。

- 浏览公开帖子无需登录或评分；本地主帖、回复和回复的回复均要求服务端验证的 GitHub 身份及当前有效 ghfind 分数 ≥60。点赞、收藏、转发、关注和不喜欢需登录，不要求评分。分数不得四舍五入后放行。
- 发帖资格静默读取数据库中最近保存的评分及原始来源证据，不因扫描缓存过期或评分版本更新而要求重新测评。旧采集快照缺少显式 GitHub ID 时，可从哈希校验通过的历史快照内 GitHub 官方头像 URL 提取稳定数字 ID，与已登录身份比较；不得从当前头像或仅用户名推断历史归属。只有无评分记录才引导查询，已有低分明确拒绝，读取或归属校验失败提供重试。
- 本地帖子及所有本地互动仅保存在 ghfind，不同步到 X。X 镜像只导入正文、媒体和必要来源/身份信息；禁止采集、保存或展示 X 的评论区与互动计数。
- X 作者必须有可核验的 GitHub 身份绑定和有效 ≥60 分记录。展示 X 名字与 @GitHub ID；右上角 X 标仅属于 origin=x，并链接对应原帖。原生帖即使包含 X 链接或回复 X 镜像也不得显示来源 X 标。
- 回复同样是帖子，通过 parent_post_id 和 conversation_id 关联，可继续回复任意一层。删除保留结构占位，不级联删除他人的回复。
- 站内点赞、转发、回复和浏览数从站内事件产生；收藏与不喜欢仅本人可见。点赞与不喜欢互斥。不得用演示数或 X 计数充当站内事实。
- 不添加热门、标签、来源分类等装饰徽标；原文中的话题文字保留。目前仅按时间分页，保留可替换的 Feed 提供方与反馈接口，未实现个性化算法。
- 右侧「今日开源项目」独立从符合宝藏榜资格的项目中按上海日期稳定选取，仓库名直达 GitHub；「今日」指推荐日期，不代表当天发布。缺数据时展示空态，不自动注入虚构帖子。

## 升级 Next.js

`next` 和 `@opennextjs/cloudflare`（OpenNext 适配器）必须一起升级。适配器落后于 Next 大/小版本时构建仍会通过，但线上经 Next 服务端的请求（如 `/api/feed/*`）会抛 `Unexpected loadManifest(...)` 并返回 500，部署冒烟失败（2026-11-01：Next 16.4.1 + 适配器 1.20.3）。

- 升级前确认适配器的 release notes 或 issue 已支持目标 Next 版本，并同步升级。
- 合并前本地运行 `NEXT_PUBLIC_GHFIND_DEPLOY_PLATFORM=cloudflare pnpm exec opennextjs-cloudflare build`，不要只跑 `pnpm build`。
- 合并后盯住生产部署的 smoke（`pnpm smoke:deployment`），失败按 Feed 切换回滚流程处理。

## 本地用户态验证

涉及登录态、本人/他人判断、用户数据、角色权限或受保护操作时，必须用本地后端认可的测试身份进入实际业务页面验证；不能只 mock `/api/me` 或用组件测试页代替。工具已实现，用法、续期与重置见 [`docs/development/local-accounts.md`](docs/development/local-accounts.md)。

- **工具**：`pnpm run init`（可重复执行：保留已有身份，只补缺失的账号、角色映射和数据）、`pnpm dev:local`（固定 `http://127.0.0.1:4390`，不要换成 localhost）、`pnpm local:open <角色>`、`pnpm local:verify`、`pnpm local:renew`。角色：`owner`、`other`（同组隔离）、`internal`、`social`、`guest`。
- **固定复用**：按角色加载已保存的身份，不临时编造用户名；会话过期用 renew 恢复；权限模型变化时同步更新 init。各账号使用隔离的浏览器 context。
- **先核对再操作**：通过真实 `/api/me` 响应确认身份、provider 和所需权限，再进入实际路由。缺资料时先准备本地数据，不能用空页、404 或独立组件页作为验收结果。涉及写入或授权时，同时验证真实接口的允许/拒绝结果和数据归属。
- **边界**：按改动覆盖会话加载、失效、退出、切换账号和用户名大小写。异常场景可辅助 mock，但须与真实登录态验证分开记录。只有验证第三方 OAuth 流程本身时才需要真实测试账号。
- **安全**：凭据、cookie、token 和 storageState 只放在不入库的 `.local/dev/`，不输出内容、不附在截图或 PR 中；本地会话不得修改生产鉴权或增加生产登录后门。
- **交付证据**：记录非敏感账号标识、路由和结果，并区分「真实 OAuth 登录」「本地生成且后端认可的测试会话」和「mock」；后两者不能宣称完成真实 OAuth 验证。

## 产品资料与实现入口

| 主题 | 优先核对的仓库文件 |
| --- | --- |
| 产品介绍与入口 | `README.zh.md`、`src/config/nav.ts`、`src/messages/zh.json` |
| 账号评分与公开数据 | `scoring/`（`src/score.ts`、`src/extract.ts`、`src/rating.ts`、`*.go`、`fixtures/`）、[`docs/rfc/2026-10-15-account-scoring.md`](docs/rfc/2026-10-15-account-scoring.md)、`src/app/api/scan/route.ts`、`src/app/api/score/[username]/route.ts`、`internal/backend/scoring_bridge.go` |
| 评级展示 | `src/lib/realm.ts`、`src/messages/*.json`（`realms.*`） |
| AI 报告 | `src/app/api/roast/route.ts`、`src/lib/roast-handler.ts` |
| 发现与排名 | `src/lib/db.ts`、`src/lib/rank.ts`、`src/lib/site.ts`、`src/lib/pages/profile.ts` |
| 全 GitHub 位置 | `src/lib/github-standing.ts`、`src/lib/github-population.ts`、`scripts/github-population.mts` |
| 项目评估与榜单 | `src/lib/project-analysis-contract.ts`、`src/lib/project-analysis-service.ts`、`src/lib/project-analysis-db.ts`、`src/lib/project-ranking.ts` |
| 简历与人才资料 | `src/components/resume/ResumeBuilder.tsx`、`src/app/api/resumes/route.ts`、`src/components/talent/intake.ts`、`src/lib/talent-intake.ts`、`src/lib/talent-db.ts` |
| GitHub App | `platform/github-app/README.zh.md`、`platform/github-app/src/` |
| 开源拆分 | `ops/open-core/split-manifest.json`、`ops/open-core/split.mjs`、[`docs/architecture/open-core-split.md`](docs/architecture/open-core-split.md) |
