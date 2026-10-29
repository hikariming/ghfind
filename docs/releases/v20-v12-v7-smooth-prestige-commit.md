# Score v20：平滑声望天花板与大仓 commit 权重

仅 score v19→v20。roast 保持 v12，collection 保持 v7。
公开读顺序 v20→v19→v18→v17→v16→v15→v14→v13→v10。
`ROAST_GENERATOR` / durable roast 路径不在本次变更内（#611 已单独合入 main）。

## 问题

v18/v19 贡献质量路径仍有硬拐点：

- `prestigeCap` 以 20 为底，再用 smoothstep 在 prestige 0.3 / 0.65 处抬升，
  高量时 `cap = prestigeCap`，低声望大批量贡献被一刀切到约 20–22。
- 证据合成用 softmin(k=6)，接近硬 `min()`。
- `IMPACT_COMMIT_MIN = 2`：对大仓只交 1 个 default-branch commit 的仓直接不计分。

另：Jah-yee 一类用户 `impact_commit_count` 74→0、230k★ 仓 4 commits 归零，
不是上述评分门槛造成的（4≥2 本可通过）。对比 v9 与现行快照，commit-only
impact 仓从 contrib map 消失、现存 impact_repos 的 commits 全为 0，且
`commit_contribution_aggregation_unavailable=false`——判定为 **collection /
attribution 回归**（采集侧不再浮出那些 commit 贡献），不是评分规则一刀切。
本 PR 只改评分；采集修复另开。

## 公式（v20）

贡献质量证据天花板：

```
prestigeLift = 1 / (1 + exp(−(prestige − 0.58) / 0.13))
coreLift     = 1 − exp(−core_impact_pr_count / 90)
shaped       = 18 + 9 · min(1, prestigeLift + 0.12·coreLift·(1 − prestigeLift))
volumePull   = 1 − exp(−max(0, merged−40) / 90)
ceiling      = 27 − volumePull · (27 − shaped)
# external 已知时：稀薄采纳把天花板向 base=18 轻拖，不是第二道硬地板
recognitionLift = 1 − exp(−landings / 100)
ceiling     -= (1 − recognitionLift) · max(0, ceiling−18)

ceiling      = softmin([27, ceiling], k=2)
CQ           = saturateToward(raw, ceiling)   # softmin(raw, ceiling; k=3)
```

无绑定 `min()`，无 floor-20 prestigeCap，无 volume smoothstep 拐点。

大仓 commit：

- `IMPACT_COMMIT_MIN = 1`（git/git 特例并入同一门槛）。
- 进入后仍由 `prestigeWorkMultiplier` 的凹 log 曲线按 commit/PR 量缩放，
  几个小 commit 到超高星仓只能拿很小权重，不能顶满生态。

## 合成画像

| 画像 | 期望 |
| --- | --- |
| 低声望大批量 PR | 贡献维随声望指数抬升，过渡连续；不再死卡 ~20 |
| 几个小 commit / 小 PR 到超高星仓 | 仍明显低于满分（+1 内） |
| 单仓集中 | v19 广度惩罚保留 |
| 合法高声望/多仓核心 | 回收部分 v18 CQ 损失 |
| 相对 v17 新异常抬升 | 不超过 +5 |

## 发布与回滚

只开到 main 的 PR，不合并、不部署、不回填、不改生产数据。
回滚时用正常 PR 同时还原公式、`SCORE_CACHE_VERSION`、Go 公开读顺序和本清单。
已写入的 v20 行保留原标签，不回写成 v19。
