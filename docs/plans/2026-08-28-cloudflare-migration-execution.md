# Cloudflare 迁移执行方案（dev 域先行，验证后切正式）

> 2026-08-28。分析背景与成本测算见 [2026-08-28-cloudflare-migration-analysis.md](./2026-08-28-cloudflare-migration-analysis.md)，本文件是可执行的作战清单，按阶段推进、逐项勾销。
> 原则：**每一步生产零感知；切正式 = 改一条 DNS 记录；任何时刻可秒级回滚。**

## 环境与命名

| 环境 | 前端 | 后端 API | 数据面 |
|---|---|---|---|
| dev（新建，常驻，未来即 staging） | `dev.ghfind.com` → Workers (env: dev) | `api-dev.ghfind.com` → Workers (env: dev)；阶段 1 期间暂指 Railway/staging mocks | `GHFIND_STAGING_*` 那套（staging Turso/Upstash/Mosoo） |
| production | `ghfind.com` / `www`（切换前 = Vercel 灰云记录；切换后 = Workers env: production） | 阶段 2 起 `api.ghfind.com`（或纯 Service Binding 不出网） | 生产 Turso/Upstash → 阶段 3 迁 D1/KV/DO |

命名规则：**只用一级子域**（`api-dev.ghfind.com`，不用 `dev.api.ghfind.com`）——免费版 Universal SSL 只覆盖 `*.ghfind.com` 一层。

dev 环境四项隔离（缺一不可，上线 dev 域前逐项确认）：
- [ ] 数据面走 `GHFIND_STAGING_*`，不碰生产 Turso/Upstash
- [ ] 单独的 GitHub OAuth App（callback = `https://dev.ghfind.com/api/auth/callback/github`）
- [ ] Turnstile 域名白名单加 dev 域（或独立测试 site key）；`PUBLIC_SITE_URL=https://dev.ghfind.com`
- [ ] 防收录：`X-Robots-Tag: noindex` + Cloudflare Access 套在 `dev.ghfind.com` / `api-dev.ghfind.com` 上（免费，顺带挡爬虫农场、防埋点污染）

---

## 阶段 0 — 摸底与地基（1–2 天）

### 0.1 OpenNext spike（go/no-go 门，本地可完成）
- [ ] `pnpm add -D @opennextjs/cloudflare wrangler`
- [ ] `open-next.config.ts` + `wrangler.jsonc`（nodejs_compat、assets、R2 增量缓存先用占位）
- [ ] `opennextjs-cloudflare build` 通过；记录 worker 压缩后体积（付费档上限 10MB gzip）
- [ ] `wrangler dev` 本地冒烟：首页(zh/en)、/u/octocat、一条卡片路由（预期 fs 报错，确认报错面与分析一致）、proxy.ts locale 跳转
- [ ] 结论落盘本文件：go / no-go / 需上游修复项

### 0.2 平台盘点（防 dashboard 暗配置）
- [ ] Vercel：`vercel crons ls`（或 dashboard）确认有无未入库 cron；`vercel env pull` 全量 env 清单归档到本地（勿入库）；WAF 规则全量导出（28 ASN challenge / bypass / lightpanda deny / Bot Protection 状态）
- [ ] Turso：实测库体积与热表行数；**确认 `public_scan_*` 12 表是否死表**（死则记录 DROP 清单）
- [ ] Railway：确认 3 服务资源用量与月费实数
- [ ] 三平台真实月账单数字回填分析文档的成本表

### 0.3 Cloudflare 地基（含用户手动步骤）
- [ ] 注册/确认 Cloudflare 账号，装好 wrangler auth
- [ ] **[用户操作]** ghfind.com（含 3 个 308 旧域名）NS 迁到 Cloudflare：现有记录 1:1 复制、指向 Vercel 的记录保持**灰云 DNS only**、迁移前把各记录 TTL 调低
- [ ] 验证：NS 生效后生产站点、OAuth 回调、badge/camo 抓取全部正常（灰云 = 流量路径不变，预期零影响）
- [ ] 建 R2 bucket（增量缓存）、KV namespace；Cloudflare Access 应用建好待绑 dev 域

## 阶段 1 — 前端上 Workers，dev 验证 → 切正式，下线 Vercel（5–8 人日）

### 1.1 代码改造（分支 `feat/cf-frontend`，全程不影响 Vercel 部署）
- [ ] 消灭运行时 fs：卡片字体（`src/app/api/card/shared.ts`）改内联 import；`tier-emoji.server.ts` / `sponsor.server.ts` SVG 内联；`content/` 博客与合集改构建期打包（`blog.ts` / `collections.ts`，sitemap 与 llms*.txt 的 ISR 再生路径一并处理）
- [ ] BotID → Turnstile：`layout.tsx`（去 BotIdClient）、`src/app/api/vs-verdict/route.ts`（checkBotId → Turnstile 校验）、`next.config.ts`（去 withBotId）
- [ ] IP 头：`x-vercel-forwarded-for` → `CF-Connecting-IP`（vs-verdict、project-analyses）
- [ ] `VERCEL_ENV` 三处改 `GHFIND_ENV`：**`redis.ts`（限流 fail-closed，漏改即静默失守）**、`anonymous-session.ts`、`site.ts`
- [ ] 埋点：`track.ts` 传输层切 GA4 事件（28 个事件名不动）；删 `@vercel/analytics`、`@vercel/speed-insights`、`next-auth`（死代码）依赖
- [ ] wrangler env 两套：dev / production；dev 加 `X-Robots-Tag: noindex` 响应头

### 1.2 dev 域验证
- [ ] 部署 dev env → 绑 `dev.ghfind.com` + Access
- [ ] `GHFIND_BACKEND_ORIGIN` 指 Railway（staging 或生产只读路径），四项隔离检查过一遍
- [ ] `SMOKE_BASE_URL=https://dev.ghfind.com pnpm smoke:deployment` 全绿
- [ ] 手工回归：9 locale 切换与 RTL(ar)、OAuth 登录、scan/roast 全流程、卡片/badge/OG 图、/mcp、blog+collections、llms*.txt、sitemap
- [ ] 压测卡片路由（Satori 冷启动 CPU）与首页 ISR 命中

### 1.3 WAF/防护平移（切换前在 CF 侧就位）
- [x] **已上线（08-29，Rulesets API 写入 ghfind.com zone）**三条自定义规则，顺序即求值序：① Skip 机器端点（跳过本 ruleset 其余规则+托管 WAF+BIC/securityLevel）② Block Lightpanda ③ Managed Challenge 28 农场 ASN（**显式排除 /api/scan、/api/roast**，修正 08-09 XHR 事故）。验证：Lightpanda 打首页 403 / 打 badge 被 skip 放行 200；llms.txt/card 不受 challenge；本机机场出口 ASN 在名单内被 challenge（`cf-mitigated: challenge`，真浏览器无感通过，与 Vercel 时代同名单行为一致）。
- [x] 边缘 rate limit 决策：**方案 A**——不在边缘做（免费档仅 1 条且窗口 10s 无法 1:1 平移），依赖应用层现成同预算限流（scan-network 60/min、roast-network 48/min+480/天）。
- [x] Bot Fight Mode 决策：**保持关闭**——免费档 BFM 不受 skip 规则豁免，会 challenge /mcp 和 agent 流量，与 GEO/agent 策略冲突；对应 Vercel Bot Protection 本来也停在 Log 未启用。
- [ ] Turnstile 生产 site key 域名白名单加 dev/正式域（secret 本地为空待配）
- [ ] 观测就位：Workers Logs 已开（wrangler.jsonc observability）+ GA4 事件收数验证

### 1.4 切正式
- [ ] 部署 production env，用生产 env vars（backend origin 仍指 Railway）
- [ ] 低峰期：`ghfind.com`/`www` DNS 从 Vercel 灰云记录改绑生产 Worker；旧域名 308 用 CF Redirect Rules 接管
- [ ] 盯 48h：错误率、scan/roast 动作数（真人指标不跌）、camo/badge 抓取、OAuth 回调、账单曲线
- [ ] 回滚预案：DNS 记录改回 Vercel（Vercel 项目保留只读一个计费周期再注销）
- [ ] 稳定一周 → **注销 Vercel Pro**；改写 `deploy-gate.mjs`（Vercel 段 → wrangler deploy + versions 回滚，Railway 段暂留）

## 阶段 2 — Go 后端 TS 化上 Workers，下线 Railway（审计后修正：5–7 人日）

> **2026-08-29 审计定论（决定性事实：拆 Go 时 `f557571` 只删路由壳、src/lib 零改动）**：13 个面 = 8 REUSE + 4 PARTIAL + 1 PORT。
> 路由壳全部可从 `f557571^` 恢复；分数版本两侧一致（v9/v4/v10/v1），无数据迁移。
> **架构决策**：/api/scan 回同步即时打分（不重建队列——07-21 #144 已拆过一次，runbook 记录同步延迟与队列版相当）；campaign SSE 先恢复 TS 每连接轮询版（isolate 各自轮询可接受，DO 优化留后）；vs-verdict 网关塌缩进同 worker，HMAC 网关与 GHFIND_VERDICT_GATEWAY_SECRET 删除。
> **必做的非恢复项**：① OAuth 手搓 HMAC cookie 重写（WebCrypto，~300 行，唯一 PORT）；② 两个 Go-only 采集器移植（github_organization_work + github_contribution_languages，~183 行）；③ Go 漂移 9 commits 复核（force=1 绕缓存、SSE revision 过期修复、api.github.com OAuth profile 等）；④ 守卫测试处理（backend-extraction-boundary.test.ts 是拆分的机械执法者，恢复第一批时删除；route-ownership/runbook/openapi 合同测试随面更新）。
> **切流批次**：B1 公共读(stats/search/leaderboard/facet-rank/developers/score) → B2 MCP+badge 数据 → B3 OAuth+me+社交 → B4 roast+vs-verdict 塌缩 → B5 scan 同步化+Go-only 端点删除(profile/vs/sitemap presentation shim 由页面直调 db.ts) → 观察一周注销 Railway。每批 = 恢复壳+接线+从 next.config rewrites 摘除对应路径。

- [ ] 脚手架：API Worker（Hono 或原生 router）+ Queues ×3（score-snapshot / scan-quick / project-analysis，各带 DLQ）+ 消费者 Worker + Workflows；Turso 用 `@libsql/client/web`、Upstash REST 原样连
- [ ] 切流批次（dev 域先验，再逐路由把生产 rewrite 从 Railway origin 指向 Worker；Railway 全程在线兜底）：
  - [ ] 批 1：/mcp、OAuth/session ×4、16 条公共读（全无状态）
  - [ ] 批 2：社交 CRUD ×13、admin/internal、embed/badge
  - [ ] 批 3：scan 管线（Queues + **DO 完成通知**替代 55s×250ms 轮询）、score/profile live
  - [ ] 批 4：roast LLM 流（TransformStream）、vs-verdict（同源化，**删 HMAC 网关 + GHFIND_TRUST_VERCEL_HEADERS**）、campaign SSE（每 campaign 一个 DO）
  - [ ] 批 5：project-analysis → Workflows（复用 `src/lib/mosoo-project-analysis.ts`，Mosoo 原样调用）
- [ ] Go 合同测试移植 vitest：scan 持久化分支、限流窗口边界、schema 边界
- [ ] 全量切完观察一周 → **注销 Railway 3 服务（含 RabbitMQ+卷）**；删除 `jobs.go` 等 Go 部署面、Dockerfile.backend、railway.json；deploy-gate Railway 段删除

## 阶段 3 — Turso→D1、Upstash→KV/DO，全部下线（5–10 人日）

- [ ] `ensureSchema` 62 条语句抽成 `wrangler d1 migrations`（repo 首个 migrations 目录）；运行时 DDL 机制删除
- [ ] 23 处 TS 交互式事务改写：守卫式条件 UPDATE + 影响行数断言（模板 `project_analysis_db.go:757`）；scan 租约状态机吃力则上 DO
- [ ] 排雷随迁：trending 榜加 LIMIT/预聚合、`account_lookup_limits` 加清理、`searchRepos` 表达式索引；死表 DROP（0.2 的清单）
- [ ] 数据迁移：低峰停写窗口 <1h，Turso dump → `wrangler d1 import`，dev 域全量回归后切生产
- [ ] Upstash：缓存 → KV/Cache API；13 个限流器 + 锁 → DO（一个 DO 类 + 配置表），窗口边界行为对拍
- [ ] **暂不开 D1 读副本**（scan 依赖写后读）
- [ ] 观察一周 → **注销 Turso、Upstash**

## 进度记录

- 2026-08-29：**B4+B5a 完成（a70de87, 60494f7）**：B4=roast 完整恢复（1061 行帧协议+安全清洗+CAS 持久化，dev 上流出完整报告）+ vs-verdict 塌缩（HMAC 网关删除，Turnstile 门+floor 门合同测试钉死，dev 实测 below_floor 正确不烧 LLM）。B5a=scan 同步化（jobs stub 删除，无前端消费者）+ 两个 Go-only 采集器移植进 github.ts（证据函数 TS 全有，纯移植采集逻辑 ~250 行）。**关键验证：Worker 与 Railway 现打现比 octocat，总分 30.7=30.7，六个子分到小数全等——打分引擎完全等价**。841 测试全绿。剩余 rewrite 13 条：presentation shims（profile/vs/sitemap/projects/embed/project-boards→B5b 直读 db）+ internal/admin（B5c）。**Go 漂移 9 commits 尚未复核**（force=1 绕缓存、SSE revision 过期修复等，B5c 一并）。
- 2026-08-29：**B2+B3 完成（cf3fc6f, 9cc321a）**：B2=/mcp（mcp-handler 路由+工具恢复，dev 上 tools/list+score_user 实调通过）+badge 直读 db。B3=OAuth 全套重写（**oauth-session.ts 与 Go 签名逐字节兼容，存量 ghfind_session cookie 切换后继续有效**，合同测试钉死 wire format）、/api/me、社交五件套+campaign SSE 恢复（auth.ts 重建为旧 auth() 合同的薄适配器，恢复的处理器零改动）、reactions 补 Go 时代新增的 GET（与 Railway 逐字节一致）。837 测试全绿。**数据库迁移结论（用户当日提出想立刻迁）**：物理不可行——Railway Go 连不上 D1，先迁数据=写入断流；papers/paper_roasts 确认废弃不迁。剩余 rewrite 16 条（scan/roast/profile/vs/embed/sitemap/projects/project-analyses/internal/admin）→ B4 roast+verdict、B5 scan 同步化+双采集器+shim 清理后清零。**B4/B5 未做**；AUTH_GITHUB_ID/SECRET+AUTH_SECRET 生产值在 Railway env，切流时需用户从 dashboard 取出。
- 2026-08-29：**阶段 2 审计 + B1 完成（023529f）**：审计定论 8 REUSE/4 PARTIAL/1 PORT（详见上方阶段 2 节），工作量 15-25 人日修正为 5-7。B1 六条公共读路由（stats/search-users/leaderboard/developers/facet-rank/score）从 `f557571^` 恢复原实现、摘 rewrite、删 boundary 守卫测试、所有权矩阵重分类；dev 上与 Railway 响应键集对拍全一致，809 测试全绿。**B1 目前仅 dev 生效**，production 待并跑结束随下次 prod 部署切流。剩余批次：B2 MCP+badge → B3 OAuth(唯一 PORT)+me+社交 → B4 roast+verdict 塌缩 → B5 scan 同步化+Go-only 采集器移植+presentation shim 删除。
- 2026-08-29：**🚀 正式切换完成（656c3f9）——ghfind.com 现由 Cloudflare Worker 服务，Vercel 并跑兜底 48h**：
  - 切换前验证：dev 修复 build 期 GHFIND_BACKEND_ORIGIN 缺失（.env 已补，beforeFiles 重写才会生成——**此坑切记**）；Go-owned API 面 10 端点 + MCP initialize/tools-list 全通过；官方 smoke 仅"canonical origin 相等"一项不过（测试域上定义性不可能，非缺陷）。
  - production 部署：worker `ghfind` + workers.dev 验证入口（beiming1201.workers.dev，并跑结束后关）+ 11 secrets + R2 缓存 321 项 + vars PUBLIC/NEXT_PUBLIC_SITE_URL=https://ghfind.com；workers.dev 上 21 路由全 200 后才动 DNS。
  - 原子切换：删 apex CNAME（记录 id 041b947d…，指 922fe19d07a85c6f.vercel-dns-016.com 灰云）→ `wrangler deploy --env production` 绑 custom domain，间隙约 10s。
  - 切换后验证：apex 经 1.1.1.1 解析 CF 边缘；llms.txt/badge/card 经 Worker 200；/en 对农场 ASN 出 `cf-mitigated: challenge`（WAF 生效）；www 经 Vercel 通配符 307 回 apex（并跑期正常）。
  - **回滚（30 秒）**：`wrangler triggers` 删 ghfind.com custom domain（或 dashboard Workers→ghfind→Domains 移除）+ 恢复 DNS：`POST /zones/ae7ba9c0…/dns_records {"type":"CNAME","name":"ghfind.com","content":"922fe19d07a85c6f.vercel-dns-016.com","proxied":false}`。Vercel 侧域名未动，恢复记录即回到切换前。
  - **并跑期注意**：① 旧 NS 缓存的解析器（含用户本机机场出口）最长 48h 内仍把流量送 Vercel——这正是并跑的意义；② **并跑期间别 push main**（deploy gate 只更新 Railway+Vercel，CF 侧会滞后；确需发版则同时手跑 `pnpm cf:deploy:prod`）；③ 观察面：CF dashboard Workers 请求/错误曲线、GA4 事件、Vercel 账单应随流量迁移下降。
  - 并跑结束后（≈08-31）待办：注销 Vercel Pro、production 关 workers_dev、githubroast.dev/.icu 上 Redirect Rules 接管 308、merge 分支 + deploy gate 改写 wrangler、www 显式记录。
- 2026-08-29：**dev 全量回归修复完成（b2c61e9）**：① `/projects` 500 根因=`@libsql/client` 在 Next 默认 serverExternalPackages 里被外部化、Workers 加载失败——db.ts/project-analysis-db.ts 换 `/web` 入口 + `transpilePackages` 强制打包 + 补 `@libsql/isomorphic-*` 依赖；vitest 把 `/web` 别名回 Node 客户端保住 file: 测试夹具。② 预渲染 blog/collections 404 根因=裸 `wrangler deploy` 不灌 R2 增量缓存——`populateCache remote` 并入 cf:deploy 脚本（318 项已灌）。复测：/projects、/u、榜单、/vs、/ar(RTL)、/en/blog/[slug]、/collections/[slug]、`/blog/[slug].md`、卡片 PNG、sitemap 全 200。`/blog-md/` 直连 404 为 locale 中间件既有行为（生产同），非回归。**DNS 传播注意**：注册局/公共解析器已全量指向 CF，但用户与本机的机场出口解析器缓存旧 NS 委托（TTL 48h），期间 dev 域会被送到 Vercel 404——换代理节点即解，最迟 08-30 自然消退；正式切换日同样会有此尾巴（Vercel 保活缓冲期就是为这个）。
- 2026-08-28：**阶段 1.2 dev 环境上线并冒烟通过**：`ghfind-dev` worker 部署成功、`dev.ghfind.com` 自定义域绑定（wrangler 自动建了 proxied 记录）；11 个密钥经 `wrangler secret bulk` 推送（源=本地 .env + Railway 域名 `ghfind-api-production.up.railway.app`；**Vercel 的 Sensitive 密钥 pull 不出来，.env 才是可用源**）。真边缘冒烟：zh/en 首页、blog、llms.txt 200，`/api/card/octocat` 出 136KB PNG，badge SVG 证明 Worker→Railway 通，`X-Robots-Tag: noindex` 生效。已知残留：① 本机及部分 resolver 仍缓存旧 NS（1-2 天内 dev 域可能解析到 Vercel 404，1.1.1.1 已正确）；② dev 的 GHFIND_BACKEND_ORIGIN 指生产 Railway——**dev 上测 scan/roast 会写生产数据**；③ dev 域 OAuth 登录会回跳生产（需单独 GitHub OAuth App 才能闭环）；④ Turnstile secret 本地 .env 为空未配，dev 上人机检查按设计跳过。
- 2026-08-28：**阶段 1.1 代码改造完成并本地全绿**：
  - fs 消除：`scripts/gen-embedded-assets.mts` 生成 `src/generated/`（content 775KB + 字体/emoji/sponsor 104KB，已提交并接入 dev/build 脚本），`src/lib/content-files.ts` 虚拟文件层；blog/collections/卡片字体/tier-emoji/sponsor 全部离盘。
  - BotID→Turnstile：vs-verdict 路由改 `verifyTurnstile`（x-turnstile-token 头），VsVerdictLive 拿 token 才开火（复用现有 Turnstile 组件与 key，未配置时跳过），layout/next.config 拆除 botid；测试重写为 Turnstile 合同（含 CF-Connecting-IP 优先）。
  - 平台解耦：`src/lib/deploy-env.ts`（GHFIND_DEPLOY_ENV 优先、VERCEL_ENV 兜底），redis.ts fail-closed / anonymous-session / site.ts 三处切换；vs-verdict IP 头 CF 优先。
  - 埋点：track.ts 双通道（GA4 恒发 + Vercel 通道仅 Vercel 构建，`NEXT_PUBLIC_GHFIND_DEPLOY_PLATFORM=cloudflare` 时 AnalyticsGate 不挂载）；GA4 的 webdriver 门沿用 layout 现有实现。
  - wrangler dev/production 双环境（dev=dev.ghfind.com+noindex+独立 R2 桶 ghfind-next-cache-dev；production 暂不绑域名）；open-next 切 R2 增量缓存；proxy.ts 非生产环境注 X-Robots-Tag noindex。
  - 死代码清除：next-auth（auth.ts/types）、@vercel/speed-insights、botid 依赖移除。
  - 验证：tsc 双 tsconfig ✅、vitest 805/805 ✅、eslint 0 error ✅、OpenNext 构建 ✅、wrangler dev 冒烟 `/api/card/octocat` **出真 PNG**、blog/collections 200、noindex 头生效。
  - 待办：`wrangler secret put`（dev env 的 TURSO/UPSTASH/GHFIND_BACKEND_ORIGIN/TURNSTILE_SECRET_KEY/LLM_*）→ 部署 dev → 绑域回归；Turnstile widget 域名白名单加 dev.ghfind.com；GA4 事件到达验证。
- 2026-08-28：方案落盘。阶段 0.1 spike 开始。
- 2026-08-28：**阶段 0.1 spike 完成，结论 GO ✅**（分支 `feat/cf-frontend-spike`）：
  - `opennextjs-cloudflare build` 零代码改动一次通过（@opennextjs/cloudflare 1.20.3 + Next 16.2.9）；`proxy.ts` 以 Node.js middleware 模式打包（OpenNext 标记 experimental，切换前多回归）。
  - bundle：19.3MB 原始 / **4.26MB gzip**（付费档 10MB 上限，余量充足）；.open-next 共 160MB、静态资产 2.4MB。
  - `wrangler dev` 冒烟：`/`(zh)、`/en`、`/en/blog`(SSG)、`/leaderboard`(force-dynamic)、`/llms.txt`、`/robots.txt`、`/api/badge/octocat`(经 ghfind.com 调 Go 后端) 全部 200 ✅。
  - 预期内失败：`/api/card/*`、`/api/og/home` 500——字体 fs 读取；**OpenNext 已把 woff 拷到 server assets（ENOENT 路径 `/server/assets/Inter-Regular.*.woff`），大概率是资产声明/读取方式的配置级修复而非代码重写**，阶段 1 首项。
  - `/u/octocat` 404 为本机冒烟触发后端 10/min 公共读限流（直连 API 得 429），非移植缺陷。
  - 环境注意：packageManager 从 pnpm@9.12.1 对齐到 11.24.0（node_modules 实际是 v11 store 装的，9/11 错配导致无法安装依赖）；wrangler compatibility_date 用 2026-08-06（本地 workerd 上限）。
- 2026-08-28：**阶段 0.3 NS 迁移完成**：3 个 zone（ghfind.com `ae7ba9c0…`、githubroast.dev `bf5ebbe3…`、githubroast.icu `1f7bcf52…`）记录与 Vercel DNS 权威值 1:1（apex/通配符 CNAME→vercel-dns-016，全灰云；ghfind 旧 zone 里扫描快照的硬编码 A 记录已换成 CNAME）；用户在 Vercel dashboard 改 NS → `bristol`/`konnor.ns.cloudflare.com`，注册局层面三域全部生效；**ghfind.com 与 .dev 已 active**，.icu pending 自动转。真浏览器验证生产正常（本机/WebFetch 的 429 是既有 ASN challenge 拦机房出口，与迁移无关）。API token 存 `~/.config/cf-migration/token`（Zone/DNS/Settings/WAF Edit）；建 zone 脚本 `tmp/cf-zone-setup.sh` 幂等可重跑。R2 桶 `ghfind-next-cache` 已建（阶段 1 增量缓存用）。**注意：wrangler OAuth 无 zone 写权限，zone/DNS/WAF 操作都走这个 token。**
- 2026-08-28：阶段 0.2 盘点完成大半（结果归档 `local-notes/cf-migration/`）：**无 Vercel cron**；WAF 5 条规则全量导出+CF 表达式草稿（含 08-09 scan/roast XHR 被 challenge 事故的修正）；Turso 实测 **852MB**、scores 26k 行；public_scan_* 半死（runs/pr_facts/owned_repo_facts 活、jobs/commit_*/worker_metrics 死于 07-21 可清）；**发现 schema 外的 papers/paper_roasts 两表**（别的实验共库，迁移前须确认归属）。剩余：Railway/三平台账单实数（dashboard 人工查）。
