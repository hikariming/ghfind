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
- [ ] ASN challenge 列表（28 个，一条 `ip.src.asnum in {…}` 表达式）+ 机器接口 bypass（/mcp、/llms*、/openapi.json、/auth.md、/api/card*、/api/badge* 等）+ lightpanda deny
- [ ] Turnstile 生产 site key、`/api/scan` 接入验证与 XHR 放行（复查 waf-challenge-blocks-xhr 教训：challenge 规则必须排除 scan/roast XHR 路径）
- [ ] 观测就位：Workers Logs + GA4 事件收数验证，否则切换期盲飞

### 1.4 切正式
- [ ] 部署 production env，用生产 env vars（backend origin 仍指 Railway）
- [ ] 低峰期：`ghfind.com`/`www` DNS 从 Vercel 灰云记录改绑生产 Worker；旧域名 308 用 CF Redirect Rules 接管
- [ ] 盯 48h：错误率、scan/roast 动作数（真人指标不跌）、camo/badge 抓取、OAuth 回调、账单曲线
- [ ] 回滚预案：DNS 记录改回 Vercel（Vercel 项目保留只读一个计费周期再注销）
- [ ] 稳定一周 → **注销 Vercel Pro**；改写 `deploy-gate.mjs`（Vercel 段 → wrangler deploy + versions 回滚，Railway 段暂留）

## 阶段 2 — Go 后端 TS 化上 Workers，下线 Railway（15–25 人日）

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

- 2026-08-28：方案落盘。阶段 0.1 spike 开始。
- 2026-08-28：**阶段 0.1 spike 完成，结论 GO ✅**（分支 `feat/cf-frontend-spike`）：
  - `opennextjs-cloudflare build` 零代码改动一次通过（@opennextjs/cloudflare 1.20.3 + Next 16.2.9）；`proxy.ts` 以 Node.js middleware 模式打包（OpenNext 标记 experimental，切换前多回归）。
  - bundle：19.3MB 原始 / **4.26MB gzip**（付费档 10MB 上限，余量充足）；.open-next 共 160MB、静态资产 2.4MB。
  - `wrangler dev` 冒烟：`/`(zh)、`/en`、`/en/blog`(SSG)、`/leaderboard`(force-dynamic)、`/llms.txt`、`/robots.txt`、`/api/badge/octocat`(经 ghfind.com 调 Go 后端) 全部 200 ✅。
  - 预期内失败：`/api/card/*`、`/api/og/home` 500——字体 fs 读取；**OpenNext 已把 woff 拷到 server assets（ENOENT 路径 `/server/assets/Inter-Regular.*.woff`），大概率是资产声明/读取方式的配置级修复而非代码重写**，阶段 1 首项。
  - `/u/octocat` 404 为本机冒烟触发后端 10/min 公共读限流（直连 API 得 429），非移植缺陷。
  - 环境注意：packageManager 从 pnpm@9.12.1 对齐到 11.24.0（node_modules 实际是 v11 store 装的，9/11 错配导致无法安装依赖）；wrangler compatibility_date 用 2026-08-06（本地 workerd 上限）。
- 2026-08-28：阶段 0.2 盘点完成大半（结果归档 `local-notes/cf-migration/`）：**无 Vercel cron**；WAF 5 条规则全量导出+CF 表达式草稿（含 08-09 scan/roast XHR 被 challenge 事故的修正）；Turso 实测 **852MB**、scores 26k 行；public_scan_* 半死（runs/pr_facts/owned_repo_facts 活、jobs/commit_*/worker_metrics 死于 07-21 可清）；**发现 schema 外的 papers/paper_roasts 两表**（别的实验共库，迁移前须确认归属）。剩余：Railway/三平台账单实数（dashboard 人工查）。
