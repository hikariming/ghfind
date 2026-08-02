# Curated collections（编辑推荐）

每个条目一个目录：`content/collections/<slug>/`，slug 即 URL：`/collections/<slug>`。新增/修改 = 改这里的文件，走 git review，无需动代码（构建时静态渲染，进 sitemap）。

## 目录结构

```
content/collections/<slug>/
  meta.json    # 必须：类型、双语标题/导语、日期、tags、可选 subject / items
  zh.md        # 可选：长文正文（人物特写/深度推荐）
  en.md        # 可选：英文正文
```

正文语言回落：请求 locale → en → zh（编辑内容只维护 zh/en，其余 locale 自动回落，页面会显示"暂无翻译"提示，hreflang/canonical 只指向真实存在的语言版本）。

## meta.json 字段

```jsonc
{
  "type": "developers",              // projects | developers | mixed（页面顶部的类型徽章）
  "title": { "zh": "…", "en": "…" },
  "intro": { "zh": "…", "en": "…" }, // 索引卡摘要 + meta description
  "publishedAt": "2026-08-01",       // ISO 日期，索引页按此倒序
  "tags": ["developer-story"],

  // 可选：人物/项目特写的主角 —— 详情页顶部渲染主角卡
  //（头像 + 站内档案按钮 + GitHub 角标），JSON-LD 输出 Article + about Person
  "subject": {
    "kind": "developer",             // developer | repo
    "id": "zRzRzRzRzRzRzR",          // username 或 owner/name
    "name": "张昱轩 (Yuxuan Zhang)",  // 展示名，可省
    "headline": { "zh": "…", "en": "…" }
  },

  // 可选：榜单式合集的推荐条目（卡片列表，可与正文共存）
  "items": [
    {
      "kind": "repo",                // repo | developer
      "id": "owner/name",
      "blurb": { "zh": "推荐理由", "en": "Why we picked it" },
      "stats": { /* 静态数字兜底；接入真实数据后由 repos/scores 实时查询覆盖 */ }
    }
  ]
}
```

`stats` 字段：

- `kind: "repo"`：`stars`、`language`、`description`（英文）、`avgScore`、`contributors: [{ username, tier }]`（tier 用引擎中文段位：夯 / 顶级 / 人上人 / NPC / 拉完了）
- `kind: "developer"`：`name`、`tier`、`score`、`followers`、`totalStars`、`languages`

## 约定

- slug 只允许 `[a-z0-9-]`。
- 正文 markdown **不要写 H1**（标题来自 meta.json），从正文段落或 `##` 开始。
- 站内链接自动生成：repo → `/developers/repo/<owner>/<name>`，developer → `/u/<username>`，GitHub 原链只作角标。
- 不要造 tag × locale 的组合页面；合集总数保持有限可枚举（SEO 面靠单页质量，不靠 URL 数量）。
