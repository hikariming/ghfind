# 全库审查修复计划（2026-07-18 起，分 4 期）

> 依据：2026-07-18 五路并行只读审查（API 路由 ×26、页面/ISR/中间件、db.ts+redis.ts 全文、GitHub/LLM 链路、安全专项）。
> 核心约束（不可破坏）：**产品对 agent 是友好的——MCP + REST + Bearer key 是明渠，所有新增门禁只打匿名路径。**
>
> 落位规则：
> - BotID/Turnstile/配额一律加在 **route handler 的匿名分支**，不加在 `buildScanResult` 等共享层（MCP 走同一采集函数）。
> - 匿名与 Bearer 分开计数，Bearer 档位不设或极宽。
> - 所有 403/429 响应用 vs-verdict 同款 hint 文案，把迷路的正规 agent 导向文档化的 API/MCP。
> - `isVerifiedBot`（Googlebot 等）一律放行。

---

## 第 0 期：当天止血（全部一行级，可一个 commit 或拆小 commit）

| # | 问题 | 位置 | 修法 | 验证 |
|---|---|---|---|---|
| 0.1 | JSON-LD 存储型 XSS（GitHub 昵称自由文本 → `</script>` 逃逸，个人页+榜单页全访客中招） | `src/components/JsonLd.tsx:16` | `JSON.stringify(data).replace(/</g, "\\u003c")` | 构造含 `</script>` 的昵称数据，页面源码确认转义；`pnpm typecheck` |
| 0.2 | BotID 门禁可被 `byoKey: {}` 绕过（空对象 truthy → 跳过人机检查 → resolveConfig 回落 default 烧运营方 LLM） | `src/app/api/roast/route.ts:390` | 判断改为"resolveConfig 解析后是否 default"，default 必须过 BotID | 单测补充：`byoKey:{}` 且无 auth → 走 checkBotId 分支 |
| 0.3 | sitemap.xml 的 `revalidate=3600` 被 `force-dynamic` 压死，爬虫最高频入口每次全表读（已由 prerender-manifest 证实零缓存） | `src/app/sitemap.ts:13-14` | 删 `force-dynamic` | 构建后查 `.next/prerender-manifest.json` 出现 sitemap 条目；线上 `curl -sI …/sitemap.xml` 看 `x-vercel-cache` |
| 0.4 | leaderboard fetcher 失败把空数组写进 Redis 5 分钟（developers/rank 已有同款保护，唯独它漏） | `src/lib/leaderboard.ts:54-58` | `entries.length > 0` 才 `setCachedLeaderboard` | 单测：fetcher 抛错 → 不写缓存 |

风险：四项均为局部单行改动，无行为兼容面。**建议当天合当天发。**

---

## 第 1 期：本周（匿名路径门禁 + 最大出血点）

| # | 问题 | 位置 | 修法 | 验证 |
|---|---|---|---|---|
| 1.1 | 6 处限流取 `x-forwarded-for` 左起第一个，可伪造绕过全部 per-IP 闸门 | `api/scan:18-21`、`api/roast:96-98`、`api/vs-verdict:24-26`、`api/score:22-25`、`api/profile/backfill:31-34`、`mcp/route:31-36` | 抽共享 `clientIp()`：优先 `x-vercel-forwarded-for`，否则 XFF **最右** | **先线上实测**：`curl -H "X-Forwarded-For: 1.2.3.4"` 打一个限流端点两次，确认计数按真实 IP。改完再实测一次 |
| 1.2 | roast 缓存 miss 信任客户端 scan → 伪造分数进榜单/直方图，派生 javascript: href XSS 与 avatar 盲 SSRF | `api/roast/route.ts:425-426` | 删 `sanitizeScan(body.scan)` 回退：无服务端缓存 scan 时返回 409 引导先走 `/api/scan`；`recordScore` 入库前 name/url 白名单校验（`https://` + github/usercontent host） | 单测：无缓存 + body.scan → 409；web 前端正常流程（scan→roast）回归 |
| 1.3 | `/api/score/[username]` 冷路径零人机验证，每次冷扫 ≈210 GraphQL 点 + 14-127 REST；不存在用户无负缓存可无限打 | `api/score/[username]/route.ts:111-143` | miss 路径加 BotID（verified bot 放行，403 带 agent hint）；GitHub 404 写 `scan404:{user}` 负缓存 5-15min，scan/score/MCP 三处统一短路 | 单测覆盖 403 与负缓存命中；线上观察 GitHub quota 消耗曲线 |
| 1.4 | `POST /api/profile-comments` 匿名零门禁零限流 | `api/profile-comments/[username]/route.ts:43-92` | 匿名过 Turnstile（前端组件已有）+ per-IP 限流（依赖 1.1 先修） | 单测：无 token → 403；登录路径回归 |
| 1.5 | `getTrendingLeaderboard` SQL 无 LIMIT，缓存 miss 全表拉回内存 slice | `src/lib/db.ts:1249-1274` | SQL 按 `final_score DESC` 截候选池（如 LIMIT 5000）再内存算 trending | 榜单快照对比：top50 名单前后一致 |
| 1.6 | GraphQL 嵌套连接计费放大：两条查询吃掉单次 scan ~95% 预算（各 101 点/次） | `src/lib/github.ts:1692-1705`（closedPRs 100→50）；`:888-899`（recent PRs 拆：无 files 列表 1 点 + verified 子集补 files ≤12 点） | 每次 scan 省 ~140-180 点，吞吐近翻倍 | `pnpm test` github 相关；抽样账号对比 breakdown/verified 结果无明显回退 |
| 1.7 | `/api/profile/backfill` 无 BotID，页面 mount 自动触发，可 curl | `api/profile/backfill/route.ts:47` | 加 `checkBotId()`（vs-verdict 同款，verified 放行）；限流提到 DB 读之前 | 单测；profile 页正常访问回归 |

依赖关系：1.1 先行（1.4 的限流、1.3 的配额都依赖 IP 算准）。1.2 与 PR #101 的 H2 是同一根因，合并 #101 前这里先修。

---

## 第 2 期：下周（缓存与结构，一批小手术）

| # | 问题 | 位置 | 修法 |
|---|---|---|---|
| 2.1 | `getFacetRank` 未缓存 O(桶大小) 聚合挂在每个 profile 渲染 | `db.ts:1135-1163` | 按 facetValue 缓存桶聚合（total+分段计数）到 Redis 5-10min，内存算 rank（score-hist 同款模式） |
| 2.2 | `/api/search-users` 无限流 + `searchScoredUsers`/`searchRepos` 全表 LIKE（BINARY collation 不走索引） | `api/search-users/route.ts`、`db.ts:2111`、`:1789` | 改 `GLOB 'prefix*'` 走 PK；加 per-IP 限流；q 截断 40 字符 |
| 2.3 | vs-verdict 单飞锁 60s < LLM 100s 预算 → 重复生成；每次浏览 2 次 Turso 写无去重（verified bot 渲染也触发） | `redis.ts:444`、`api/vs-verdict/route.ts:97-98` | `VERDICT_LOCK_TTL_SECONDS ≥ 110`、等待对齐 ~95s；`bumpMatchupView` 加 heat 同款 Redis NX gate（24h/IP 去重） |
| 2.4 | card 系列 query 随机化 100% 击穿 CDN + 无限流 | `api/card/*` | CDN 忽略非白名单 query（只留 theme/variant/qr/lang）；加 per-IP 限流 |
| 2.5 | `account_lookup_limits` 无 retention，7 周窗口 GROUP BY 随刷量膨胀 | `db.ts:256-269` | 定时清理 `last_counted_at < now-8周`（Vercel cron 或顺手挂现有任务） |
| 2.6 | `/projects` language/page 无白名单：垃圾 language 每值一次全图聚合 + 6h 垃圾 Redis 键 | `projects/page.tsx:42-47`、`projects.ts:32-37` | language 走 `getFacetCategoriesCached` 白名单；缓存键去 offset（请求内 slice）；page 加上限 |
| 2.7 | roast 客户端断连后服务端继续烧完整份 LLM 流 | `api/roast/route.ts:542-711` | ReadableStream 加 `cancel()` 置标志，读取循环检查即 break；内容过半仍可落缓存 |
| 2.8 | prompt 里 recent_prs 全量带 files（重 PR 账号单次 roast 输入 2 万+ token） | `github.ts:895`、`prompt.ts:347-350` | collect 裁 files ≤20；prompt 的 recent_prs 去 files，只留 verified_impact_prs |
| 2.9 | org 归属证据链单 scan 最多 ~112 次 REST，产物无人消费 | `github.ts:723-866` | 砍 per-SHA commit 查询与 maintainer 文件探测；要留证据只对最终 top-3 做 |
| 2.10 | `[locale]` 缺 `dynamicParams=false`，垃圾首段 URL 每个整树渲染 404 | `[locale]/layout.tsx` | 一行加上；**上线前实测** facet 桶 ISR、`/u`、`/vs` 按需生成不受影响 |

---

## 第 3 期：排期（结构性 + housekeeping 打包）

- **`/u/[username]` 转 ISR**（最大结构收益、工作量最大）：`?roasting=1`/`?ref` 改客户端 `useSearchParams`；comments 改 mount 拉 API；`isOwner` 用 `fetchMe()`；roast/backfill 写完 `revalidatePath`。注意 `LiveRoast.refreshOnce()` 目前依赖 force-dynamic，ISR 下必须靠按需 revalidate。
- **`/vs/[a]/[b]` ISR 候选**：不读 searchParams/headers，可 `revalidate + generateStaticParams()=>[]`；`!da && !db` 改 `notFound()`（需产品确认，会失去"召唤未测用户"入口）；`VsVerdictLive` 的 refresh 靠 verdict API 里 `revalidatePath` 补偿。
- **`/vs` 索引页**：`getTrendingMatchups` 加 Redis 缓存 + 部分索引 `ON vs_matchups(view_count DESC) WHERE verdict_source='llm'`。
- **housekeeping 打包**：timingSafeEqual（machine-auth + admin×3）；`.env.example` 补 `GITHUB_ROAST_CLI_API_KEY` 等；Turnstile 生产 fail-closed；CSP/安全响应头；`decodeURIComponent` 包 try；roast username typeof 检查；`restGet` 区分故障与确定性空；coalesceScan/roast leader 失败防踩踏；Redis 轮询指数退避；`getCachedRoastJudge` 死代码；`JSON.stringify(…,null,2)` 改紧凑；`score_snapshots` retention；`hideUser` 顺手清榜单缓存；写路径 batch 合并（recordScore/updateRoast/setFollow/ensureSchema）；`/api/stats` 加 `s-maxage=60`；LLM markdown 外链图片按白名单渲染。

---

## 每期 Definition of Done

1. `pnpm typecheck` + 定向 `eslint` + `pnpm test` 全绿（全仓 `pnpm lint` 被 scripts/ 既有问题阻断，与本期无关）。
2. 涉及门禁的：单测覆盖"匿名被挡 / verified bot 放行 / Bearer 直通"三态。
3. 上线后复核：`scripts/traffic-report.sh` 三层拆分无异常漂移；Turso rows_read、GitHub quota、Vercel 调用数按预期下降；403 响应带 agent hint 文案抽查。
4. 前端改动按 AGENTS.md 过 light/dark 双主题（本期多为后端，涉及前端时再查）。

## 明确不动

- MCP 工具集、agent REST 文档、Bearer 认证路径、verified bot 放行逻辑。
- `/api/scan` 的现有 Turnstile 顺序、`/api/roast` 的锁 TTL 270s（已修好的对照组）。
