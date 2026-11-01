# Score v18：贡献质量顶部要求独立采纳证据

仅 score v17→v18；roast v12、collection v6 不变，Go collection 仍为 v5。
公开读顺序 v18→v17→v16→v15→v14→v13→v10；历史分数保留版本和来源。

## 问题与公式

旧数量项 `16·logRatio(merged,200)` 在 123 PR 已得 14.54 分。
2507 自有 stars 又让旧 cap 的 `projectProtection` 达 1，从而完全解除
低声望批量上限。虚构复现加接受率 5.904、issue 5、核心奖励 1.68，
raw=27.126725，最终直接截为 27。高星项目应在原创/主导维体现，
不应代替贡献维需要的独立采纳证据。

保留 raw、文档折扣、风险和旧声望/核心曲线的系数，仅修改三端 cap：

```
V = smoothstep((merged−40)/80)
P = 20 + 3·smoothstep((prestige−.3)/.5)
       + 4·H + 2.5·K·(1−H)
H = smoothstep((prestige−.65)/.15)
K = smoothstep((core−40)/60)
prestigeCap = 27−(27−P)·V
N = clamp(external,0,merged) + own·clamp(own_pr_community,0,1)
recognitionCap = 20 + 7·(1−exp(−N/80))
contribution = round_half_even(min(raw,27,prestigeCap,recognitionCap),1)
```

移除 stars 豁免；N=80/160/320 时证据上限约 24.42/26.05/26.87，
约 396 次有效采纳才可能四舍五入到 27。真实社区维护者通过 A 获得信用；
external 未测时跳过 recognitionCap，避免把未知当 0，仍应用 prestigeCap。
旧 40→120 过渡不变，不新增二元门槛；该既有 cap 在数量增大时可能下降。

保留作者自关中性，不计接受率分母、风险或降权。workflow landing
是仓库官方 bot 确认的替代落地流程；普通 GitHub MERGED 不需要它非零，
因此不设 workflow=0 硬门槛，也不将未分解归属的 workflow 数伪造成外部采纳。
当前采集器已从 external 按份额扣除归因组织/共建仓 PR，本次不改采集或归因。

## 本地虚构画像（完整输入见共享 golden）

| 画像 | 贡献质量 | 总分 |
| --- | ---: | ---: |
| 问题复现：自有组织为主 | 27.0 → 20.0 | 88.4 → 81.4 |
| 真实外部贡献者 | 27.0 → 27.0 | 91.7 → 91.7 |
| 只给自己组织提 PR | 27.0 → 20.0 | 88.4 → 81.4 |
| 高拒收率 | 23.3 → 23.3 | 84.44 → 84.44 |
| 新手少量 PR | 9.9 → 9.9 | 35.1 → 35.1 |
| 官方工作流有落地的头部贡献者 | 27.0 → 27.0 | 97.2 → 97.2 |
| 自有项目有外部社区 | 27.0 → 27.0 | 96.3 → 96.3 |

复现补全：issues=100、external=0、A=0、prestige=.6、core=5；题设
没有这些完整输入，以上不代表真实账号重测。保持其余补全输入，external
为 0/10/30/123 时新贡献为 20.0/20.8/21.9/21.9，未测为 21.9。
高拒收例仍由原有接受率和风险计分，其他五维和风险均不变。

## 分布证据及局限

已有 v15 历史聚合 232 条，旧贡献满分 11/232=4.74%。只用已验证核心 PR
数作 merged 下界，忽略新增证据上限，保守 cap 上界估算至少 1 条旧满分
退出，满分占比至多 10/232=4.31%。不能把该历史上界当作 v17→v18 当前
分布或实际降幅预测；原聚合缺 merged/external/A/issues，不能精确重放，
也不能断言当前中位数漂移。统计不含账号身份，见同目录 JSON。

## 验证与边界

TS、Go、Python 共读 contribution-quality-fixtures.json，锁定子分、总分、
风险和精确 cap；验证 stars 不再解封、自关中性、证据上限单调及收益递减、
旧边界连续、缺失/越界保护。其他已有 golden 仅更新受影响的评分预期。

未归因的自建组织仍可能落入 external；外部社区测量遗漏可能低估维护者。
本次只修评分已有证据的使用；完整离线快照的后续分布复核仍有价值。
完整实施前诊断按用户要求保存在本机 handoffs，本文给出可在 PR 审阅的摘要。

## 发布与回滚

仅创建到 dev 的 PR，CI 全绿后停止，不合并或部署。新标签由现有自动版本
升级流程处理；不改缓存/重测冷却/自动扫描实现。版本合同测试中的 key
字面值随 score 版本变化，缓存实现未变。

不删除、改标、回填或批量重算任何旧记录，不重建索引，不访问生产数据库、
修改生产配置/secret/cron 或 discovery 公网开关。若需回滚，正常 PR 同时
还原公式和版本 manifest/常量，保留 v18 历史 artifacts；不得回写旧标签。

## 实施后既有匿名完整快照复核

三类既有快照共 9 条预期受影响（跨文件可能重复同一匿名画像），贡献质量降幅
为 0.2–5.6 分，其他五维和风险不变。较大降幅来自移除高星豁免后重新应用旧声望
上限；这也覆盖有社区但声望/核心证据不足的维护者，不能声称所有维护者均不降。

| 快照 | 贡献质量（旧→新） | 总分（旧→新） |
| --- | ---: | ---: |
| fixture-account-070（presentation-score-fixtures.json） | 22.2 → 21.8 | 79.8 → 79.4 |
| fixture-account-035（presentation-score-fixtures.json） | 27 → 21.8 | 91.7 → 86.5 |
| fixture-external-maintainer（content-skill-score-fixtures.json） | 27 → 25.9 | 90.8 → 89.7 |
| fixture-application-author（content-skill-score-fixtures.json） | 21 → 20.4 | 72.6 → 72 |
| fixture-account-018（impact-regression-fixtures.json） | 27 → 21.4 | 83.6 → 78 |
| fixture-account-035（impact-regression-fixtures.json） | 27 → 21.4 | 91.2 → 85.6 |
| fixture-account-074（impact-regression-fixtures.json） | 27 → 26.3 | 94 → 93.3 |
| fixture-account-043（impact-regression-fixtures.json） | 27 → 26.5 | 97.9 → 97.4 |
| fixture-account-038（impact-regression-fixtures.json） | 27 → 26.8 | 95.5 → 95.3 |

旧 v16 内容校准的 ±1.5 守卫保留：从当前总分剔除此次贡献维的独立变化后验证；新增 calibration_contribution_quality 保存原参考贡献值。完整当前总分仍由精确 golden 锁定，没有放宽容差。

### 缺测序列化边界

新增回归先复现了 TS 将 JSON `external_merged_pr_count: null` 当成已测 0
的问题；cap 和自有 PR 社区信用同时把 null/undefined 视为未测，统一 Go nil / Python None
的行为。没有改动采集或缓存，原有非空数字结果不变。
