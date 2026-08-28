# 全面迁移 Cloudflare 分析：Railway + Turso + Vercel 下线

> 2026-08-28。基于对当前 main 分支的全量代码摸底（前端 Vercel 面 / Railway Go 后端 / Turso 数据层三路并行审计）。
> 前提约束：**项目分析继续用 Mosoo**（try.mosoo.ai 外部 API，不迁移）；LLM 供应商（StepFun/DeepSeek）不变；`ghfind` CLI 不变（只走 HTTP）。

---

## 一、现状盘点

### Vercel（前端，Pro $20/月 + 用量）
- Next.js 16.2.9 App Router，20 个页面 × 9 locale，45 个 route handler，其中 **19 个是 fail-closed 503 桩**（真实现在 Go），Next 真正执行的只有 13 条：5 条 OG/卡片图（Satori）、2 条手写 SVG（badge/mini card）、project-analyses 透传、vs-verdict BotID 网关等。
- **对 OpenNext 极其友好的部分**：没有 vercel.json、没有 cron、没有 Edge runtime、**全站没用 next/image**、没有 revalidateTag/unstable_cache（只有纯时间型 ISR）、next-auth 是死代码（真 OAuth 在 Go）。
- **Vercel 独有依赖**：BotID（仅护 `/api/vs-verdict` 一条路由，3 个文件）；`@vercel/analytics`（28 个自定义事件，`src/lib/track.ts` 收口）；`VERCEL_ENV` 三处运行时读取（其中 `redis.ts` 决定限流是否 fail-closed，**漏改会静默失守**）；`x-vercel-forwarded-for`；dashboard 里的 WAF 规则（28 ASN challenge + bypass 规则 + Bot Protection Log 模式）。
- **Workers 硬伤点**：运行时 `node:fs` 读文件——卡片字体（`src/app/api/card/shared.ts`）、tier emoji/sponsor SVG、`content/` 博客与合集（sitemap/llms.txt 在 ISR 再生时也读盘）。Workers 无文件系统，必须改成内联 import / 静态资源 fetch / R2。

### Railway（Go 后端，3 个服务）
- `ghfind-api`（52 条路由）+ `ghfind-worker`（3 个 AMQP 消费循环）+ **私有 RabbitMQ（带持久卷）**。非测试 Go 约 1.9 万行，测试 7,794 行。
- 路由构成：16 条可缓存公共读、13 条社交 CRUD、OAuth 4 条（HMAC 签名 cookie，无状态）、MCP 1 条（无状态 Streamable HTTP）、内部/admin 6 条，以及**难点五件套**：`/api/scan` 等 3 条 55s 长轮询（250ms 轮询 Upstash）、campaign SSE（内存 fan-out hub）、roast 220s LLM 流式。
- 队列：RabbitMQ 9 队列（main/retry/dead × 3 种任务），重试用消息 TTL + DLX 手搓延迟队列（`jobs.go` 352 行）。**project-analysis worker 持有未 ack 投递轮询 Mosoo 最长 15 分钟**——最难迁的一块。
- **没有任何容器硬依赖**：无文件系统、无子进程、无原生库、无长连 TCP（除 AMQP 本身）。且大量 Go 代码是 `src/lib/` 现存 TypeScript 的逐行移植（mosoo.go、project-analysis、roast/verdict/ratelimit 路径），**反向移植回 TS 有现成蓝本**，7.8k 行 Go 测试就是对齐合同。

### Turso（libsql，两个写入方共用一库）
- 31 张表，无 migrations 目录，**DDL 全在 `db.ts ensureSchema()`（62 条语句，每个冷启动 lambda 跑一次）**；Go 侧被 `schema_boundary_test.go` 强制禁止 DDL。
- 方言干净：无 FTS5/触发器/视图/PRAGMA/ATTACH/扩展，仅 `json_each` 一处 + 部分索引——**D1 全兼容**。
- 数据量：热表几万行级（profile_snapshots 7.5k、developer_facets 25k @07-11），远小于 D1 单库 10GB 上限（大 TEXT 字段迁移前实测一下）。
- **D1 真正的阻碍：交互式事务 29 处**（db.ts 19 + project-analysis-db.ts 4 + Go 6），全是"读→分支→写"模式，D1 没有交互式事务，须改写成带 WHERE 守卫的条件 UPDATE + RowsAffected 断言（`project_analysis_db.go:757` 已有模板），或把 scan 租约状态机挪进 Durable Object。
- 遗留热查询（迁 D1 前顺手处理，否则 rows_read 雷带过去）：trending 榜**无 LIMIT** 全表取回 + `account_lookup_limits` GROUP BY 全量子查询；`searchRepos` 的 `lower() LIKE` 无索引扫描；全图 discovery CTE 仅靠 6h 缓存兜底。
- 疑点：`public_scan_*` 12 张表——运营记忆认定为死表可清，但代码仍有 4–32 处非测试引用。**迁移前先确认是否还在写入，是的话这是砍表窗口。**

### Upstash Redis
- 13 个滑动窗口限流器 + 分布式锁/单飞（roast 270s 锁、scan coalesce SET NX + 500ms×120 轮询）+ 十几类 TTL 缓存。原语只有 get/set(nx,ex)/del/expire/EVAL，无 ZSET/stream/pubsub——缓存部分机械可迁，**锁与限流需要原子性，必须 DO（KV 不行）**。

### 账单基线（估计区间，需 dashboard 核对）
| 项 | 月成本（估） | 依据 |
|---|---|---|
| Vercel Pro + 用量 | **$40–75** | 07-17 用量节奏 ~$75/月；08 月治理（WAF bypass、bingbot 限速、关 Obs Plus）后周期头两天 $3.7 ≈ $55/月节奏，含 $20 底座 |
| Railway ×3 服务 | **$10–25** | 3 个轻量常驻服务 + RabbitMQ 卷 |
| Turso | **$5–25** | Developer $4.99 或 Scaler $24.92 档 |
| Upstash | **$0–10** | 按量 |
| **合计** | **≈ $55–135/月** | 中位 ~$85/月 |

结构性问题：账单六大项同根同源＝**给爬虫渲染页面**（24.4 万请求/天中 ≥13 万是 bot）。Vercel 的计费模型下这类流量按函数调用/ISR 写/传输全额计费，只能靠 WAF 规则一场一场打；这是迁移最大的战略动机，不只是省绝对值。

---

## 二、目标架构（Cloudflare 映射）

| 现在 | 迁移后 | 说明 |
|---|---|---|
| Vercel Next.js | **Workers + @opennextjs/cloudflare**，静态资产免费直出，ISR 用 R2 增量缓存 + KV | 无 next/image、无按需 revalidate，适配面出奇地小 |
| Railway ghfind-api（52 路由） | **单个 API Worker（TS）**，与前端 Worker 走 Service Binding | 同源化后删除 verdict HMAC 网关、`GHFIND_TRUST_VERCEL_HEADERS` 整套跨源信任装置 |
| RabbitMQ 9 队列 + jobs.go 352 行 | **Cloudflare Queues ×3 + DLQ**（原生 delaySeconds/max_retries/DLQ） | 净删代码；少一个有状态 broker 和持久卷 |
| score_snapshot / scan 消费者 | Queue consumer Worker | 每次 scan ~21s 全是 I/O 等待，预算内 |
| project-analysis 15 分钟 Mosoo 轮询 | **Cloudflare Workflows**（step.sleep(5s)，睡眠不计费） | 顺带删掉手工 redrive/parking 逻辑；Mosoo API 原样调用 |
| campaign SSE 内存 hub | **Durable Object**（每 campaign 一个，alarm 驱动轮询，可休眠连接） | |
| 55s 长轮询（250ms 打 Upstash） | DO 通知模式：consumer 完成即唤醒等待请求 | 顺带消灭每请求 220 次 Redis 轮询的成本 |
| Turso | **D1**（付费档含 25B rows read/月，超出 $0.001/百万行） | 29 处事务改写后迁入；schema 抽成 wrangler migrations |
| Upstash 缓存 | KV / Cache API | 机械替换 |
| Upstash 锁/限流 | Durable Objects | 原子性要求 |
| BotID | **Turnstile**（免费；9 语言文案 key 已存在） | 只涉及 vs-verdict 一条路由 |
| Vercel WAF（28 ASN challenge 等） | CF WAF 自定义规则（免费档 5 条够用，ASN 列表写进一条表达式）+ Bot Fight Mode | **被 challenge/缓存命中的请求不产生 Workers 调用**，爬虫成本归零是结构性的 |
| Vercel Analytics（28 事件） | 最省事：`track.ts` 传输层切 GA4（已装）；或 Workers Analytics Engine | 页面级用 CF Web Analytics（免费） |
| deploy-gate.mjs（Vercel API 部分 ~40%） | wrangler deploy + versions 回滚 | Railway 段整体删除 |
| /metrics 内存计数器 | Workers Analytics Engine / Logs | |
| 删除项 | RabbitMQ 服务+卷、`ghfind-backend` 角色分发器、`ghfind-healthcheck`、`jobs.go`、verdict HMAC、next-auth 依赖、`@vercel/*` 依赖 | |

---

## 三、分阶段路线（可独立回滚，每阶段结束都是稳定态）

### 阶段 0 — 摸底与准备（1–2 天）
- 三个 dashboard 导出真实账单数；**检查 Vercel dashboard 有无未入库的 cron**（代码里 CRON_SECRET 有消费者但 repo 内无 schedule）；导出 WAF 规则清单和全部 env。
- 实测 Turso 库体积与各表行数；确认 `public_scan_*` 是否死表（是则先 DROP，少迁 12 张表）。
- 起一个 OpenNext spike：`@opennextjs/cloudflare` 打包现有 app，验证 Next 16.2 + `proxy.ts` 文件名兼容性、worker 压缩后体积（付费档上限 10MB gzip；messages 516KB + Recharts/Satori 需实测）。**这一步是整个计划最大的技术不确定性，1 天内可证实/证伪。**
- DNS：ghfind.com（及 3 个 308 旧域名）准备迁 Cloudflare 接管。

### 阶段 1 — 前端下 Vercel（约 5–8 人日，日历 1–1.5 周）
后端仍留 Railway（`GHFIND_BACKEND_ORIGIN` 不变），单独把 Next 迁上 Workers：
1. OpenNext 适配 + R2/KV 增量缓存绑定；28 条 beforeFiles rewrite 原样保留。
2. 消灭运行时 fs：卡片字体改内联 import、tier/sponsor SVG 内联、`content/` 博客与合集改构建期打包或静态资源 fetch（sitemap/llms.txt 的 ISR 再生路径要一起改）。
3. BotID → Turnstile（layout.tsx、vs-verdict/route.ts、machine-auth 3 处）；`x-vercel-forwarded-for` → `CF-Connecting-IP`。
4. `VERCEL_ENV` 三处改自定义 env（**redis.ts fail-closed 语义必须保住**）；site.ts 生产校验同理。
5. Analytics：track.ts 传输层切 GA4，`@vercel/analytics`、`@vercel/speed-insights` 依赖删除。
6. WAF 平移：ASN challenge 列表 + machine-endpoint bypass + lightpanda deny 在 CF 重建（表达能力更强，免费）。
7. deploy-gate 改 wrangler（Vercel 段改写，Railway 段暂留）；smoke:deployment 原样复用作验收。
8. DNS 切换 + 观察 48h → **注销 Vercel Pro**。
- 回滚：DNS 切回即回滚，Vercel 项目保留只读一个计费周期。

### 阶段 2 — Go 后端下 Railway（约 15–25 人日，日历 3–5 周，大头）
利用现有"fail-closed 桩 + rewrite allowlist"架构**逐路由切流**，Railway 全程在线兜底：
1. 脚手架：API Worker + Queues ×3 + 消费者 Worker + Workflows；Turso（`@libsql/client/web`）与 Upstash REST **原样连接，不动数据层**。
2. 切流顺序（先易后难）：
   - 第 1 批：MCP、OAuth/session、16 条公共读（全无状态）；
   - 第 2 批：13 条社交 CRUD、admin/internal、badge embed；
   - 第 3 批：scan 管线（Queues + DO 完成通知替代 55s 轮询）、score/profile live；
   - 第 4 批：roast LLM 流（Workers TransformStream，流式响应无墙钟上限）、vs-verdict（同源化后删 HMAC 网关）、campaign SSE（DO）；
   - 第 5 批：project-analysis → Workflows（Mosoo 客户端直接用 `src/lib/mosoo-project-analysis.ts`——它本来就是 Go 版的 source of truth）。
3. 测试对齐：把 Go 测试中的合同性用例（scan 持久化分支、限流窗口、schema 边界）移植成 vitest；每批切流跑 smoke。
4. 全量切完观察一周 → **注销 Railway 3 个服务**。
- 回滚：任一路由把 rewrite 指回 Railway origin 即回。
- 工作量依据：52 条路由里 30–40% 有现成 TS 蓝本（mosoo/project-analysis/roast/verdict/ratelimit）；纯新写的是 Queues/DO/Workflows 胶水和 SSE hub。

### 阶段 3 — 数据层下 Turso + Upstash（约 5–10 人日，日历 1–2 周）
此时只剩一个运行时（TS Worker），改写事务不再需要双语言同步：
1. `ensureSchema` 62 条语句抽成 `wrangler d1 migrations`（顺带建起 repo 一直缺的 migrations 目录）；运行时 DDL 机制整体删除。
2. 事务改写：23 处 TS 交互式事务 → 守卫式条件 UPDATE（模板已有）；scan 租约状态机若改写吃力就上 DO。
3. 顺手排雷（否则把 Turso 的 rows_read 雷带进 D1 计费）：trending 榜加 LIMIT/预聚合、`account_lookup_limits` 加清理任务（本来就只增不减）、`searchRepos` 建表达式索引或去 `lower()`。
4. 数据迁移：Turso dump → `wrangler d1 import`；低峰期停写窗口 <1h（数据量几万行级）。
5. Upstash：缓存 → KV/Cache API；锁/限流 → DO（13 个限流器收敛成一个 DO 类 + 配置表）。
6. 观察一周 → **注销 Turso、Upstash**。
- 注意：**先不开 D1 读副本**——scan 管线依赖写后读，副本需要 Sessions bookmark 贯通，不值得在迁移期引入。

---

## 四、工作量汇总

| 阶段 | 人日（单人 + AI 辅助） | 日历 | 下线对象 |
|---|---|---|---|
| 0 摸底 | 1–2 | 2 天 | — |
| 1 前端 | 5–8 | 1–1.5 周 | **Vercel** |
| 2 后端 | 15–25 | 3–5 周 | **Railway** |
| 3 数据 | 5–10 | 1–2 周 | **Turso + Upstash** |
| **合计** | **26–45 人日** | **全职 6–9 周；业余节奏 2.5–4 个月** | |

阶段 1 性价比最高（1 周省掉最大一张账单）；阶段 2 是工程大头但有 TS 蓝本和逐路由回滚兜底；阶段 3 最精细（事务语义），放最后做时风险已收敛到单运行时。

---

## 五、成本测算

### 迁移后月账单
| 项 | 金额 | 说明 |
|---|---|---|
| Workers Paid | **$5** | 含 10M 请求 + 30M CPU-ms；当前全站 ~7.3M 请求/月（含 bot）在额度内；**静态资产请求免费、WAF challenge 掉的请求免费、CDN 缓存命中免费** |
| D1 | **~$0** | 含 25B rows read/月（正常用量的百倍余量）+ 50M 写 + 5GB；超出 $0.001/百万读 |
| Queues / DO / KV / R2 / Workflows | **$0–3** | scan 千级/天、DO 请求百万级内、R2 增量缓存几分钱 |
| Turnstile / WAF / Web Analytics / Cron | $0 | 免费 |
| **合计** | **≈ $5–10/月** | |

### 节约
| | 现在 | 迁移后 | 月省 | 年省 |
|---|---|---|---|---|
| 保守（现账单低估） | $55 | $10 | $45 | **$540** |
| 中位 | $85 | $8 | $77 | **~$930** |
| 高位（回到 7 月用量节奏） | $135 | $10 | $125 | **$1,500** |

**省 85–93%。** 但比绝对值更重要的是两个结构性收益：
1. **爬虫成本模型反转**：现在 bot 流量按调用/ISR 写/传输全额计费，治理是持续消耗战（7-8 月记忆里十几次账单救火）；迁移后被 challenge/缓存/静态命中的请求全部免费，Bot 成本从"账单主因"变成"非问题"，把治理时间也省了。
2. **架构减法**：RabbitMQ（有状态 broker + 卷）、跨源信任装置（HMAC 网关/TrustVercelHeaders）、运行时 DDL、手搓重试拓扑、双语言双写数据层——全部消失。长期维护面显著变小，这对"评分引擎卖 B 端"的方向是可靠性资产。

回本角度：26–45 人日换每年 ~$550–1,500 + 消灭账单救火类工作。纯按钱算回本周期长，**真正的理由是成本结构（bot 免疫）+ 运维减法**，如果只想省钱，最小动作是只做阶段 1（8 人日省掉六成账单）。

---

## 六、主要风险与未知

1. **OpenNext × Next 16.2 成熟度**（`proxy.ts` 文件名、ISR 语义、bundle 体积）——阶段 0 spike 一天内验证，是 go/no-go 门。
2. **D1 无交互式事务**：29 处改写是全计划最精细的活，scan 租约状态机是重灾区；改写错误的表现是并发下重复扣配额/丢任务。缓解：Go 测试合同移植 + 灰度期双写校验。
3. **D1 单库写串行化**：两写入方并发写 scores 目前无 BUSY 重试；阶段 3 时已收敛为单 Worker，需在 db 层加统一重试。
4. **限流语义平移**：Upstash Lua 滑动窗口 → DO 重实现，量化验证窗口边界行为（Go 侧为兼容手搓过同款脚本，说明语义敏感）。
5. **观测性断档**：Vercel Observability/Analytics 没了，Workers Logs + Analytics Engine + GA4 要在阶段 1 就位，否则迁移期变盲飞。
6. **Dashboard 暗配置**：Vercel cron（如有）、WAF 全量规则、env——只存在于 dashboard，迁移前必须导出清点。
7. **长尾兼容**：`timingSafeEqual` 等 node:crypto 边角在 nodejs_compat 下需 smoke；roast 220s 流式在 Workers 是流式响应不受墙钟限制，但 CPU limit 要配到高档。

## 七、明确不动的部分
- **Mosoo**（try.mosoo.ai）：Workflows 里原样调用，`src/lib/mosoo-project-analysis.ts` 直接复用。
- LLM 供应商（StepFun 主 / DeepSeek 备）、GitHub PAT 池逻辑（atomic 轮转退化为 per-isolate 随机，可接受）。
- `ghfind` CLI 与 `internal/agentcli`（纯 HTTP 客户端，仅发布产物，不部署）。
- 9-locale i18n 结构、content/ 内容本身、评分引擎逻辑。
