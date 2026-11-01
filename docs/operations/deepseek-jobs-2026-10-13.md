# DeepSeek 职位核对与方向拆分（2026-10-13）

来源：[DeepSeek 官方招聘列表](https://app.mokahr.com/social-recruitment/high-flyer/140576#/jobs)。快照共 37 个列表入口，与浏览器 50 行/页的完整列表核对一致。

仓库旧种子有 34 条开放记录，涵盖所有 34 个有效入口；另外 3 个官方入口仅跳转到新的 Harness 团队页，不作为额外推荐岗位。本机未取得线上 D1 凭据，因此这里的“原有记录”指仓库迁移结果，不能当成线上核验结论。

17 个页面拆出 53 条方向记录，保留 17 条独立岗位，共 70 条开放记录。53 条方向记录分别保留本方向原文和共用要求，旧的 17 条混合记录关闭推荐状态，不删除历史数据。AI 产品经理页的 Harness 产品方向指向 Harness 产品经理的同一条记录，避免重复评分。

| 官方页面 | 覆盖方向数 | 对应岗位 |
| --- | ---: | --- |
| 预训练（数据/算法）研究员 | 2 | 预训练算法研究员；预训练数据研究员 |
| HR团队 | 2 | 招聘 HR；综合服务 HR |
| 财务团队 | 2 | CFO / 财务总监 / 会计；出纳 |
| 采购团队 | 5 | 硬件采购；云服务采购；IDC 采购；数据中心资产管理；采购管培生 |
| Code Agent 数据工程师 | 6 | Code Agent 数据工程师 · 前端；Code Agent 数据工程师 · 移动端；Code Agent 数据工程师 · 后端；Code Agent 数据工程师 · Web 3D 与渲染；Code Agent 数据工程师 · 游戏开发；Code Agent 数据工程师 · 网络安全 |
| AI 产品经理 | 2 | AI 产品经理 · Chat / App / 开放平台；Agent Harness 产品经理 |
| AI平台运维工程师 | 2 | AI 平台运维工程师 · 集群运维；AI 平台运维工程师 · 运维开发 |
| IT 基础设施团队 | 2 | IT 系统硬件与网络工程师；IT 桌面与信息化工程师 |
| 超算集群研发工程师 | 3 | 超算集群工程师 · 集群调度；超算集群工程师 · 高性能网络；超算集群工程师 · 集群与模型协同设计 |
| 服务端开发工程师 | 5 | 服务端开发工程师 · 大模型研究平台；服务端开发工程师 · Agent 框架组件；服务端开发工程师 · 研发效率基建；服务端开发工程师 · DeepSeek API；服务端开发工程师 · 线上服务 |
| 预训练数据工程师 | 4 | 预训练数据工程师 · 数据采集 Pipeline；预训练数据工程师 · 语言数据处理；预训练数据工程师 · 多模态数据；预训练数据工程师 · 数据基建 |
| AI 搜索算法 / 架构工程师 | 2 | AI 搜索算法工程师；AI 搜索架构工程师 |
| Agent Harness 团队 | 7 | Agent Harness 深度学习研究员；Agent Harness 研发工程师；Agent Harness 开发者关系；Agent Harness 产品经理；Agent Harness 产品设计师；Agent Harness 项目经理；Agent Harness 产品运营 |
| Agent 弹性计算研发工程师 | 2 | Agent 弹性计算工程师 · 平台开发；Agent 弹性计算工程师 · 底层系统 |
| 前端 / 客户端开发工程师 | 2 | 前端开发工程师；客户端开发工程师 |
| IDC数据中心团队 | 3 | IDC 数据中心基础设施运营；IDC 数据中心规划设计；IDC 数据中心现场工程师 |
| 运营团队 | 3 | 技术运营；开发者关系 · 模型 API 与开源生态；产品运营 · DeepSeek 产品 |

“CFO / 财务总监 / 会计”由官方写在同一个方向中，没有分别给出任职要求，因此保留为一个方向。多模态理解页列出的技术能力和高性能算子页的工作任务也没有被硬拆为独立职位。

## 导入与匹配刷新

1. 运行 `node --import tsx scripts/deepseek-jobs-import.mts` 生成可重复执行的 `migrations/0026_deepseek_job_directions.sql` 与本地核对清单。
2. 登录 Cloudflare，先只读核对线上 `jobs`、`job_translations` 与 `job_requirements` 的 DeepSeek 数据并保存备份。开发与生产共享核心 D1。
3. 核对后执行 `pnpm exec wrangler d1 execute ghfind --remote --env production --file migrations/0026_deepseek_job_directions.sql`。只应用此文件，不顺带应用其它迁移。
4. 执行 `pnpm exec wrangler workflows trigger ghfind-talent-jobs '{"all":false}' --config apps/talent/wrangler.jsonc --env production`，让线上模型逐条抽取新增/变更的岗位要求；等待 Workflow 完成，并核对 output 中的 failed 列表及 `job_requirements`。
5. 核对开放岗位、方向数量、完整 JD、父记录关闭状态和匹配要求哈希。只有 `jobs` 和 `job_requirements` 两层都成功，才可以宣称新岗位进入人才匹配。

更换岗位池后，已生成的报告保持原样；用户主动生成新报告时使用更新后的岗位要求。未写明的薪资、学历、年限和技术条件不补造。无技能要求的职能岗位可以出现在招聘板，但现有技术匹配器会跳过它们。

## 本地验证

- 37 个来源全部映射至有效记录，3 个旧 Harness 入口仅为别名。
- 迁移后 DeepSeek 开放岗位从 34 到 70；70 条均有完整中文 JD。
- 再次执行 SQL 不增加重复岗位；其它公司岗位数量不变，外键检查通过。
- Harness 研发岗位不继承研究员的硕士要求；Code Agent 前端不混入移动端要求；IDC 现场不混入设施设计资格。
- `pnpm test scripts/deepseek-jobs-import.test.ts src/lib/talent-match/__tests__`：75 项测试通过；根类型检查和 lint 通过。
