# Social Feed 初版

`/feed` 现在接入独立的 Social Feed 存储与 API；旧项目 Feed 表继续服务原功能。设计背景见 [数据设计](../plans/2026-10-25-x-feed-data-model.md)，运行时 DTO 以 `src/lib/social-feed/contract.ts` 为准。

## 当前边界

- 主帖、任意层回复、图片、点赞/不喜欢、私有收藏、转发、关注和浏览均保存到本站数据库。匿名可浏览；写内容要求已验证 GitHub 登录和当前有效分数至少 60。普通互动只需登录。
- X 与本地帖子共享阅读和互动结构，`origin` 决定是否显示 X 原帖链接。X 导入严格拒绝互动指标和未知字段，旧 `/api/internal/x-timeline` 写入入口返回 410。
- 推荐与关注目前按时间排序；关注包含关注作者的原帖与转发。`SocialFeedProvider` 可替换读取实现，`social_feed_events` 保存站内内容/互动事实供后续消费。目前没有个性化推荐、模型或分数加权算法。
- 原生文字最多 5000 个 Unicode 码点，最多 4 张图片，每张最多 10 MiB（PNG/JPEG/GIF/WebP）。本轮不提供视频、投票或原生编辑。X 内容更新保留版本与已有本站互动。
- 浏览是页面可见且卡片至少一半可见持续 2.2 秒后上报，服务端检查投递 token、登录身份或匿名 cookie、时间和每日唯一约束。匿名删除 cookie 可改变访客身份，因此不是精确独立人数或反作弊审计。
- 收藏、不喜欢不公开；点赞与不喜欢互斥。删除原生内容保留树结构占位。详情深链是 `/feed?post=<id>`，回复可继续打开下一级，不无限缩进。

## 本地运行

```sh
node scripts/social-feed-local.mjs prepare
# Astro 的服务端页面有独立的本地 D1，也需要初始化：
pnpm --filter @ghfind/web exec wrangler d1 migrations apply GHFIND_D1 --local
pnpm --filter @ghfind/web exec wrangler d1 migrations apply GHFIND_FEED_D1 --local
node scripts/social-feed-local.mjs api
# 在另一终端运行：
LEGACY_ORIGIN=http://127.0.0.1:8791 pnpm --filter @ghfind/web dev --host 127.0.0.1
```

可运行 `node scripts/social-feed-local-smoke.mjs` 对隔离 API 做真实 D1/R2 联调；它明确创建虚构测试账号的本地评分和带「本地联调样例」前缀的帖子，不适用于任何远程环境。

打开 `http://127.0.0.1:4321/feed`。脚本在 `.wrangler/social-feed-local/` 建立独立 D1/R2 状态及临时本地签名密钥，不加载仓库的远程凭据、不写远程数据库。密钥文件权限为 0600，目录被 git 忽略。默认不注入演示帖子；未配置 GitHub OAuth 时本地页面只能匿名浏览。测试可以用原有签名协议生成隔离测试会话，不增加应用登录后门。

Astro 页面读取的本地数据位于 `apps/web/.wrangler/state`，与上述 API 测试库分开；完成迁移后，没有项目或评分数据时显示空态。开发服务和 `astro check` 分别使用 `.vite-dev` 与 `.vite-sync` 缓存，检查不会清理运行中的依赖文件。

所有 `/api` 代理到本地 API 后，其它未迁移 API 可能返回 404。测试完其它产品功能时可按原开发方式重启 Astro，不要在联调期间把 Feed 写操作代理到远程部署。

## 数据与部署准备

部署前需要在目标环境应用 `migrations-feed/0016_social_posts.sql` 与 `0017_social_post_translations.sql`（通过现有 `migrations-feed` 迁移流），设置 API Worker 的 `GHFIND_FEED_D1`、核心评分库 `GHFIND_D1`、原有 OAuth 配置和 `AUTH_SECRET`。

媒体使用独立 `SOCIAL_FEED_MEDIA` R2 绑定；**部署 API 前必须先创建空桶**：staging `ghfind-social-media-dev`、生产 `ghfind-social-media`，并确认 Worker 绑定名是 `SOCIAL_FEED_MEDIA`（不要复用 `ghfind-next-cache`）。本仓库不在云上自动建桶。本轮仅用本地模拟桶验证，未创建远程桶、执行远程迁移或部署。R2 私有，图片由 API 检查归属/帖子可见性后读取。未发布草稿媒体仅上传者可读，取消草稿后的孤立媒体清理任务尚未接入。

写路径 kill switch（默认关）：`SOCIAL_FEED_PUBLISH_ENABLED`、`SOCIAL_FEED_INGEST_ENABLED`（unset/`0`/`false`/`off` = 关；关时写入口返回 `503 feature_disabled`）。读路径保持可用。上线顺序：迁移 → 部署（读开、写关）→ 配好 `SOCIAL_FEED_INGEST_SECRET` 与 R2 → 先开 ingest → 再开 publish。

发布资格还核对评分对应完整扫描快照中的 GitHub 固定账号 ID，并验证快照 hash，避免用户名被重新注册后继承他人评分。旧快照没有固定 ID 时返回 `score_identity_required`，需本人重新扫描；浏览和普通互动不受影响，已导入 X 帖子的展示也不受影响。TS 与 Go 采集器均已补充该事实字段，不改变评分公式。发布资格接受当前 Node collection v6 与 Go 独立 collection v5（版本关系见 [采集发布说明](../releases/v13-v12-v6-rollout.md)），两者均要求当前评分版本、完整扫描和匹配的固定 ID；旧历史记录不会因 v5 标签被当成有效发布资格。

X 导入需要独立的 `SOCIAL_FEED_INGEST_SECRET`（至少 32 字符；列入 ghfind-api 生产 secrets 清单与 `.env.example` 变量名；勿复用 `ADMIN_SECRET`）。生产页面和 API 请求同源；如开发代理改变目标 origin，可显式设置唯一可信页面 origin `SOCIAL_FEED_PUBLIC_ORIGIN`，不能用请求头任意扩展许可域。

## X 内容导入

`POST /api/internal/social-feed/x-posts`，`Authorization: Bearer <ingest secret>`。只允许受信采集器/人工审核工具调用；普通发帖者不能自行声明镜像来源或分数。

```json
{
  "author": {
    "github_user_id": "12345",
    "github_login": "developer",
    "name": "Developer",
    "avatar_url": null
  },
  "source": {
    "post_id": "2090000000000000001",
    "author_id": "98765",
    "url": "https://x.com/developer/status/2090000000000000001",
    "display_name": "Developer on X",
    "avatar_url": null,
    "edit_history_post_ids": ["2090000000000000001"],
    "evidence_url": "https://github.com/developer",
    "evidence_method": "editorial_review",
    "evidence_checked_at": "2026-10-25T12:00:00.000Z"
  },
  "text": "Original text",
  "media": [],
  "published_at": "2026-10-25T11:00:00.000Z"
}
```

采集器必须先审核不可变 X/GitHub 账号 ID 的归属证据，`evidence_method` 可为 `editorial_review` 或 `reciprocal_links`；资料中单向写一个 GitHub 用户名不是自动认证。API 存储证据并检查绑定一致性。X 来源账号由人工/采集器策展，评分只作溯源、不作写入门槛：作者有当前合格评分时记录真实评分证据；没有评分、评分低于 60、评分版本或扫描过旧、快照缺少 `github_user_id`，或核心评分库暂不可用时，仍写入并标记为 `policy_version=social-feed-x-curated-v1`、`score_version=unscored`、`score_record_id=x-curated:<login>`（`publication_score` 仅因表约束填 60 占位，不代表真实分数，也不授予本站发帖资格）。此接口本身不联网抓取个人简介；真实账号名单、X 数据获取渠道、定时采集与原帖删除核对属于后续采集器接入工作，当前没有自动同步承诺。

## 多语言正文（译文）

X 帖子正文可以按站点 9 个语言（`zh en ja ko es pt id vi ar`）保存译文。译文在写入时生成（运营 agent 每小时写入 `ghfind-feed-dev` D1 时用 DeepSeek 翻译），读取时不调用任何模型。命名与 `job_translations`、`sponsorship_translations` 一致：`<实体>_translations` + `locale` 列 + 按页面语言 `LEFT JOIN`。

### 表结构（`migrations-feed/0017_social_post_translations.sql`）

```sql
ALTER TABLE social_feed_posts ADD COLUMN source_lang TEXT;  -- 可空；原文语言，小写 BCP 47（如 en、zh-hans）
CREATE TABLE social_feed_post_translations (
  post_id TEXT NOT NULL REFERENCES social_feed_posts(id),
  content_version INTEGER NOT NULL,           -- 对应 social_feed_posts.content_version
  locale TEXT NOT NULL CHECK(locale IN ('zh','en','ja','ko','es','pt','id','vi','ar')),
  text TEXT NOT NULL,                          -- 译文
  source_lang TEXT,                            -- 翻译时识别的原文语言
  model TEXT,                                  -- 如 deepseek-chat
  provider TEXT,                               -- 如 deepseek
  updated_at TEXT NOT NULL,
  PRIMARY KEY(post_id, content_version, locale),
  FOREIGN KEY(post_id, content_version) REFERENCES social_feed_post_versions(post_id, content_version)
);
```

`content_version` 沿用帖子已有字段：X 正文或图片变化时自增，并在 `social_feed_post_versions` 留档。外键保证译文只能挂在真实存在的版本上。

### 运营 agent 写入方式

任选其一，推荐 1 或 2：

1. **随帖子一起写**：`POST /api/internal/social-feed/x-posts` 增加可选字段 `source_lang` 与 `translations`（键必须是 9 个站点语言之一，未知键整单 400 `invalid_locale`，不会静默丢弃）。帖子与译文在同一个 D1 batch 中写入；译文只有在帖子当前正文仍等于本次 `text` 时才落库，乱序到达的旧版本不会把旧译文挂到新正文上。

   ```json
   { "...": "原有字段",
     "source_lang": "en",
     "translations": {
       "zh": { "text": "译文", "source_lang": "en", "model": "deepseek-chat", "provider": "deepseek" },
       "ja": { "text": "翻訳", "model": "deepseek-chat", "provider": "deepseek" } } }
   ```

2. **仓储调用**（服务端代码 / 本地脚本）：

   ```ts
   await getSocialFeedRepository().upsertPostTranslations({
     post_id: "pst_x_2090000000000000001",
     content_version: 3, // 可选：翻译时读到的版本；已被新编辑取代则抛 409 stale_content_version
     translations: [{ locale: "zh", text: "译文", source_lang: "en", model: "deepseek-chat", provider: "deepseek" }],
   }); // => { post_id, content_version, locales }
   ```

   `ingestXPost(input)` 同样接受 `source_lang` 与 `translations: { [locale]: { text, source_lang?, model?, provider? } }`。

3. **直接写 D1**（每小时任务直接执行 SQL 时）。先找出缺译文的帖子，并记下读到的 `content_version` 与 `text` 去翻译：

   ```sql
   SELECT p.id, p.content_version, p.text, p.source_lang FROM social_feed_posts p
   WHERE p.origin='x' AND p.status='published' AND NOT EXISTS (
     SELECT 1 FROM social_feed_post_translations t
     WHERE t.post_id=p.id AND t.content_version=p.content_version AND t.locale=?1);
   ```

   每个语言一条 upsert（用 D1 参数绑定，不要拼接字符串）。`?2` 必须是上一步读到的版本，从而在翻译期间帖子被编辑时自动写入 0 行：

   ```sql
   INSERT INTO social_feed_post_translations(post_id,content_version,locale,text,source_lang,model,provider,updated_at)
   SELECT p.id, p.content_version, ?3, ?4, ?5, ?6, ?7, strftime('%Y-%m-%dT%H:%M:%fZ','now')
   FROM social_feed_posts p WHERE p.id=?1 AND p.content_version=?2
   ON CONFLICT(post_id,content_version,locale) DO UPDATE SET
     text=excluded.text, source_lang=excluded.source_lang, model=excluded.model,
     provider=excluded.provider, updated_at=excluded.updated_at;
   -- 可选：记录原文语言
   UPDATE social_feed_posts SET source_lang=?5 WHERE id=?1 AND source_lang IS NULL;
   ```

   upsert 影响行数为 0 表示版本已过期：重新读取正文再翻译。`locale` 不在 9 个语言内会被表的 `CHECK` 拒绝。只在开发库执行；生产库与远程迁移遵循正常发布流程。

### 读取与回退规则

- 读取接口（`GET /api/feed/posts`、`/posts/:id`、`/replies`、`/ancestors`、`/me/bookmarks` 及互动后的返回体）接受 `?locale=<站点语言>`；前端自动带上当前页面语言。未知语言返回 400 `invalid_locale`，不带参数则只返回原文。
- 每个帖子返回 `text`（永远是原文）、`source_lang`、`translation: { locale, text, source_lang } | null`。
- 只 `LEFT JOIN` `locale` 等于页面语言 **且** `content_version` 等于帖子当前版本的译文；没有则 `translation=null`，界面显示原文。
- 原文语言（帖子 `source_lang`，为空时用译文行的 `source_lang`）的主语言标签等于页面语言（如 `zh-hans` 对 `zh`）、译文与原文相同、帖子已删除时，也返回 `null`。
- 有译文时卡片默认显示译文，并在正文下方显示「原文 / 译文」小切换；`translation=null` 时不显示切换。

### 编辑后的旧译文

帖子编辑使 `content_version` 增加后，旧版本译文**保留不删**（与 `social_feed_post_versions` 一样作历史），但读取只匹配当前版本，因此立即停止展示，新版本在补译前回退到原文。图片变化也会增加版本，需要重新写译文。确需清理时可执行：

```sql
DELETE FROM social_feed_post_translations WHERE EXISTS (
  SELECT 1 FROM social_feed_posts p WHERE p.id=social_feed_post_translations.post_id
    AND p.content_version>social_feed_post_translations.content_version);
```

## API

| 路径 | 行为 |
| --- | --- |
| `GET/POST /api/feed/posts` | 公开列表、创建本站主帖 |
| `GET/DELETE /api/feed/posts/:id` | 详情、作者删除原生帖 |
| `GET/POST /api/feed/posts/:id/replies` | 直接子回复列表、创建本站回复 |
| `GET /api/feed/posts/:id/ancestors` | 根到父的上文链 |
| `GET /api/feed/publishing-capabilities` | 当前发布资格；不影响公开读取 |
| `PUT/DELETE /api/feed/posts/:id/reaction` | `{value: "like"或"dislike"}`、取消 |
| `PUT/DELETE /api/feed/posts/:id/bookmark` | 私有收藏、取消 |
| `PUT/DELETE /api/feed/posts/:id/repost` | 站内转发、取消 |
| `GET /api/feed/me/bookmarks` | 本人的收藏分页 |
| `PUT/DELETE /api/feed/authors/:id/follow` | 关注、取消关注 |
| `POST /api/feed/post-events` | 经验证的 qualified_view 事件 |
| `POST /api/feed/media` | multipart `file` 与可选 `alt_text` |
| `GET /api/feed/media/:id` | 带可见性检查的媒体读取 |

发帖/回复的 JSON 是 `{text, media_ids?}`，请求必须带 `Idempotency-Key`；身份、来源、根帖、评分均由服务端决定。相同调用者与 key 重试返回同一帖，不同内容返回冲突。推荐和关注首次读取固定最多 1000 个候选的顺序快照，有效期 30 分钟。签名 cursor 绑定频道与用户/匿名访客；后续翻页重新检查帖子可见性和转发是否仍有效。时间线读取不再按作者评分过滤 X 帖子：已入库且 `status=published`（未删除/隐藏、`source_eligible` 人工开关未关闭）的 X 帖子都会显示；作者资料缺失时回退为帖子上保存的 X 名称、头像与原帖链接中的 handle。期间新帖或新转发需要刷新才能进入，不会插入已有分页。收藏与直接子回复使用有作用域的游标分页。


## 本轮本地验证（2026-10-26）

- Social Feed API、资格、仓储、媒体、客户端状态、路由、TS 采集器与旧 rollout 的针对性回归通过（100 余项）；Go GitHubCollector 测试通过。
- 根项目、Astro、API、Router 类型检查通过；前端依赖检查通过；全量 lint 无错误，保留三个已有的非 Feed 警告。
- 独立 Workerd + D1 + R2 联调通过：发布、60 分边界、幂等、嵌套回复、私密互动、关注转发、严格 X 导入、签名分页、图片归属、删除占位和浏览去重。
- 匿名浏览器检查覆盖 1920×1080、390×844、亮/暗/自动主题、收藏登录提示、删除父回复后读取后续讨论。浏览器未允许临时测试登录入口，所以登录后的完整 GUI 发布流程尚未实测；写入行为由真实本地 API 联调验证。
- 代码未提交、未推送、未部署。当前页面中的「本地联调样例」均为隔离测试数据，不代表真实账号或 X 内容同步结果。
