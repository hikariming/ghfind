# /feed：X 镜像、本站发帖与互动数据设计 v1

日期：2026-10-25。实现更新：2026-10-26，初版已在 dev 工作区本地实现和验证，未部署。本文保留完整设计讨论；当前已实现范围、实际端点、运行步骤与后续事项以 [Social Feed 运行说明](../operations/social-feed.md) 和 `src/lib/social-feed/contract.ts` 为准。

本版确定内容、身份、回复串、互动和接口边界。**不设计推荐算法、权重、模型或召回配额。** 下文除「现状」和引用的 X 官方字段语义外，是 ghfind 的目标契约；设计字段与初版实现有差异，不代表已全部提供或上线。

## 1. 产品约束

- 主流包含 **X 同步帖子 + ghfind 本站原创帖子**，用不可变的 `origin` 区分。顶部保留「推荐」「关注」。收藏恢复为帖子互动能力，不恢复第三个顶部频道；收藏列表由独立接口支持，具体入口后续决定。
- 镜像作者显示 **X 显示名 + @GitHub 用户名**。这里的用户名是 GitHub `login`，不是数字用户 ID；数字 ID 只用于稳定关联。
- **只有 `origin=x` 的帖子右上角显示 X 图标，链接到这条 X 原文；`origin=ghfind` 的主帖和回复均不显示 X 图标。** 判断依据是帖子来源，不是作者有没有 X 账号。正文卡片可以打开本站详情和本站回复串。
- 不添加标签、热门、新帖、职业类别、认证等装饰徽章。作者自己正文中的 `#hashtag` 原样保留，不额外提取成标签条。
- 只收集 X 内容及必要来源信息；不请求、不持久化、不展示 X 的赞、回复数、转发数、收藏数、浏览量，不抓 X 评论区。
- 本站主帖、回复、转发、点赞、收藏、浏览量、不喜欢全部独立保存于 ghfind 服务端，不发布或同步到 X；「本地」指本站持久存储，不是浏览器 localStorage。
- 公开流、帖子详情和回复串可匿名浏览，不以浏览者评分作为读取门槛；发言能力单独计算，失败不阻断浏览。个人关注流、收藏等仅为定位私人数据要求登录，不增加评分门槛。
- **本站主帖、回复、回复的回复均要求登录且本人有效 ghfind 评分 `>= 60`**，由服务器在每次发布时校验。带文字的引用帖未来开放时同样处理。点赞、收藏、不喜欢、关注和纯转发只要求登录及常规防滥用校验，不增加发帖评分门槛。
- X 镜像仍从精选作者与本站开发者中产生；按前文准入要求，X 作者身份关联成立且有效 ghfind 评分 `>= 60` 才进入推荐候选，精选不豁免。这是来源作者的资格，与浏览者评分无关。所有 60 分判断都使用未四舍五入的有效分数；59.96 不算通过。
- 评分表征 GitHub 公开贡献，不直接证明某条观点正确，也不证明 X 账号归属。

## 2. dev 现状与复用范围

核对对象：本地 `dev` 工作树及本轮之前已有的未提交界面调整，非线上验收。

| 部分 | 当前实现 | 本版处理 |
| --- | --- | --- |
| 页面 | 有 `/feed`，当前主流已限为 X 内容 | 复用页面框架和两频道布局，设计扩展本站原创帖子 |
| 内容 | `XPost` 有正文、原文链接、单媒体、引用、翻译 | 扩展为双来源 Post，新增本站发帖契约、完整正文、多媒体、来源版本和稳定内部 ID |
| 作者 | 人工名单，或关联 GitHub 评分至少 80；人工名单可无评分 | 统一为候选来源 + 关联证据 + 至少 60 分展示门槛 |
| 匹配 | 接收传入的 GitHub handle，未建立完整的简介证据与确认状态 | 独立身份关联记录，不能仅凭名字相同确认 |
| 排序 | 已有原型规则，包含 X 热度、标签兴趣等 | 不沿用这些数据依赖；新算法待设计 |
| 保存 | 一个 KV 文档，30 天 TTL；滚动窗口最多 240 条、每作者 4 条 | 正文与互动持久保存；推荐窗口只是可重建查询结果 |
| 互动 | 赞、收藏、关注、看过等主要在本地 Zustand 状态 | 后端事实源，前端只做缓存与乐观更新 |
| 回复 | X 帖子可指向开发者个人页的评论线程 | 统一帖子模型，每条推文拥有独立本站回复串 |

实现入口：`src/lib/stream/x.ts`、`src/lib/x-timeline.server.ts`、`src/lib/pages/feed-x.ts`、`src/lib/stream/store.ts`、`src/lib/stream/rank.ts`、`src/components/stream/StreamComments.tsx`。

仓库另有 `/api/feed/projects` 项目推荐系统和 `docs/contracts/feed-v1.md`。它不是本次 X 帖子流的数据契约。可复用身份验证、幂等处理和分页经验，不能把项目标签、项目评分或项目事件直接当成帖子字段。本版拟用 `/api/feed/posts` 与之区分。

## 3. 采用 X 的帖子关系语义

X 官方公开了帖子对象和对话关系，未据此核实到它的完整生产数据库 DDL。因此本版对齐**可核实的对象与关系语义**，物理表和本站扩展由 ghfind 自己定义。

官方语义：同一串中，无论回复多少层，`conversation_id` 都指向发起对话的原帖；`referenced_tweets` 中 `replied_to` 指向直接父帖；`in_reply_to_user_id` 指向被回复者。见 [X Conversation ID](https://docs.x.com/x-api/fundamentals/conversation-id)。

ghfind 的核心也是：**回复是一条 Post，不是挂在某个开发者身上的评论。**

```text
P0  X 镜像或本站原创主帖         conversation_id=P0，parent=null
├─ P1  回复 P0                  conversation_id=P0，parent=P0
│  └─ P2  回复 P1               conversation_id=P0，parent=P1
│     └─ P3  回复 P2            conversation_id=P0，parent=P2
└─ P4  另一条回复 P0            conversation_id=P0，parent=P0
```

- P0 到 P4 都有独立 ID、作者、正文、时间、状态和互动，可以独立打开详情、点赞、收藏、转发、继续回复。
- 数据层不固定为二级评论。界面可用连接线和「展开回复」展示分支，避免无限向右缩进。
- `parent_post_id` 是直接回复关系的唯一写入事实；API 的 `referenced_posts: [{type: "replied_to", id: ...}]` 由它生成，不保存两份可冲突的父子关系。
- `conversation_id` 是加速查询的根引用，由服务器根据父帖计算，客户端不能指定。根帖等于自身 ID；父帖必须存在且属于同一串；父关系创建后不可改写，不能出现环。
- `in_reply_to_author_id` 可以从父帖派生，返回给客户端显示「回复 @某人」，不能从正文中的 `@` 推断。
- 回复详情先返回祖先路径，再分页取直接子回复；不一次返回整棵树，也不按全串时间排序冒充层级。
- 删除中间回复保留 ID 和父子结构，正文变为删除占位，子回复仍接在原位置。审核隐藏按可见性规则处理，不重挂父节点。

**X 的 `source.conversation_id` 与本站 `conversation_id` 是不同命名空间。** X 的已有评论不会因为知道了其 conversation ID 就被抓取或混入本站讨论。

## 4. 作者、身份与评分

分开维护以下事实，避免把公开身份匹配当作登录授权：

| 记录 | 核心字段 | 约束 |
| --- | --- | --- |
| `feed_authors` | `id`, `github_user_id`, `github_login`, `display_name`, `avatar_url`, `updated_at` | `github_user_id` 唯一且为字符串；改名更新 login，不更换作者 ID |
| `feed_x_accounts` | `x_user_id`, `handle`, `display_name`, `avatar_url`, `profile_url`, `observed_at`, `source_status` | X ID 稳定；handle/显示名可变；不存粉丝数等互动信号 |
| `feed_identity_bindings` | `id`, `x_user_id`, `author_id`, `status`, `method`, `evidence_url`, `evidence_excerpt`, `checked_at`, `confirmed_at`, `revoked_at` | `status=pending/confirmed/rejected/revoked`；一个 X 账号最多一个当前有效绑定 |
| 作者来源记录 | `author_id`, `source=editorial/platform`, `added_at`, `removed_at` | 两种来源可同时存在，不赋予评分豁免 |
| 评分引用/投影 | `author_id`, `score`, `score_record_id`, `score_version`, `scored_at`, `eligibility_version` | 引用本站成功保存的有效评分；不能让采集器上传一个自报分数 |

匹配建议：X 简介中的明确 GitHub 链接用于生成候选；双向公开链接、本人经双方认证绑定、或人工核实证据可确认。单向链接仍可能冒用，简介身份描述、相似姓名只做辅助，发生冲突进入待确认状态。

被镜像作者不需要先注册 ghfind。镜像绑定也不自动赋予任何登录用户修改该作者资料或代其回复的权限；本站发帖权限绑定现有已验证登录身份。

展示时，镜像帖子用关联的 X 显示名与头像，配 GitHub login；缺头像再回退 GitHub 头像。本站主帖和回复用发布者自己的站内显示名与头像，配 GitHub login；不要求绑定 X。即使作者已绑定 X，本站帖子仍无 X 来源图标。正文里贴了 X 链接也不改变 `origin`。

浏览权限、发布权限、来源作者准入分别处理：公开 GET 不以浏览者分数限制读取；本站每次发布主帖或任意层级回复时，校验登录用户本人评分；X 镜像作者按独立准入规则处理。评分下降、缺失或评分服务暂不可用会阻止新的本站发布，不追溯删除已合法发布的正文、点赞、收藏或回复，也不阻止该用户继续浏览。X 镜像作者失去准入资格时退出推荐候选，但不是让低分浏览者看不见。详情是否可读由内容公开、删除和审核状态决定。本站历史帖后续如何排序本版不设计，不能把发布权限检查误用到阅读接口。

本站发帖使用当前有效评分记录，并记录 `publisher_user_id`、`score_at_publish`、`publication_score_record_id`、`publication_score_version`、`publication_policy_version` 作为发布依据；不使用客户端提交的 score，也不使用他人 GitHub handle 代查授权。缺评分返回明确的需要评分状态；评分服务不可用与低于 60 分分别处理。低分或评分缺失者仍可删除自己的帖子，不能因失去发布资格而失去删除权。

## 5. Post 主记录：保存什么

所有 ID 在 JSON 中使用字符串，时间使用 UTC ISO 8601。下面是**存储逻辑对象**，可以拆成表与关联表；不是要把整个对象塞进一个 KV 文档。

```json
{
  "schema_version": 1,
  "id": "pst_demo_root",
  "author_id": "aut_demo_author",
  "origin": "x",
  "kind": "original",
  "conversation_id": "pst_demo_root",
  "parent_post_id": null,
  "quoted_post_id": null,
  "content": {
    "text": "这里保存 X 原文，包含原有换行、链接和作者自己写的 #hashtag。",
    "language": "zh",
    "format": "plain_text",
    "completeness": "complete",
    "entities": [],
    "media": []
  },
  "source": {
    "platform": "x",
    "post_id": "9000000000000000001",
    "edit_history_post_ids": ["9000000000000000001"],
    "author_id": "9000000000000000002",
    "author_handle_at_fetch": "example_x",
    "author_name_at_fetch": "Example Developer",
    "url": "https://x.com/example_x/status/9000000000000000001",
    "conversation_id": "9000000000000000001",
    "references": [],
    "availability": "public",
    "first_fetched_at": "2026-10-25T08:10:00Z",
    "last_checked_at": "2026-10-25T08:10:00Z"
  },
  "published_at": "2026-10-25T08:00:00Z",
  "created_at": "2026-10-25T08:10:00Z",
  "updated_at": "2026-10-25T08:10:00Z",
  "content_version": 1,
  "content_hash": "sha256:<normalized-content-hash>",
  "status": "published",
  "reply_policy": "scored_member",
  "deleted_at": null
}
```

示例名字和 ID 均为虚构。`id` 是本站稳定 ID；`source.post_id` 是当前镜像版本对应的 X ID；`source.url` 必须与它匹配。来源 ID 不能使用 JS number，避免大整数精度丢失。

`origin=x/ghfind`，`kind=original/reply/quote`。初版支持采集器创建 X 镜像，以及符合发布资格的登录用户创建本站主帖和任意层级回复。站内引用帖的数据结构兼容，入口后续实现；开放时同样执行发布评分门槛。

来源约束必须由服务端和存储层共同保证：

| 来源 | 创建入口 | 来源字段 | 右上角 |
| --- | --- | --- | --- |
| `x` | 受保护的内部采集入口 | `source` 必填，来源账号和原文 ID/URL 一致 | X 图标，跳转此帖原文 |
| `ghfind` | 本站用户发布入口 | `source=null`，展示 DTO 的 `original_url=null` | 不显示 X 图标 |

用户发帖 API 只接收正文和媒体引用，不接收 `origin/source/author_id/status/score/published_at/conversation_id`；作者、来源、发布时间和主帖根 ID 由服务器产生，非法额外字段直接拒绝。发布后 `origin` 不可修改；采集器只能更新对应 X 记录，不能覆盖本站帖子。本站发帖不要求 X 登录或授权，没有 X 发布任务、回写队列或同步开关。

本站主帖示例（省略与前例相同的通用字段）：

```json
{
  "id": "pst_demo_native",
  "author_id": "aut_demo_member",
  "origin": "ghfind",
  "kind": "original",
  "conversation_id": "pst_demo_native",
  "parent_post_id": null,
  "source": null,
  "content": {"text": "这条内容直接发布在 ghfind。", "media": [], "entities": []},
  "publisher_user_id": "usr_demo_member",
  "score_at_publish": 72.5,
  "publication_score_record_id": "score_demo_member",
  "publication_score_version": "current-score-version",
  "publication_policy_version": "feed-publish-v1",
  "reply_policy": "scored_member",
  "status": "published"
}
```

`reply_policy=scored_member` 表示本站回复按集中定义的发帖资格校验，不是把 X 的 reply settings 同步为本站权限。发表主帖/回复时，服务器解析当前登录用户为作者，解析其当前有效评分并与政策版本一起记录；正文、发布记录及 `post_created`/`reply_created` 事件在同一事务提交。

### 正文和附件

- 保存完整原文；长文读取来源提供的完整文本，不能沿用当前 1,200 字符静默截断。`completeness=partial` 标识未取全的内容，待补全后再进入推荐候选。X 官方对象提供 `note_tweet` 等长文内容字段，见 [X Data Dictionary](https://docs.x.com/x-api/fundamentals/data-dictionary)。
- `entities` 只记录正文渲染需要的链接、提及等位置及目标；约定 offsets 为 Unicode code point 索引，适配器统一转换，避免 emoji 导致错位。链接用安全 URL 渲染，原始 HTML 不直接执行。
- 本站上传的媒体通过本站资产 ID 引用，发布时检查上传者归属和资源可用性，不接受任意他人的资产 ID。镜像内容的媒体来源和本站上传资产分开标记。
- `media[]` 支持图片、视频、GIF，字段为 `id`, `type`, `source_url?`, `asset_key?`, `preview_url?`, `alt_text?`, `width?`, `height?`, `duration_ms?`, `position`, `availability`。无媒体时空数组；不收集媒体播放数。是否托管文件可在后续采集方案决定。
- 投票只保留问题/选项等内容，不同步投票人数或结果；不支持的附件保存类型和来源入口，不能伪装完整镜像。链接预览、翻译是独立派生数据，可失败，不覆盖原文。
- 翻译按 `(post_id, content_version, target_language)` 保存，附 `status/provider/generated_at`。原文改动后旧译文不得直接显示为新版翻译。
- 不设置 `tags`、`hot`、`technical_score` 或 X `metrics` 字段。未来内容特征放独立版本化特征接口，不污染原文。

### 来源引用与作者自串

- 普通 X 评论、对别人的回复、纯转推不进入初版镜像采集。原作者给自己续写的 thread 可按同一作者内容处理：只采该作者续帖，不扩展抓取旁人的回复。未确认父子链和作者一致性前保持待补全。
- 自串中的镜像续帖用本站 `parent_post_id/conversation_id` 连接到已镜像原帖；保留各条独立原文链接。同一串主流如何折叠，留给后续展示和 feed 接口。
- 引用推文保留合格作者自己写的部分和被引用帖的 ID/URL。被引用者未通过准入时，只给来源链接，不自动抓其正文绕过门槛；若已独立入库且可见，可通过 `quoted_post_id` 展示引用卡。
- 来源关系放 `source.references`，例如 `{type:"quoted", post_id:"...", url:"..."}`；来源中未镜像的 ID 不能写进本站父帖外键。

### 编辑、重抓、删除

- 来源版本 ID 建唯一索引，重复抓取幂等。另存 `feed_x_post_versions`：`x_post_id → local_post_id/content_version`。原文有编辑链时将各来源版本绑定到同一本站逻辑帖子，本站互动不因原文编辑丢失。
- X 编辑会产生新的来源 ID，官方说明见 [X Edit Posts](https://docs.x.com/x-api/fundamentals/edit-posts)。本地映射必须使用来源提供的编辑链证据，不能仅靠相似文本合并两条推文。
- 原文版本保存内容快照及 hash；本站回复保存 `parent_content_version`，至少可识别它回复时看到的版本，避免原文改写后误解回复。时间线展示当前版并标明已编辑。
- 来源状态区分 `public/deleted/protected/unavailable`。网络失败只更新同步结果，不直接认定删除。确认删除或转私密后停止公开原文、使缓存失效，回复串保留不可用原帖占位；不允许通过旧版本接口继续读到被撤回正文。
- `status=published/hidden/deleted/pending` 表示本站状态，与来源是否公开、推荐资格分别处理。重新同步不能解除管理员隐藏。
- 采集入口采用字段白名单，不将含互动数据的完整 X 响应写进 raw payload、日志、队列或备份。数据库不设 X 指标兜底字段。

## 6. 回复、转发和互动事实

下面三条记录足以形成回复及回复的回复；所有引用都是本站 ID：

```json
[
  {"id":"P0","origin":"x","kind":"original","conversation_id":"P0","parent_post_id":null},
  {"id":"P1","origin":"ghfind","kind":"reply","conversation_id":"P0","parent_post_id":"P0"},
  {"id":"P2","origin":"ghfind","kind":"reply","conversation_id":"P0","parent_post_id":"P1"}
]
```

回复的其余正文、媒体、作者、版本、时间和状态字段与 Post 相同；本站回复固定 `origin=ghfind, source=null`。回复 X 镜像不会继承 X 来源或 X 图标。每次创建回复，服务端都核验当前用户登录与有效评分至少 60、父帖、根帖和可见性，并返回完整对象；校验不受回复层级影响。

| 能力 | 保存方式 | 拟定语义 |
| --- | --- | --- |
| 点赞 / 不喜欢 | `feed_reactions(user_id, post_id, value, created_at, updated_at)`；唯一 `(user_id,post_id)` | `value=like/dislike`；取消删除当前关系；两者互斥。不喜欢是个人反馈，可撤销；不展示踩数，不直接触发全站下架 |
| 收藏 | `feed_bookmarks(user_id, post_id, created_at)`；唯一 `(user_id,post_id)` | 私人关系，支持取消和跨设备恢复；公开卡片不展示谁收藏，也不暴露收藏总数 |
| 转发 | `feed_reposts(id, user_id, post_id, created_at, deleted_at)`；每人每帖最多一个有效转发 | 本站转发引用已有内容，不复制正文；可撤销。转发者与原作者分开显示，不变成转发者的原创 |
| 回复 | `feed_posts` 的 `kind=reply` | 任意层级；独立身份、状态和互动；不复用 profile-comments 的线程 key |
| 浏览量 | 有效浏览事件 + `feed_view_dedup` + 聚合 | 只计本站；请求返回不等于看见；重复刷新不无限累计 |
| 关注 | 复用可验证的本站关注事实，稳定目标为 `author_id` | 不同步 X 关注；不再以可变 handle 为关系主键；若现有服务不兼容则加适配层 |
| 举报 / 屏蔽 | 独立 moderation/report 或用户屏蔽关系 | 作为治理扩展预留；不将「不喜欢」当举报 |

转发是有 actor 和时间的分发活动，API 可投影成 `referenced_posts: [{type:"retweeted", id:...}]`；数据库仍只存一个转发事实，不同时双写另一条独立正文。引用转发（带自己的文字）未来用 `kind=quote + quoted_post_id`，它有自己的讨论串，不能与纯转发混为一谈。

两种来源的帖子（包括本站回复）共用本站互动能力。初版 `/feed` 主流候选包含符合来源准入的 X 镜像、成功通过发布校验的本站主帖，以及这些帖子的本站转发活动；本站回复保留在回复串，不因为可互动就自动变成独立推荐主帖。纯转发不改变目标帖来源：转发 X 镜像时原帖卡片显示 X 图标，转发本站帖子时不显示；未来的本站引用帖外层不显示 X 图标，内部引用的 X 卡片可有自己的原文入口。

### 计数与幂等

- `feed_post_stats` 是可重建投影，不是唯一事实：`post_id`, `like_count`, `repost_count`, `direct_reply_count`, `qualified_view_count`, `version`, `updated_at`。
- `feed_conversation_stats` 单独保存 `conversation_id, visible_reply_count`。根帖卡片可展示全串回复数；回复节点的展开按钮使用直接子回复数，字段不混用。两类计数都只包含本站可见回复，X 自串续帖不算本站互动回复。
- 写操作用明确目标状态，例如 `PUT reaction {value:"like"}`、`DELETE reaction`，避免重试 `toggle` 翻转两次。创建回复/转发要求幂等 key；相同 key 不同 payload 返回冲突。
- 关系变更、计数调整和内部事件/outbox 在同一事务提交。失败不显示成功；异步投影消费者按事件 ID 去重，支持重放修复，不能靠客户端 `count+1` 当事实。
- 浏览拟定为卡片达到可见面积门槛且前台持续停留后计一次，阈值独立配置。初始口径可用至少 50% 可见持续 2 秒；超高长帖用视口可见区域作基准，避免永远达不到门槛。
- 按 `(actor_key, post_id, UTC_date)` 去重。登录用户使用服务端身份；访客使用受限、可轮换的匿名站内标识，不用 IP 指纹。不能保证识别跨设备同一个人，所以对外称浏览量，不称独立真人数。匿名转登录也不宣称完全去重。
- 服务端签发并校验 view token，过滤明显机器人和异常频率。投递重试必须复用 event ID；dedup key 至少覆盖该统计日加重试窗口，删除过期 key 后不能接受旧日期重放。
- 收藏列表、不喜欢记录、当前用户状态仅对本人返回。包含这些字段的响应不进入共享公共缓存。

## 7. 返回给卡片的格式

存储事实与展示 DTO 分开。下例是组装后的公开内容 + 当前用户状态，不要求落一张大表。

```json
{
  "id": "pst_demo_root",
  "origin": "x",
  "kind": "original",
  "author": {
    "id": "aut_demo_author",
    "name": "Example Developer",
    "github_login": "example-dev",
    "avatar_url": null,
    "profile_url": "/zh/u/example-dev"
  },
  "text": "这里是原文。",
  "media": [],
  "published_at": "2026-10-25T08:00:00Z",
  "content_version": 1,
  "conversation_id": "pst_demo_root",
  "referenced_posts": [],
  "original_url": "https://x.com/example_x/status/9000000000000000001",
  "permalink": "/zh/feed/post/pst_demo_root",
  "metrics": {
    "origin": "ghfind",
    "likes": 12,
    "reposts": 2,
    "direct_replies": 3,
    "conversation_replies": 7,
    "views": 128
  },
  "viewer": {
    "reaction": null,
    "bookmarked": false,
    "reposted": false,
    "following_author": false,
    "can_reply": true,
    "cannot_reply_reason": null
  }
}
```

`viewer.can_reply` 必须由服务端结合登录、当前本人评分、回复政策和帖子的可见状态计算；不足 60 分或未评分时为 false，给出 `score_required/score_below_threshold`，评分暂不可查为 `score_unavailable`。按钮置灰不能代替 POST 接口校验。

`permalink` 是拟议详情地址，不表示现在已注册此路由。`metrics` 从始至终是本站互动投影；匿名访问 `viewer=null`。卡片不传 `hot/tags/badge`。内部评分信息放候选接口，不为未来推荐额外堆 UI 字段。本站转发通过外层 `activity {id, type:"repost", actor, created_at}` 包裹此卡片，原作者信息保持原义。

## 8. 只为后续算法保留接口

本节没有排序公式或模型选型。先固定责任：**内容服务提供事实与硬门槛，算法插件只产生顺序，投递服务最后复核权限和资格。**

| 接口 | 输入 / 输出 | 责任 |
| --- | --- | --- |
| `CandidateRepository.list`（内部） | channel、viewer context、时间范围、cursor → candidate IDs + facts | 覆盖 X 与本站两种来源，按内容公开状态和来源准入过滤；含 origin、作者稳定 ID、原始发布时间、作者评分及版本、内容版本、conversation ID、活动类型；不以浏览者评分过滤，不带 X 指标 |
| `FeatureProvider.batchGet`（内部） | post IDs、viewer、feature version → optional features + as_of | 将未来派生特征与正文隔离；缺失值显式 unknown，不默认当 0；首期可不实现 |
| `FeedRanker.order`（内部可替换） | candidates、viewer context、request time、version → ordered candidate IDs + algorithm version | 不写正文、互动和用户状态；输出必须是传入集合的合法 ID，不能自建候选绕过门槛；实现待后续设计 |
| `FeedDelivery.create/page`（内部） | ordered IDs、当前权限/资格版本 → hydration + session/cursor | 去重、复核当前可见性/门槛，签发稳定分页与浏览 token；不能信任旧快照资格 |
| `FeedFeedback.accept`（内部） | 经服务端验证的本站事件 → accepted/duplicate | 与持久互动事实衔接；算法如何消费事件留待后续设计 |

候选必须带 `post_id`, `origin`, `author_id`, `conversation_id`, `content_version`, `published_at`, `eligibility_version`，以及来源对应的资格依据。作者当前评分通过 `score_record_id/score/score_version` 提供，缺失明确为 unknown；本站历史帖另保留发布时评分依据，不能将暂时无法读取当前评分当成历史发布无效。活动候选另带 `activity_id/actor_id/activity_at`。转发不改写原帖发布时间，作者评分始终取原作者，不能取转发者或浏览者分数冒充作者分数。

未来事件信封建议：`event_id`, `event_type`, `post_id`, `content_version`, `occurred_at`, `received_at`, `surface`, `feed_session_id?`, `served_item_id?`，加服务端解析的 actor。事件类型区分 `post_created/reply_created/served/impression/qualified_view/open_detail/open_original/reaction_changed/bookmark_changed/repost_changed/follow_changed`；撤销也要表达。身份、位置和页面投递关系由服务端验证，不能相信客户端自报已点赞或已经排到第几位。

在同一 feed session 中固定已选顺序，cursor 绑定用户/匿名会话、channel、版本、过期时间。新内容通过刷新进入新 session；翻页仍检查删除、屏蔽和资格变化。响应可返回 `algorithm_version`, `degraded`, `next_cursor`，不向公开客户端暴露私有特征或原始排序分。

保留接口示意：

```text
POST   /api/feed/posts                     {text, media_ids}
GET    /api/feed/publishing-capabilities
DELETE /api/feed/posts/:id                  本站作者删除自己的帖子
GET    /api/feed/posts?channel=recommended|following&cursor=...
GET    /api/feed/posts/:id
GET    /api/feed/posts/:id/ancestors?cursor=...
GET    /api/feed/posts/:id/replies?cursor=...
GET    /api/feed/conversations/:id?cursor=...
POST   /api/feed/posts/:id/replies
PUT    /api/feed/posts/:id/reaction          {value: "like" | "dislike"}
DELETE /api/feed/posts/:id/reaction
PUT    /api/feed/posts/:id/bookmark
DELETE /api/feed/posts/:id/bookmark
PUT    /api/feed/posts/:id/repost
DELETE /api/feed/posts/:id/repost
GET    /api/feed/me/bookmarks?cursor=...
POST   /api/feed/post-events
```

`POST /api/feed/posts` 只创建本站主帖，固定 `origin=ghfind, kind=original, source=null, conversation_id=id`；`POST /api/feed/posts/:id/replies` 使用同一正文输入并执行同一发布资格校验，父帖/根帖关系由服务器推导。两个入口都要求 `Idempotency-Key`，重复请求不重复发帖；同 key 不同内容返回冲突。对于已成功提交的请求，重试先验证调用者身份与原请求归属，再返回原结果；不因评分随后下降而重复创建或否认已发布事实。受保护的 X 采集入口继续独立存在，普通用户不能调用来冒充镜像。

`GET /api/feed/publishing-capabilities` 返回 `can_publish/can_reply/minimum_score/reason/policy_version`，供编辑框解释状态；未登录返回不可发布及 `authentication_required`，不影响内容读取；读取失败不影响公开浏览，提交仍重新核验，不信任之前的能力结果。建议错误口径：未登录 401；缺评分或低于 60 为 403（不同 error code）；评分服务暂不可用为 503；幂等冲突 409。低分用户删除自己已发的本站帖子不检查发布分数，但仍检查作者所有权；无法删除他人或采集器的 X 镜像。

`post-events` 只接收允许的客户端观察事件；赞/收藏/回复等变更事件由相应后端事务产生，不能通过 event API 冒充。公开流、帖子及回复读取不以浏览者登录或评分设门槛；个人关注/收藏读取只为定位用户数据要求登录。所有互动写入要求实际登录和防滥用校验，其中创建主帖和任意层级回复额外要求本人有效评分至少 60，纯互动不套用发帖门槛。浏览事件按独立的匿名策略处理。回复分页按父帖查子节点；全串接口返回带 parent ID 的平面节点分页，不伪装为一次拿到了完整回复树。

## 9. 落库与迁移准备

初版可沿用现有关系型存储能力承载上述事实，KV 只做可重建缓存。本设计不要求引入新的数据库、消息系统或推荐库；实际库绑定和迁移文件在实施时确定，不与已有项目 Feed 表混用。

必须的索引/约束：

- 来源版本唯一 `feed_x_post_versions(x_post_id)`，所有版本映射到一个稳定 `post_id`。
- `origin=x` 必须有有效 X 来源记录；`origin=ghfind` 的来源记录为空。两者不可互换，X 采集更新和本站作者更新有独立写入权限；本站发布必须有可核验的发布资格记录。
- 回复索引 `(parent_post_id, published_at, id)`、全串索引 `(conversation_id, published_at, id)`、作者索引 `(author_id, published_at, id)`。
- 关系唯一 `(user_id, post_id)`；有效转发唯一；收藏列表索引 `(user_id, created_at, post_id)`。
- 幂等命令按 actor + operation + idempotency key 唯一，保存 payload hash；事件 `event_id` 唯一。
- 关键删除/隐藏和身份绑定变更使缓存与推荐资格失效。主帖退出推荐不能级联删除用户互动。

迁移边界：

1. 已有真实 X 记录按来源 ID 导入，但只保留允许的内容字段；演示数据不作为真实内容、身份或互动导入。
2. 补齐不可变作者 ID、身份关联与有效评分，再计算推荐资格。不能继承旧 80 分名单例外、X 热度或技术标签门槛。
3. 旧个人页评论继续归个人页，不迁成某条推文回复。旧 localStorage 互动不能直接转成可信全站计数；若后续提供个人收藏迁移，需要用户登录、来源校验且走幂等写入。
4. 前端改用双来源 Post DTO，去掉 `metrics` 的 X 来源、标签与热门展示；只为 X 镜像显示右上角原文图标，本站帖子不显示。新增本站发帖入口及服务器资格提示。
5. 核验匿名及低分用户可读、未登录/59.96 分/未评分用户不能发帖或回复、60 分用户可发主帖和任意层级回复、来源不能伪造、本站发布不产生 X 外发任务；同时核验编辑不丢互动、重试不重复、跨设备一致、删除不破坏回复链、用户私密状态不进公共缓存，之后再接算法实现。

## 10. 本轮参考材料

在用户已打开的 X 文章中，看到《[如何改善原创内容的流量｜X 排序算法分析](https://x.com/ZengwuY/article/2099856153371156885)》，页面显示 Bookmarked。这很可能是用户提到的收藏；未据此断言它是唯一目标文章。

另外核对了 [X 官方推荐算法仓库](https://github.com/xai-org/x-algorithm)：内容资格过滤与排序是不同环节。本版仅借此保留接口边界，不移植它的模型或互动权重。

本轮产物只有设计文档；未改变当前 UI、采集器、数据库或排序实现。
