# Curated collections（编辑推荐合集）

每个合集一个 `<slug>.json`，slug 即 URL：`/collections/<slug>`。新增/修改合集 = 改这里的 JSON，走 git review，无需动代码（构建时静态渲染，进 sitemap）。

## 字段

```jsonc
{
  "type": "projects",              // projects | developers | mixed
  "title": { "zh": "…", "en": "…" },  // 编辑内容只写 zh + en，其余 locale 自动读 en
  "intro": { "zh": "…", "en": "…" },
  "publishedAt": "2026-08-01",     // ISO 日期，索引页按此倒序
  "tags": ["ai-agent"],
  "items": [
    {
      "kind": "repo",              // repo | developer
      "id": "owner/name",          // repo 用 owner/name；developer 用 GitHub username
      "blurb": { "zh": "推荐理由", "en": "Why we picked it" },
      "mock": { /* 见下 */ }
    }
  ]
}
```

## `mock` 块（静态预览期的占位数据）

真实数据接入前，卡片上的数字全部来自 `mock`；接入后改为渲染时从 `repos`/`scores` 表实时查询，`mock` 降级为未扫描实体的兜底展示。

- `kind: "repo"`：`stars`、`language`、`description`（英文）、`avgScore`（贡献者平均分）、`contributors: [{ username, tier }]`（tier 用引擎的中文段位值：夯 / 顶级 / 人上人 / NPC / 拉完了）
- `kind: "developer"`：`name`（展示名，可省）、`tier`、`score`、`followers`、`totalStars`、`languages`

## 约定

- slug 只允许 `[a-z0-9-]`。
- 站内链接自动生成：repo → `/developers/repo/<owner>/<name>`，developer → `/u/<username>`，GitHub 原链只作角标。
- 不要造 tag × locale 的组合页面；合集总数保持有限可枚举（SEO 面靠单页质量，不靠 URL 数量）。
