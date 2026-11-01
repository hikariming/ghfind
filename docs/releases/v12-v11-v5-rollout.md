# v12 / v11 / v5：恢复旧风险扣分，保留新人奖励

## 范围

Node 从 v11/v11/v5 升至 v12/v11/v5；Go 仅 score 从 v11 升至 v12，
保留自身 collection v4。report/roast v11 不变，但缓存键包含 score 版本。
仅恢复 `21e2f504^` 的旧扣分（总封顶 40）。六维正向评分和 v11 新人奖励保持；
v10 风险评估仅用于既有新人奖励资格。公开结构化风险标记 policy v9，不能冒称 v10。
见 [算法 RFC](../rfc/2026-10-15-account-scoring.md)。

## 发布

1. 验证 TS、Go、Python 的旧规则/边界/封顶和新人奖励回归；运行 typecheck、lint、版本门禁。
2. 以真实快照先比较 v11/v12，尤其检查年轻账号、无原创项目和未知拒绝类型。
3. 一起部署公式、Node/Go score 常量、release manifest 和重建的 SDK。
   正常读取/报告重放只接收 v12，旧 v11 不能改标签充当新分数。
4. 历史快照按 [canonical-score-backfill](../operations/canonical-score-backfill.md)
   先 dry-run，再受控物化；默认不启用 apply。本次代码修改不操作生产数据或触发批量扫描。
5. 验证 API、主页完整分解、榜单物化及缓存；特别检查扣分 >25 和达到 40 的明细。
   旧 red_flags 为原始分，合计可能超过 total_penalty；不要按旗标之和重复扣分。
6. 紧急只读回退使用原 v11/v11/v5 元组，不放进正常兼容列表。

## 撤销本次回退

将公式、两端 score 常量及 manifest 一起恢复至前一版本；保留 v12 历史产物。
若已物化 v12，先按受控流程从快照恢复 v11 分数/榜单，不能只切版本常量。
