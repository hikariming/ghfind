# v13 / v12 / v5：自有仓社区贡献加分

仅升级 score v10 → v13。Roast 仍为 v12，Node collection 仍为 v5，Go collection 仍为 v4。
这是一次正式计分前进：在 AsperforMias 的 v10 六维正向分 + 结构化 25 分风险之上，接回
hikariming `209ff9f5` 里**只针对自有仓**的社区贡献加分。不恢复 v11 新人成熟度，也不恢复
v12（`4f3c8ef8`）的 pre-v10 平面扣分。

公式变了，不能复用 v10 标签。v11/v12 行曾写过不同公式，公开读它们会把旧产物当成新分，
因此 `skippedScoreVersions` 为 `["v11","v12"]`，新标签为 v13。

## 变更

- TypeScript `src/lib/score.ts`、Go `internal/backend/scoring.go`、Python
  `packages/ghfind-py/ghfind/_score.py` 在 v10 的 16 点合并 PR 池上增加
  `6·A·logRatio(own, 200)`（A = `own_pr_community`，own = merged − external）。
  没有 `external_merged_pr_count` 的旧快照加分为 0，分数与 v10 相同。
  209ff9f5 里 own volume 是 `(4 + 6·A)·logRatio(own, 200)` 上限 10；v10 已把 own PR
  算进 16 点池（那 4 分），v13 只接回 4→10 的社区抬升，避免拆池导致只加不减被打破。
- 采集层 v5 已输出 `own_pr_community`、`impact_prestige_score`、`impact_depth_raw`，
  自有仓 / 已认定组织原创仓的 ecosystem prestige/depth 加成仍在
  `computeImpactFromContribMap`，评分侧无需再改 ecosystem 公式。
- `SCORE_CACHE_VERSION` 与 `goCanonicalScoreVersion` 为 `v13`。
- `publicScoreReadOrder` 为 `["v13","v10"]`：新写入 v13；已有 v10 行在重算前仍可公开读。
  `scores` 表每人一行，IN (v13, v10) 不会双计。
- 紧急 `legacyReadFallback` 仍为 v10/v12/v5。活着的 v10 `scores` 行是公开读，不是
  紧急回退；紧急副本只来自 `score_release_fallbacks`。
- Roast 仍为 v12。正常重放要求 v13+v12。Redis roast 键变为 `v12:v13:v5`
  （Go Feed 为 `v12:v13:v4`）。scan 缓存键仍是 `scan:v5`；读时用当前公式重算。

## 发布与缓存

1. 同步部署 Node/Go/Python 计分、`SCORE_CACHE_VERSION` 和本 manifest。
2. 不改 GitHub 采集口径，不做全站批量扫描或批量模型调用。已有 v10 缓存行立即仍可读。
3. 首页 `/api/scan` 对 Redis / D1 快照按现行公式重算，不在读路径写回 v13。
   `/api/score` 在重算前继续返回已存 v10 行（`stale: false`，避免 GitHub 回源）。
   要让某账号的 `scores` 行变成 v13，走现有 organic / `?force=1` 扫描即可。
4. 排名在有机重算完成前会短暂混合略高的 v13 与遗留 v10，这是预期的。

## 验证

- 合成 fixture 与 TS/Go/Python 三端对拍；impact-regression 中 hikariming / louislam
  只加不减（CQ 顶到 27），A=0 或已封顶的账号不变。
- 本地用 samzong、hikariming、torvalds、yyx990803 的真实 metrics 对比新旧分。
- 首页 `/api/scan`、`/api/score/{username}`：已有 v10 行可命中；force 扫描后
  `score_version=v13`，分数合理，无新增 5xx。
- 确认 roast 仍为 v12，collection 仍为 v5。

## 回滚

同时恢复计分实现、`SCORE_CACHE_VERSION`、Go canonical 常量和本 manifest，再部署。
公开读序回到只读 v10。保留新旧评分产物；无需删数据。Roast 与 collection 版本保持不动。
不需要回填。
