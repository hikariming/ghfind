# Score v19：平滑饱和与生态深度/广度

仅 score v18→v19。roast 保持 v12，collection 保持 v7。
公开读顺序 v19→v18→v17→v16→v15→v14→v13→v10。
`ROAST_GENERATOR`、`ROAST_V13_SCOPE`、`ROAST_CACHE_VERSION` 与
`PROJECT_ANALYSIS_RECONCILE_CRON` 不在本次变更内。

## 问题

v18 用硬截断限制贡献质量与生态深度：

- 贡献质量取 `min(raw, 27, prestigeCap, recognitionCap)`，证据一过线就被砍平。
- 生态深度在 `impact_depth_raw / 8` 处直接顶满 11 分。
- 声望工作量在约 12 个已合并 PR 处顶满。给超高星仓库提几个小 PR，
  或把外部 PR 全部集中在一个仓库，仍可能接近生态满分。

## 公式

贡献质量保留 v18 的声望上限与采纳上限。`external_merged_pr_count` 缺失时
仍不把未知当成 0，采纳上限不进入合成。证据天花板用 softmin（k=6）合成；
分数用 softmin(raw, ceiling; k=3) 渐近天花板，不再硬砍。

生态影响力名义预算仍是声望 9 加深度 11：

- 实质：有分类样本时，按外部琐碎 PR、文档类影响 PR 与展示改动占比下调；
  三类证据都缺时保持 1。
- 广度：用 `impact_repos` 的 PR 份额算集中度（HHI 归一化），再映射到
  `0.62 + 0.38 · spread`；单仓约 0.62，多仓均匀趋近 1。主导仓长期工作会
  部分缓解集中惩罚。仅有 `impact_repo_count`、无仓明细时：单仓按集中、
  多仓暂不惩罚。完全缺仓库信息时不惩罚（不使用 `top_repo_pr_share`）。
- 触及：`1 − exp(−(PR + commit/4) / 18)`。有核心/文档分类时再按核心占比缩放。
  完全没有影响计数时保持 1，避免旧快照被当成零工作。
- 深度：`11 · (1 − exp(−impact_depth_raw / 4)) · substance · breadth`，
  不再除以 8 后截断。

采集把已有的 `impact_repos` 写入评分输入。不新增指标，缺字段保持中性。

## 合成画像

| 画像 | 期望 |
| --- | --- |
| 超高星仓几个小 PR | 生态明显低于 v18，远离 20 |
| 外部 PR 全部在一个仓 | 广度约 0.62，平滑压低 |
| 多仓持续核心贡献 | 广度与实质接近 1，仍可高分 |
| 低声望大批量 PR | 贡献维仍受证据天花板约束，过渡连续 |
| 外部采纳未测 | 与 v18 一样跳过采纳上限 |

## 发布与回滚

只开到 dev 的 PR，不合并、不部署、不回填、不改生产数据。
回滚时用正常 PR 同时还原公式、`SCORE_CACHE_VERSION`、Go 公开读顺序和本清单。
已写入的 v19 行保留原标签，不回写成 v18。
