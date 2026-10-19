# v13 / v12 / v6：归因创建者的生态影响

仅升级 Node collection v5 → v6，Go 独立采集版本 v4 → v5。score v13 / roast v12 不变。
`score(metrics)` 没变；改变的是采集时派生的 impact、外部 PR 分类、社区事实，旧 metrics
无法通过纯重算恢复缺失的仓和证据，因此必须新采集标签。社区事实缓存 v1 → v2。
Python 本地采集同步公式、社区过滤和归因证据，不伪造服务端 provenance。
Go 补齐 TS/Python 已有的 first-commit 采集路径：相同默认分支 history cursor、
GitHub author/committer/noreply 解析优先级与原有长期贡献门槛，不新增身份判据。

## 行为

- 已归因原创且有首 commit / release/tag 作者证据，外部真人 merged PR ≥1 或 forks ≥10，
  非 star inflation：在 ≥200★ 时取 max(历史外部星数口径, 社区口径)。
- 历史口径 prestige = logRatio(stars,100000) × work × doc；depth =
  logRatio(stars,5000) × workDepth × doc。刻意不加后来引入的 code/tenure 折扣，
  对齐悬崖前口径。保留私有、fork、资源仓和落地工作门槛。
- 仅 org member、个人名下仓、空洞刷星组织不开放此通道。star inflation 强制关闭星数通道，
  即便社区事实缺测也传播此标志。不改变身份归因判定。
- 外部 merged 作者补入 contributors，按 max(commit数, 已见PR数) 去重；substantiveShare
  最低 0.5，避免文档 PR 清零已验证贡献者。账户年龄 ≥90 天，仍必须有 ≥10 followers
  或扣除本仓已见 PR 后 ≥3 merged PR 的独立足迹。bot / 本人 / 组织内部人过滤不变。
- attributed 仓 PR 划入 own，计入 own_pr_community；verified/core 的仓上下文和
  impact 保持一致，仅满足上述创建者通道的归因仓可计 verified ecosystem PR。

## 发布

使用 CI 发布。只对 yifanxuaaa 做 force 新扫描验收，不做全站回填、删除或改写旧快照。
collection 新缓存键自然隔离旧 metrics。公开 score 读序保留 [v13,v10]，紧急只读回退为 v13/v12/v5。manifest 显式记录
retainedPublicScoreVersions=[v10]，校验只能延续升级前已可读的旧标签，不能引入新别名；
score 升级时不得使用此延续字段。避免 collection 升级意外隐藏旧分数或要求全站回填。
需扫描的其他账户走现有有机刷新；本 PR 不自动触发全站扫描。

## 验收与回滚

共享 Oct 18 metrics 回放：旧 67.2 / ecosystem 1.1；A 历史星数通道约 75.9 / 8.1，
A+B 含 v13 社区贡献加分约 76.3 / 8.1。仓聚合和外部样本按只读报告重建，样本日期做了
标准化；不声称这是完整历史 API 响应。保留原 metrics 原样供对照。
测试覆盖空组织 0/2 forks、仅成员、刷星标志、个人仓、bot 与真实外部 PR、docs-only。
TS/Go/Python 共享 fixtures 对拍，执行类型检查、lint 与后端/SDK 测试。

回滚代码、manifest 和采集版本并重新部署；保留所有产物。无需数据删除或全站回填。
