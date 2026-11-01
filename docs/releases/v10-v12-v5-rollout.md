# v10 / v12 / v5：评分回退到 v10 风险层

仅升级 score v12 → v10。Roast 仍为 v12，Node collection 仍为 v5，Go collection 仍为 v4。
这是一次正式计分回退：公开读写重新使用 AsperforMias 在 `21e2f504` 落地的 v10 公式
（六维正向分 + 结构化风险扣分），不再把 hikariming 的 v12 平面扣分和新手奖励当作
canonical。新产物写入 `score_version=v10`；已有 v10 行可直接公开读取。

## 变更

- TypeScript `src/lib/score.ts`、Go `internal/backend/scoring.go`、Python
  `packages/ghfind-py/ghfind/_score.py` 回到 v10 计分。
- `SCORE_CACHE_VERSION` 与 `goCanonicalScoreVersion` 为 `v10`。
- 公开读序只服务 v10。v12/v12/v5 仅作为只读紧急回退，不进入排名或正常重放。
- 采集器、超时保护（45s collect deadline、锁 TTL、abort、`scan_busy`）和 roast v12
  提示词均保持不变。

## 发布与缓存

1. 同步部署 Node/Go 计分、`SCORE_CACHE_VERSION` 和 manifest。正常公开评分只接受 v10。
2. 不改 GitHub 采集口径，不做全站批量扫描或批量模型调用。已有 v10 缓存行立即重新可读。
3. 旧 v12/v11 行保留；首页 miss 时按现有 live-scan 路径重算为 v10。紧急路径可展示
   明确标记的 v12 历史分。
4. Redis roast 键变为 `v12:v10:v5`（Go Feed 为 `v12:v10:v4`）。旧 v12/v12 报告不满足
   正常重放。

## 验证

- 合成 fixture 与 TS/Go/Python 三端对拍。
- 首页 `/api/scan`、`/api/score/{username}`：已有 v10 行应命中缓存；冷扫描仍受 45s
  collect deadline 约束。
- 确认 roast 仍为 v12，collection 仍为 v5。

## 回滚

同时恢复计分实现、`SCORE_CACHE_VERSION`、Go canonical 常量和本 manifest，再部署。
保留新旧评分产物；无需删数据。Roast 与 collection 版本保持不动。
