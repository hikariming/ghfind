# v15 上线前离线分布验证

样本：232 个账号。基线：`2010358b9e0360f13d88a2f696f73dd8ff64b60d`。候选评分代码指纹：`0da7e6e10ae682375d733f479681c9335fc92bfa34717013eead7270c018bca9`。

账号来自 D1 最新快照：最近 200 人，加上候选池中历史外部文档比例最高的 50 人，并补入六个指定账号；去重后计划样本为 232 人。选择账号时不使用 v15 结果。所有 D1 操作为 SELECT；GitHub 补充查询与响应缓存仅写本地。

历史 D1 快照没有逐文件增删行数。最终验证将 v14、v15 两套完整采集及评分代码放在同一批只读 HTTP 响应上重放；固定时钟为 2026-10-20T12:00:00Z。仓库级代码占比、社区证据、PR/fork 曲线均参与重算，不使用“固定旧影响力指标”的早期探索结果作为发布门槛。

完整重放指采集器执行完成，不代表穷尽 GitHub 全历史。现有合并 PR 采样上限仍可能触发；两套公式使用同一响应，保留相同的采样边界。

## 总分分位数

| 分位数 | v14 | v15 | 变化 |
| --- | ---: | ---: | ---: |
| p10 | 18.1 | 18.1 | +0.0 |
| p25 | 35.7 | 34.9 | -0.8 |
| p50 | 50.1 | 49.7 | -0.4 |
| p75 | 68.7 | 67.9 | -0.8 |
| p90 | 81.2 | 81.0 | -0.2 |
| p99 | 95.7 | 95.6 | -0.1 |

## 指定账号

| 账号 | v14 | v15 | 变化 | P | C | core | core churn | n | discount |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lofisu | 61.8 | 54.6 | -7.2 | 0.770 | 0.883 | 3 | 0.131 | 37 | 0.3848 |
| hikariming | 91.9 | 91.8 | -0.1 | 0.000 | 0.000 | 0 | 0.000 | 0 | 1.0000 |
| samzong | 95.7 | 95.6 | -0.1 | 0.009 | 1.000 | 8 | 0.965 | 5 | 1.0000 |
| asperformias | 74.2 | 74.2 | +0.0 | 0.071 | 1.000 | 88 | 0.586 | 50 | 1.0000 |
| asukaminato0721 | 91.1 | 91.1 | +0.0 | 0.096 | 1.000 | 93 | 0.811 | 47 | 1.0000 |
| yifanxuaaa | 78.5 | 78.9 | +0.4 | 0.000 | 0.000 | 22 | 0.000 | 0 | 1.0000 |

### 指定账号子项（v14 → v15）


**lofisu**：account_maturity 6 → 6；original_project_quality 9.5 → 9.5；contribution_quality 15.3 → 13.8；ecosystem_impact 10.2 → 4.5；community_influence 7.8 → 7.8；activity_authenticity 13 → 13。生态实际 discount=0.4163。

**hikariming**：account_maturity 10 → 10；original_project_quality 15.4 → 15.4；contribution_quality 27 → 27；ecosystem_impact 16.3 → 16.2；community_influence 6.2 → 6.2；activity_authenticity 17 → 17。生态实际 discount=1.0000。

**samzong**：account_maturity 10 → 10；original_project_quality 16 → 16；contribution_quality 27 → 27；ecosystem_impact 19.1 → 19；community_influence 6.6 → 6.6；activity_authenticity 17 → 17。生态实际 discount=1.0000。

**asperformias**：account_maturity 8 → 8；original_project_quality 7 → 7；contribution_quality 22 → 22；ecosystem_impact 16 → 16；community_influence 4.3 → 4.3；activity_authenticity 16.9 → 16.9。生态实际 discount=1.0000。

**asukaminato0721**：account_maturity 10 → 10；original_project_quality 9.9 → 9.9；contribution_quality 27 → 27；ecosystem_impact 20 → 20；community_influence 7.2 → 7.2；activity_authenticity 17 → 17。生态实际 discount=1.0000。

**yifanxuaaa**：account_maturity 10 → 10；original_project_quality 16.2 → 16.2；contribution_quality 21.6 → 22；ecosystem_impact 9.2 → 9.2；community_influence 5.6 → 5.6；activity_authenticity 15.9 → 15.9。生态实际 discount=1.0000。

P 为展示类 churn 占比；C 为展示 churn 的前两仓占比；core 为参与保护的核心 PR 计数（新完整样本与既有验证计数取大）；core churn 为核心代码行数占比；discount 为账号级保留权重（1 表示无降权），生态实际权重另按外部 PR 占比缩放；n 为有完整文件证据的外部 PR 样本数。缺失或截断的文件样本不会凭标题推定为展示工作。

## 最大降幅 20 人：人工复核

| 账号 | v14→v15 | Δ | P | C | core | n | 复核 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| xqliu | 79.8→65.4 | -14.4 | 0.964 | 0.997 | 0 | 39 | 34 个 orbi-website PR，博客、静态页面与站点生成产物占主体；外部样本无核心 PR，符合集中度降权。 |
| lofisu | 61.8→54.6 | -7.2 | 0.770 | 0.883 | 3 | 37 | apache/fory-site 与 higress 官网集中；保留 deer-flow 实现改动及 3 个核心 PR，仍为展示主体。 |
| cosmicshreyas | 55.4→49.5 | -5.9 | 0.901 | 0.845 | 2 | 14 | 外部样本为多个 README/项目说明及社区站点改动，展示 churn 占主体；按仓集中度和置信度连续计权，不推断作者动机。 |
| guirab | 43.5→38.6 | -4.9 | 0.941 | 1.000 | 0 | 5 | 4 个 rhino-website PR 为官网页面/动效，另有 TanStack 示例；P=94%，不将所有 React 产品实现一律降权。 |
| rafaelbcerri | 57.7→53.1 | -4.6 | 0.662 | 0.997 | 1 | 40 | Laboratoria/curriculum 教程文档集中，P=66%，核心 churn 6.5%；Django/API 与 UI 库代码保留，截断大 PR 不参与新集中度。 |
| abha-1281 | 36.5→32.0 | -4.5 | 0.744 | 0.993 | 0 | 3 | 外部为贡献者列表及 Animation-Nation 的 HTML/CSS 动画作品；保留正贡献，符合展示类型。 |
| rupeshgoud | 38.9→34.9 | -4.0 | 0.749 | 1.000 | 0 | 7 | freeCodeCamp/guide 的 C++ 教程文档占主体；Python 脚本核心改动仍保留，core churn 低于保护阈值。 |
| hamo-reid | 49.8→46.0 | -3.8 | 0.986 | 1.000 | 2 | 4 | 4 个 bilichat 外部 PR 主要是已构建 WebUI/vendor 静态资源和样式；实际后端实现未被分类为展示。样本少，置信度仅 4/6；不推断贡献动机。 |
| markdimi | 44.6→40.8 | -3.8 | 0.845 | 1.000 | 1 | 3 | hdbscan 两个 rst 文档改动占 churn 主体，另有域名注册 JSON；折扣由少量样本置信度减弱。 |
| christofa | 53.2→50.7 | -2.5 | 0.550 | 0.969 | 0 | 23 | 大学站点页面/样式与 Webiny 教程为主，P=55%；普通 JSX 实现不因目录一律归为展示，折扣平滑且保留核心 churn 保护。 |
| xmanrui | 81.9→79.8 | -2.1 | 0.733 | 1.000 | 1 | 4 | 外部 PR 为 awesome 资源列表和通知集成条目；自有 dsh-im 实现贡献保持中性。 |
| saqib-devsecops | 50.5→48.5 | -2.0 | 0.867 | 0.999 | 0 | 10 | 外部管理台模板、Logo 和样式集中；Python forms/views 实现保留为核心，不因同一 PR 含模板一刀切。 |
| wxw-gu | 60.4→58.8 | -1.6 | 0.905 | 1.000 | 0 | 2 | 外部 19 行中 17 行为文档，另一个 PR 为文档地址修正；自身 TraceMemo 开发不参与集中度。 |
| mauriciofs | 43.9→42.4 | -1.5 | 1.000 | 1.000 | 0 | 3 | 外部贡献集中于 blockchain 网站；个人天气应用开发排除，外部展示折扣不覆盖自有 PR。 |
| keithclinton | 47.5→46.1 | -1.4 | 1.000 | 1.000 | 0 | 3 | 自有 mwalimu-ai-guide Python 实现排除；外部样本为文档贡献，按外部合并占比限制折扣。 |
| koloyaaa | 43.5→42.2 | -1.3 | 0.935 | 1.000 | 0 | 2 | 外部 87 行 CONTRIBUTING 文档和 6 行 JS；少量样本，折扣受置信度限制。 |
| kyl67899 | 57.9→56.8 | -1.1 | 1.000 | 1.000 | 0 | 3 | 外部样本为 chatgpt.js 用户指南、README 与贡献者列表；个人站点工作排除。 |
| arcspots | 31.5→30.9 | -0.6 | 1.000 | 1.000 | 0 | 1 | 外部仅 README 安装地址修正，低置信度折扣；非核心实现误判。 |
| chinari20 | 29.7→29.1 | -0.6 | 1.000 | 1.000 | 0 | 1 | 外部仅 FUN_FACTS.md 文档，低置信度小幅折扣。 |
| ramojo | 42.7→42.1 | -0.6 | 1.000 | 1.000 | 0 | 1 | 单个提交页面模板的文案修改；按展示行数计入，单样本置信度限制降幅。 |

## 最大升幅

| 账号 | v14 | v15 | Δ |
| --- | ---: | ---: | ---: |
| tarunvashishth | 54.1 | 58.8 | +4.7 |
| ziangni-sys | 47.1 | 51.3 | +4.2 |
| cmi23 | 50.8 | 54.8 | +4.0 |
| nwflower | 76.3 | 79.6 | +3.3 |
| madhavkhoslaa | 63.1 | 66.1 | +3.0 |
| 1lck | 86.2 | 87.8 | +1.6 |
| junjiezhou1122 | 72.8 | 74.2 | +1.4 |
| yuxino | 86.3 | 87.6 | +1.3 |
| sunshine-lang | 60.7 | 62.0 | +1.3 |
| kusman28 | 47.5 | 48.8 | +1.3 |

最大升幅复核：tarunvashishth 的 PatternFly 产品样式按 UI 库核心代码保留；ziangni-sys 与 nwflower 的实际展示 churn 均约 4%，取消旧按 PR 数量的文档阶跃扣分后回升。cmi23（P=51%）与 madhavkhoslaa（P=26%）也因旧文档 PR 数量阶跃被连续行数权重替代而回升。其余主要由外部合并 PR 的证据权重校正及混合 PR 连续计分带来，未新增粉丝/星数奖励。

## 验收

- 数量、lofisu 50–55、五名对照 ±1.5、中位数 ±1：全部通过。
- 核心 PR ≥10 且下降超过 1.5 分的账号：0 人。
- 触及既有合并历史采样边界的账号：23 人；提交历史不可用：0 人。
- 文档和网站贡献保留正权重；这些技术分类不推断作者动机，也不新增风险标签。自关 PR 对照测试保持完全同分。
- 生产仅计划强制重扫 lofisu 与 yifanxuaaa；不批量回填、不重建索引、不删除历史。

复现入口：[采集及配对重放](../../scripts/research/v15-full-replay.mts)、[分布门槛](../../scripts/research/v15-distribution.mts)、[方法说明](../../scripts/research/README-v15.md)。汇总数据见 [JSON](v15-distribution-20261020.json)。
