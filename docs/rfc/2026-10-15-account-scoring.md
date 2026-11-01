# RFC：账号评分算法、v10 风险层与局部回退

- 状态：待讨论；v10 风险扣分退出实际总分，新人奖励保留。
- 日期：2026-10-15。
- 记录基线：`daa796da`，评分 v11 / 报告 v11 / 采集 v5。
- 关联提交：AsperforMias 的 `21e2f5042323562991e4568093c88ebfbc6ca54c`
  （2026-09-06，`feat: add v10 risk fallback and CF release guard (#236)`）。
- 本次决定：仅恢复该提交之前的平面扣分规则，保留后续六维评分、新人奖励、
  数据结构、API、存储和发布保护。新产物使用 score v12，不能重新使用 v9/v11 标签。

## 1. 目标与范围

评分是公开 GitHub 快照上的确定性 0–100 分数。它描述公开项目、贡献和活动，
不等于真实能力、人格、职业水平或作弊的事实认定。LLM 只负责报告文字，不改分。
相同快照必须得到相同结果；算法不读取当前时间，不推测未采集的历史。

本 RFC 记录回退前的完整现行算法，明确保留和回退的部分，并保留 v10 风险层
作为后续讨论方案。此次不是整笔 revert：原提交还涉及 76 个文件中的发布门禁、
数据库列、读回退、API 和展示，整体撤销会覆盖后续工作。

实现索引（相对仓库根目录）：

- TypeScript：`src/lib/score.ts`、`src/lib/risk.ts`、`src/lib/legacy-risk.ts`。
- Go：`internal/backend/scoring.go`、`risk.go`、`legacy_risk.go`。
- Python：`packages/ghfind-py/ghfind/_score.py`、`_risk.py`、`_legacy_risk.py`。
- 风险参数：`config/risk-rules-v10.json`；档位：`src/lib/score-presentation.ts`。
- 新人奖励细节：[super-newcomer.md](../scoring/super-newcomer.md)。

## 2. 公共算子与舍入

令 `L(x, t) = min(log10(x + 1) / log10(t + 1), 1)`，`x <= 0` 时为 0；
`C(x) = clamp(x, 0, 1)`，`R_d(x)` 为保留 d 位的 half-even 舍入。
六个子分保留一位，总基础分保留一位，最终分限制在 [0, 100] 并保留两位。
历史 Python 基线使用内置 round；新人奖励路径使用与 TS/Go 一致的半值容差。

## 3. 六个正向维度（此次保留）

| 维度 | 上限 | 基础公式 |
| --- | ---: | --- |
| 账号成熟度 | 10 | `7 * min(age / 6, 1) + span + newcomer_bonus` |
| 原创项目质量 | 18 | 星标部分最多 12，加项目实质质量最多 6 |
| 贡献质量 | 27 | PR 量最多 16、接受度最多 6、Issue 最多 5，加核心贡献奖励后封顶 |
| 生态与维护影响 | 20 | prestige 最多 9，depth 最多 11，受质量上限约束 |
| 社区影响 | 8 | 粉丝最多 5，关注比最多 3 |
| 活动真实性 | 17 | 去年贡献最多 8，最近活动最多 4.5，活动类型最多 4.5 |

### 成熟度

`span` 按活跃日历年数 0 / 1 / 2 / 3+ 取 0 / 1 / 2 / 3。
新人奖励在原始成熟度上相加，然后封顶 10、舍入一位。

### 原创项目质量

没有非空原创仓库时为零。否则：

```text
star = (7*L(total_stars,5000) + 5*L(max_stars,2000)) * quality * engagement
substance = 6*C(best_original_repo_quality_score ?? 0)
quality = total_stars > 0 ? C(top_starred_original_repo_quality_score ?? 1) : 1
```

engagement 未测量或 >=4% 为 1；[2%,4%) 为 .85；[1%,2%) 为 .7；<1% 为 .5。
该乘数属于既有正向维度，此次保留。

### 贡献质量

`volume = 16*L(merged_pr_count,200)`，再减文档类贡献折扣，下限 0。
文档样本优先使用 external 字段，其次历史 merged 字段；比例优先显式 ratio，
其次 count/sample。样本 >=20 且比例 >=.55 时：
`discount=min(.55*volume, 2.5 + 3*C((ratio-.55)/.075))`。

接受度分母：有关闭类型明细时只计 merged + 维护者关闭未合并；否则使用
`max(merged,total_pr)`。分母 >=3 时 `6*merged/denominator`，否则 `1.2*merged`，上限 6。
作者自行关闭的 PR 不另外扣分。Issue 分为 `5*L(issues_created,100)`。

prestige 信号为 `C(impact_prestige_score ?? L(max_impact_repo_stars,100000))`。
核心影响 PR >=2 且 prestige >=.5 时奖励
`min(2, .8*prestige + 1.2*min(core/5,1))`。

最终取原始贡献分和以下适用上限的最小值：

- 全局 27。
- merged >=80、prestige 低于 `L(10000,100000)` 且 max_stars <1000：上限 22。
- 文档样本 >=20 且比例 >=.55，impact_quality_cap <=4 且 core <=2，
  同时存在弱项目或大量自行关闭外部 PR：上限 12。
  弱项目指最高星标项目质量 <.3 且有 stars，或 max_stars <100、total_stars <300
  且最高星标项目质量 <.6；大量自行关闭指 merged + maintainer_closed + self_closed_external
  >=20 且 self_closed_external 占比 >=.25。

### 生态、社区、活动

生态：`9*prestige + 11*min(impact_depth_raw/8,1)`；如存在 impact_quality_cap 再封顶。
采集端的归属、文档分类、项目质量与影响工作聚合属于输入定义，不能只改公式而改变其含义。

社区：`5*L(followers,2000) + ratio_points`。following >2000 且 followers <.3*following
时 ratio_points=0；following=0 时有粉丝取 3、否则 0；其余按 followers/following
>=2 / >=1 / >=.5 / 更低，分别取 3 / 2 / 1.5 / 1。
若 followers >=500、去年贡献/merged/impact_pr/max_impact_repo_stars 都为零、
total_stars <=300 且最佳项目质量 <.85，社区分上限 2.5。

活动：`8*L(last_year_contributions,2000) + recency + 1.125*min(activity_type_count,4)`。
最近活动 <=90 天得 4.5，<=365 天得 2，更早或未知得 0。

## 4. v11 新人奖励（此次保留）

```text
bonus = 4 * strength * confidence * (1-age/3)^2
ramp(v): x=C((v-.55)/.30); return x*x*(3-2*x)
strength = min(ramp(project_quality), ramp(contribution/27),
               ramp(max(depth/8, L(impact_commits+impact_prs,400))), ramp(activity/17))
confidence = min(C(verified_impact_prs/5), C(core_impact_prs/3), C(merged_sample/20))
```

资格要求：年龄有限且在 [0,3)，注册时间为有效 GitHub UTC 时间，非空原创仓库 >0，
最近活动在 [0,90] 天，merged PR 聚合完整，没有 star_inflation_suspect，
v10 风险评估扣分为零且没有 contribution 族信号（零扣分提示也阻止奖励）。
所有条件和舍入路径均保留；旧扣分恢复后，不把新的平面扣分反向传入资格判断。
因此可能同时出现“新人奖励”和旧规则的足迹扣分，这是局部回退的明确结果，
不应通过悄悄取消新人奖励来消除这种组合。

## 5. 回退前的 v10 风险层（保留记录，退出总分）

该层与六维正向分分离。足迹信号只提示，不扣分；贡献族上限 16，社交族上限 9，
总上限 25。同族按原始分比例分配并做尾项舍入修正。风险分=`penalty/25*100`；
>=60 为 high，>=20 为 review，其余 none。风险等级不是作弊结论。

采样满权重为 40；比例平滑 `(events+1)/(sample+2)`；Wilson 使用 z=1.96。
覆盖度为仓库、merged PR、all PR 的采集比例，分母分别为 public_repos、
min(merged_count,50)、min(total_pr,30)，各自至少为 1，比例限制 [0,1]。
总 confidence 为 `(0.4*repo + 0.4*merged + 0.2*all)*100`。
证据窗口最多 200 仓库、50 merged PR、30 all-state PR。

| 信号 | v10 扣分条件与原始分 |
| --- | --- |
| 外部低实质 PR | merged sample >=20，平滑比例 >.5；`8*C((rate-.5)/.4)*min(sample/40,1)` |
| 维护者拒绝 | 必须有明确 maintainer_closed 字段，decided >=20 且 Wilson 下界 >=.4；`4*C((lower-.4)/.4)` |
| 模板洪水 | 采集器确认外部目标，sample >=20、集中度和模板率均 >=.6，并有低实质或拒绝佐证；`8*pattern_severity*corroborating_severity` |
| 关注与星标组合 | following >=1500、followers/following <.2；同时 star suspect、max_stars >=500、已测 engagement <.02 |

模板 pattern severity 是集中度和模板率分别从 .6 到 1 归一化后的均值，再限制 [0,1]。
佐证 severity 取 trivial 与 rejection 的最大值；拒绝 severity 还乘 min(decided/40,1)。
社交原始分分别为 `4*C((.2-follow_ratio)/.2)*C((following-1500)/3000)`
和 `4*C((.02-engagement)/.02)`，两者均 >0 才各加 .5，否则两项均不扣分。

足迹提示包括年轻账号大量建仓、Fork 占多数、无非空原创、空仓库占多数、资料稀少、
短期活跃后休眠、社交热度与代码足迹脱节。贡献与社交可在未达扣分门槛时保留提示。

## 6. 本次恢复的旧扣分规则

直接恢复 `21e2f504^` 的扣分公式，不改变采集或六维正向公式。

| 信号 | 条件 | 原始扣分 |
| --- | --- | ---: |
| new_account_mass_repos | age <1 且 public_repos >30 | 10 |
| mostly_forks | forks/max(fetched,1) >.7 且非空原创 <=2 | 10 |
| no_original_work | 非空原创 =0 | 10 |
| mostly_empty_repos | 空原创 >=5 且占 fetched 比例 >.5 | 5 |
| follow_farming | following >1000 且 followers <.3*following | 10 |
| ghost_profile | 无 bio、followers <3、stars=0、merged <2 | 8 |
| burst_then_dormant | 活跃年数 <=1、age >2、最后活动 >365 天（未知按 999） | 5 |
| social_only_dormant_profile | 同第 3 节社区分封顶条件 | 5 |
| possible_star_inflation | star_inflation_suspect | 5 |
| trivial_pr_farming | merged sample >=10，外部 trivial 占比 >.5 | 8 |
| high_pr_rejection | merged + rejected >=10 且 rejection_rate >.5 | >.7 扣 10，否则 8 |
| templated_pr_flooding | pr_flood_suspect 为真，按下面规则 | 4–20 |

旧拒绝数优先 maintainer_closed，缺失时回退 closed_unmerged，使用已采集 rejection_rate。
模板集中度 severity=`C(.5*(share-.5)/.5 + .5*(templated-.5)/.5)`。
低质量证据计数为：文档样本 >=20 且比例 >=.55；rejection >=.35；
有热门项目影响信号但 core <=2 且有 impact_quality_cap 或 max_impact_stars >=10000；
以及 total_stars <300 且最高星标项目质量 <.5。
极端洪水为 share >=.85 且 templated >=.75。
证据 >=2 或极端且证据 >=1：`10+Math.round(10*severity)`；
证据 =1 或极端：`6+Math.round(4*severity)`；其余 `4+Math.round(4*severity)`。
这里使用向正无穷的半值舍入，不是 half-even。

```text
penalty = min(sum(raw flag penalties), 40)
base = R_1(sum(six dimensions, including retained newcomer bonus))
final = R_2(clamp(base - penalty, 0, 100))
```

red_flags 保留原始扣分，合计可超过 40；total_penalty 才是封顶后扣分。
保留结构化 API，risk_assessment.version 标记为 v9（扣分政策版本），
applied_penalty=total_penalty，risk_score=penalty/40*100。
零扣分风险提示可保留，但已变成扣分的同名提示移除。v10 的 confidence/observed
仅复用为采集证据描述；扣分信号不沿用 v10 门槛，threshold 标明总封顶 40。
score v12 是产物版本，与 risk policy v9 是不同命名空间。

## 7. 档位、发布和验收

档位阈值保持：>=90 夯，>=80 顶级，>=70 人上人，>=40 NPC，其余拉完了。
不因回退重新校准排名或文字。

发布使用 [v12/v11/v5 计划](../releases/v12-v11-v5-rollout.md)：
三端公式一致；新缓存、重放、物化使用新 score 版本；旧历史保留；不能仅改版本号。
验证必须覆盖旧扣分阈值、40 分封顶、原始旗标、API 完整明细和保留的新人奖励。
原 v10 风险测试改为直接验证保留的资格评估器，不能继续假定它决定最终扣分。

## 8. 后续需要讨论的问题

- 是否继续把“公开足迹少”当作扣分？旧规则恢复会降低部分新人和纯贡献者分数。
- 样本不足与未知拒绝归属如何处理，是否需要重新采用统计置信门槛？
- 新人奖励资格使用 v10 风险判断，而总分使用旧扣分，长期是否应统一？
- 是否需要对重叠信号去重、分族封顶？不能在此次局部回退中顺便修改。
- 上线前应用真实快照比较年龄、项目类型、采样覆盖率各组变化；合成测试不能证明公平性。

任何未来调整应单独 RFC/PR、三端同步、增加行为回归用例并递增产物版本。

## 9. main 同步补充（发布时优先采用本节）

发布前同步了远端 main `66d371ea`。第 3 节记录最初检查的 `daa796da`；
远端后续正向校准和原创项目社区贡献均保留。本次没有撤销这些更新：

- 原创星标项优先使用 weighted_total_stars / weighted_max_stars，缺失才回退原字段。
- 生态 depth 满分点为 10，移除全局 impact_quality_cap；文档权重由采集端逐仓库计算。
  文档贡献上限 12 的低影响条件改为生态原始分 <=4、core <=2 且 doc_like > core。
- 社区 ratio_points 再乘 `L(followers,500)`。
- 有 external_merged_pr_count 时，外部 PR 有效量为
  `external*(high_star_share+.6*(1-high_star_share))`，以 150 达到 12 分；
  自有 PR 以 200 达到 `4+6*C(own_pr_community)` 分。文档折扣只作用于外部部分。
  接受度在 external + maintainer_closed >=3 时按外部 PR 计算，否则沿用历史公式。
  没有 external_merged_pr_count 的快照保留第 3 节的单池计算。
- 新人奖励的公式、资格和 depth/8 输入仍保持已有定义，不随生态维度的 depth/10 改写。

Python 本地评分同步上述已存在于 main 的正向公式，避免 SDK 与网站的新基线分歧。
所有旧扣分阈值仍以第 6 节为准；本次 v12 变化是恢复旧扣分。
