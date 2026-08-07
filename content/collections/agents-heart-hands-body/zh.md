> 这是本站「编辑推荐」栏目的第一期。我们不打算做一份流水账式的清单，而是想认真聊聊一个问题：当 AI 不再只是一个会对话的对话框，它还可以是什么？这一期，我们挑选了三个风格迥异、却又在深层互文的开源项目——一个让 AI 拥有「生活」，一个让 AI 拥有「手」，一个让 AI 拥有可规模化的「身体」。

## 卷首语：为什么是这三个

2026 年，Agent（智能体）这个词已经从热词变成了工程现实。但大多数人谈论 Agent 时，讨论的仍是“它能不能更好地回答我”。这一期我们想换个角度：**Agent 不该只是被唤起的工具，而应是能持续存在、持续运作、甚至持续生活的实体。**

顺着这个想法，我们选了三颗星，恰好构成 Agent 从里到外的三层图谱：

- **yuiju**（yixiaojiu/yuiju）——让 AI 角色在自己的世界里吃饭、上学、散步、记录日记，拥有独立于用户之外的生活。这是 Agent 的「心」。
- **lathe**（samzong 发起，现维护于 lathe-cli 组织）——把存量 API 一键变成 Agent 能安全调用的 CLI 契约与 Skill，让 Agent 拥有可以操作真实系统的「手」。
- **mosoo**（langgenius/mosoo）——在 Cloudflare 原生的隔离沙箱里规模化运行 Codex、Claude Agent SDK、OpenCode 等编程 Agent。这是 Agent 的「身体」。

一颗会生活的心、一双能干活的手、一个能跑起来的身体——它们各自回答了“AI 的下一形态”的一个根本问题。以下是我们的深度分析。

## 一、yuiju：不做 AI 智能助手，做有自己生活的「人」

![yuiju 角色「悠酱」头像](https://assets.usedify.app/collections/agents-heart-hands-body/yuiju-avatar.webp "图：yuiju 项目角色「悠酱」的头像，来自仓库 packages/source/picture/")

### 一句话推荐语（作者语）

在展开之前，先引用项目作者本人为 yuiju 写的一段推荐语，我们认为它精准概括了这个项目的灵魂：

> yuiju 是一个以虚拟世界模拟角色生活为核心的 AI 陪伴项目。它通过构建可持续运行的虚拟世界，让角色拥有自己的生活轨迹、社交关系与成长经历，而非仅仅围绕用户展开对话。项目借鉴游戏设计思维，将 AI 陪伴从“聊天工具”升级为“可长期体验的世界”，让用户在陪伴中体验探索、养成、互动与共同成长的乐趣。

### 它到底在做什么

主流的 AI 陪伴产品，本质是“以用户为中心的人设引擎”：角色随叫随到，回复由一段固定人设文本即时生成。yuiju 把这个逻辑整个倒了过来——**世界先于对话存在**。

这是一个 LLM 驱动的“角色自主生活模拟”项目，融合了 AI 聊天与“AI 小镇”的思路。角色在一个持续推进的虚拟世界中感知时间、天气、地点与自身状态，自主决策、执行行为，留下可追溯的生活轨迹、记忆、日记和计划。用户可以通过 QQ、飞书等消息入口与角色交流，但聊天只是用户观察和介入角色生活的窗口；角色的回复、近况与主动分享，都来自她在世界中**真实发生过**的经历，而不是临时现编的一段文本。项目 philosophy 写得很直白：不做 AI 智能助手，做有自己生活的“人”。

### 深度解析：它凭什么“活”起来

读过它的技术文档后，我们认为 yuiju 最值得称道的不是“角色会主动说话”这个表象，而是背后一套相当克制的工程哲学：

**第一，世界引擎是“按 tick 推进”的，而不是“按对话触发”的。** 核心模块 `@yuiju/world` 同时维护两条持续运行的流程：世界状态推进（时间、天气、场景开放状态、资源数量，像游戏引擎一样按固定间隔运转）和角色行为推进（读取角色状态、世界状态与历史经历，计算当前可执行行为）。**这条流程不依赖用户消息**——即使没人跟角色说话，世界依然在运转，她依然在生活。这是“可持续运行的世界”这句话落到工程上的关键。

**第二，LLM 只负责“决策”，不负责“改状态”。** 这是整套系统最聪明的一处取舍。“生活”太连续了，不能直接丢给大模型自由发挥。yuiju 把复杂行为拆成一个个原子化的 Action，LLM 只在通过前置条件的候选 Action 里做选择，返回一份结构化决策结果（选哪个、为什么）；真正的状态变化由 Action 的执行逻辑完成，并沉淀为行为记录，供后续记忆、日记和消息回复使用。换句话说，模型是“人生道路上的选择者”，而系统是“记录生活的事实簿”——这既避免了角色行为失控，也让一切经历变得可追溯、可回放。

**第三，记忆不是堆聊天记录，而是有层次的。** 消息上下文不会无限拼接：系统同时维护最近原始消息、滚动摘要和自然对话窗口，对话窗口在合适边界沉淀为 Memory Episode 并更新人物记忆。角色因此能“记得今天”，而不是每次都从头自我介绍。作者在博客里也坦诚，记忆模块仍以 JSON 存储、由 LLM 自更新，偶尔会出错——这种诚实，恰恰是开源项目最动人的地方。

**第四，游戏设计思维的全面渗透。** 动态天气系统让日常不只是固定脚本；角色可以拥有长期与短期计划，不只是被动回应用户的当下输入；当生活里发生值得说的事，她会在合适的时机主动分享，而不是永远等你开口。作者本人把项目介绍为“有状态、有行动、有记忆、有生活节奏的 AI 角色系统”——这是对“虚拟生命”最凝练的定义。

![yuiju 系统架构图](https://assets.usedify.app/collections/agents-heart-hands-body/yuiju-architecture.png "图：yuiju 系统架构——@yuiju/world 世界引擎同时推进世界状态与角色行为，LLM 只做 Action 决策")

### 编辑点评

yuiju 回答了一个许多 AI 陪伴项目回避的问题：**一个 AI 能不能在没有你的时候，也拥有自己的生活？** 它把陪伴从“你召唤我”升级为“我们各自生活，偶尔相遇”，让情感连接建立在真实的共同经历之上，而非即时生成的甜蜜话术。虽然项目仍处于早期，记忆模块等环节也在持续打磨，但它提供的方向——用游戏引擎式的确定性框架，去约束和承载 LLM 的自由度——对整个 AI 角色领域都极具参考价值。喜欢《动物森友会》、喜欢养成与陪伴感的读者，值得立刻去它的 Web 页面体验一次（`yuiju-web.yixiaojiu.top`）。最后放一张悠酱的表情包，感受一下她的“小脾气”：

![悠酱表情包 hmph](https://assets.usedify.app/collections/agents-heart-hands-body/yuiju-hmph.png "悠酱表情包：hmph")

## 二、lathe：让 API 一键长出 Agent 的「手」

![lathe logo](https://assets.usedify.app/collections/agents-heart-hands-body/lathe-logo.png "图：lathe 项目 logo，来自仓库 docs/images/")

### 它是什么

lathe 是一个面向 Agent 的 API 转 CLI 生成器：从 Swagger 2.0、OpenAPI 3、带 `google.api.http` 注解的 protobuf，乃至 GraphQL schema，生成**单二进制、生产级**的 Cobra CLI，并附带结构化命令目录与一份生成的 Skill 指南。项目由 samzong 发起，现维护于 lathe-cli 组织下，MIT 协议，是一个还很年轻、但迭代极快的项目。

作者的初衷很朴素，也很动人——“把旧世界存量的系统直接接入 Agent”。大多数团队不是没有 API，而是有一堆历史 API，却苦于无法安全、可靠地让 AI 去操作它们。

### 核心哲学：Spec 即真相，Catalog 即契约

lathe 的全部设计浓缩为两句话：

1. **API 规范是唯一事实来源。** 你声明 pin 住的上游 spec（按 tag 固定、解析到 commit SHA，拒绝浮动分支），声明 CLI 身份（`cli.yaml`）与模块来源（`specs/sources.yaml`），必要时加 overlay 打磨帮助文本；当 API 变化时，重新生成即可。告别了“手写 CLI、然后花一辈子防止它 drift（漂移）”的宿命。
2. **生成的 CLI 不只是一层外壳，而是一套 Agent 可机器化消费的契约。** 这才是 lathe 与普通 API 封装工具的本质区别。

### 深度解析：为「Agent 不靠猜」设计的整套协议

读过它的 README，你会发现 lathe 把“Agent 如何安全地使用一个 CLI”这件事拆解得异常细致：

- **发现**：`search "<intent>" --json` 按自然语言意图找候选命令；`commands --json` 输出完整命令目录；`commands show <path>` 查看某条命令的 flags、body、鉴权、HTTP 方法与输出提示——所有信息都是结构化 JSON。
- **预检**：`auth status --hostname <host>` 在调受保护命令前确认凭据；`--dry-run` 打印将发送的请求（含脱敏的 headers 与 body）而不真正发送，让 Agent 在执行前能核对一切。
- **执行**：`--file` / `--set` / `--set-str` 构造请求体，`-o table|json|yaml|raw` 提供机器可读输出，枚举校验、分页、流式一应俱全。
- **生成的 Skill**：codegen 默认写出 `skills/<cli-name>/` 目录，相当于一份“该 CLI 的 Agent 操作手册”（如何发现命令、检查目录、预检鉴权、构造 body、选择输出格式），还能打包进二进制（`<cli> skill install`）。运行时目录仍是真相，Skill 是教会 Agent 怎么用的入门指南。

此外还有三处工程细节值得一提：所有生成模块共享**同一套运行时**（鉴权、请求构造、输出、分页、流式、错误处理行为一致）；**overlay 层**允许在不改上游 spec、不改生成的 Go 代码的前提下，隐藏/忽略命令、修正参数、添加快捷命令；两阶段流水线（`specsync` 拉取并固定 spec → `codegen` 归一化为统一 IR 再渲染）保证了可复现性。

![lathe 架构图](https://assets.usedify.app/collections/agents-heart-hands-body/lathe-architecture.png "图：lathe 生成流程——spec 固定同步 → codegen 归一化渲染 → 生成 CLI 与配套 Skill")

### 为什么是现在：CLI 正在成为 Agent 的事实接口

lathe 站上了一个很有意思的行业浪头。Vercel CEO 曾直言“CLIs are the de-facto MCPs for agents”（CLI 就是 Agent 事实上的工具协议），Perplexity CTO 与 Y Combinator 掌舵人 Garry Tan 也在同期公开支持 CLI 路线，中文社区甚至一度喊出“MCP 已死”。与此同时，飞书这样的厂商同时维护着 CLI 与 MCP Server 两个开源项目。在这个“Agent 接口之争”的关口，lathe 的选择很聪明：**它不争论 CLI 还是 MCP 谁赢，而是把“从 API 生成 agent 友好 CLI”本身做成了一条自动化流水线，并且连配套 Skill 都一并生成。**

### 编辑点评

lathe 适合两类人：一类是手里攒着大量 Swagger/OpenAPI/proto/GraphQL、想把存量系统接入 Agent 的团队——它是目前把“旧世界接入新世界”成本压到最低的工具之一；另一类是喜欢“一个二进制，人类能用、Agent 能安全检查”这种工程美学的开发者。它把“Agent 不该靠猜”从一句口号变成了可执行的六步循环（搜索 → 查看 → 预检鉴权 → dry-run → 执行 → 结构化输出），这是它最扎实的贡献。

## 三、mosoo：给 coding agent 一个能规模化运行的「家」

![mosoo banner](https://assets.usedify.app/collections/agents-heart-hands-body/mosoo-banner.png "图：mosoo 官方 banner（2400×1260），来自仓库 docs/assets/")

### 它是什么

mosoo 是一个开源的、Cloudflare 原生的 **coding agent 运行时**：把 OpenAI Codex、Claude Agent SDK 和 OpenCode 等编程 Agent，跑在 API endpoint 后面、彼此隔离的 AI Agent 沙箱里，并提供可检查、可回放、可续跑的执行记录。它出自 **LangGenius——也就是开源 LLM 应用平台 Dify 背后的团队**，这从一开始就注定了它的工程取向：不是给个人玩家的小玩具，而是面向“要把 Agent 集成进自己产品”的开发者的基础设施。Apache 2.0 协议。

### 它解决的是哪一层痛苦

如果你要在自己的产品里用 coding agent，通常会撞上同一个坑：你需要自己维护 agent 运行时、沙箱服务、会话存储、文件管道、Agent API——每接入一种 agent harness（Codex、Claude、OpenCode……），这套东西就要重来一遍。mosoo 的定位，就是把这一整块收拢成一个**控制平面**：你的应用归属你，它拥有产品行为与最终用户体验；mosoo 只负责 Agent 的执行与生命周期。它把自己定位得很克制——“App 部署是另一个 Alpha 面，不是核心产品契约”。

### 深度解析：Agent 从「一次调用」变成「一条持续存在的执行线」

mosoo 的五个核心能力，完整对应了“把 agent 产品化”所需的每一环：

- **统一的运行时与控制平面**：三种 agent harness 被归一化到同一个运行时协议下，你不需要为每种工具写三套集成。
- **Agent API**：从一个可信后端 start / follow / continue / stop / archive / delete Agent 的工作——Agent 的工作是你可以编排的。
- **隔离的 AI Agent 沙箱**：流式返回响应与工具活动、处理权限请求、取消工作、在隔离执行环境中查看诊断信息——让“把 agent 放给用户”这件事变得安全可控。
- **持久化工作（Durable Work）**：Threads、Runs、事件与托管文件跨多次执行保留。这是它最本质的理念：Agent 不是一次性的调用，而是一条可以断点续跑的执行线。
- **可观测性**：Run 状态、可回放的活动、诊断、用量估算——运营可见性，而非合规审计。

配套生态也已经搭起骨架：`mosoo-agent-driver`、`mosoo-connector`，以及一份有意思的 `mosoo-skills`（20 个项目感知的 coding-agent skills，其中 16 个是未修改的公共上游副本，4 个由 mosoo 维护，且刻意排除在同步清单外，防止上游刷新抹掉项目特定的护栏）。技术栈上，它原生跑在 Cloudflare Workers + D1 + R2 之上，可以自托管到自己的账号里。

### 风险提示（编辑的诚实提醒）

必须提醒读者：**mosoo 目前处于 Alpha 阶段。** 官方 README 明确写道，托管运行时与 Agent API 已发布并有仓库测试覆盖，但“生产可靠性与外部采纳尚未被验证”，公开 API 与产品行为仍可能变化。因此它适合愿意吃螃蟹、在探索 agent 产品化原型的开发者；如果是要直接押在生产核心链路上，请务必先评估风险、做好隔离。

### 编辑点评

mosoo 的意义在于把“运行 coding agent”这件事从散装的 DIY 拼装，变成了一块可部署、可观察、可编排的基础设施。当整个行业都在讨论“Agent 该怎么做成产品”时，Dify 团队用自己在 LLM 应用平台上的积累，给出了一个 Cloudflare 原生的参考答案——隔离沙箱、持久会话、统一 API、按需续跑。对于正在把 Codex / Claude Agent SDK / OpenCode 扩展成自己产品的团队，它值得放进对比清单里认真评估。

## 总结：一张表看懂这一期

| 项目 | 让 Agent 拥有 | 核心哲学 | 协议/状态 | 适合谁 |
| --- | --- | --- | --- | --- |
| **yuiju** | 一颗会生活的「心」——生活轨迹、记忆、计划 | 世界先于对话；LLM 决策、系统记账 | 开源，早期成长中 | AI 陪伴玩家、研究虚拟生命的产品人与开发者 |
| **lathe** | 一双能干活的「手」——可被安全调用的 CLI 契约 | Spec 即真相，Catalog 即契约 | MIT，较成熟 | 有存量 API 想接入 Agent 的团队、CLI 与 Agent 工具爱好者 |
| **mosoo** | 一个能规模化运行的「身体」——沙箱、API、持久执行 | Agent 从调用变成一条持续的执行线 | Apache 2.0，Alpha | 把 coding agent 做成产品的开发者 |

## 写在最后

第一期，我们把三颗看似无关的星放在同一页，其实想说一件事：**AI 的下一个形态，大概不是一个更聪明的对话框，而是一个能跑、能干、能生活的「实体」。** yuiju 给了它生活，lathe 给了它双手，mosoo 给了它身体——它们分别代表了体验、接口与基础设施三个层次，而真正的未来产品，大概要同时拥有这三样。

如果你恰好也在做类似的事，或者对其中某个项目有更深的理解，欢迎留言与我们交流。下一期，我们会围绕“Agent 的记忆”这一主题，深挖更多值得被看见的开源项目。

**快速上手与体验入口**

- yuiju：仓库 `github.com/yixiaojiu/yuiju`｜在线体验 `yuiju-web.yixiaojiu.top`｜作者博客 `note.yixiaojiu.top/blog/yuiju`
- lathe：仓库 `github.com/lathe-cli/lathe`（由 samzong 发起）
- mosoo：仓库 `github.com/langgenius/mosoo`｜云端体验 `cloud.mosoo.ai`｜官网 `mosoo.ai`

**作者与团队**

| 项目 | 作者 / 团队 | GitHub |
| --- | --- | --- |
| yuiju | yixiaojiu（翊小久） | `github.com/yixiaojiu` |
| lathe | samzong | `github.com/samzong` |
| mosoo | LangGenius（Dify 团队） | `github.com/langgenius` |
