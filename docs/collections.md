# Curated collections（编辑推荐 / Founder's picks）

Collections live in D1 (`migrations/0022_collections.sql`), not in the repo.
Pages read them at request time: `/collections`, `/collections/<slug>`, the
homepage card band, and `/sitemap.xml`. Publishing or editing a collection
does not need a deploy.

## Tables

| Table | One row per | Holds |
| --- | --- | --- |
| `collections` | collection | `slug` (= URL), `type`, `status` (`draft`/`published`), `published_at`, `tags` (JSON), subject `kind`/`id`/`nickname` |
| `collection_translations` | collection × locale | `title`, `intro`, `subject_headline`, `body` (markdown article), `reading_minutes` |
| `collection_items` | card-list pick | `position`, `kind` (`repo`/`developer`), `item_id`, `stats` (JSON) |
| `collection_item_translations` | pick × locale | `blurb` |

Fallbacks: each text field falls back locale → en → zh. A locale "has an
article" when its `body IS NOT NULL`. That set drives hreflang and canonical:
locales without a body canonicalize onto en (or the first body locale), so a
page in a missing language never competes with the original in search results.

## Publishing workflow

Write the collection as a folder, the same way as before. Then generate SQL
and apply it. The script replaces every row for each slug it covers, so it
works for both new collections and edits:

```
<dir>/<slug>/
  meta.json   # type, title/intro per locale, publishedAt, tags, optional subject / items, optional status
  zh.md       # optional article body (no H1; the title comes from meta.json)
  en.md / ja.md / ko.md
```

```bash
pnpm tsx scripts/collections-to-sql.mts <dir> [slug ...] > /tmp/collections.sql
wrangler d1 execute ghfind --remote --file /tmp/collections.sql
```

The seeded collections from the former `content/collections/` are in git
history (`git show 664a941:content/collections/<slug>/meta.json`).

Notes:

- Use `"status": "draft"` to stage a collection: drafts are not listed,
  routed, or put in the sitemap.
- If you edit `body` by hand in SQL, recompute `reading_minutes` (or just
  re-run the script).
- Detail pages are edge-cached for a day (`STATIC_PAGE_CACHE`). Purge
  `/collections/<slug>` (all locale prefixes) and `/collections` to show an
  edit right away. A new slug shows up immediately, because 404s are not cached.
- D1 rejects statements over 100 KB; the script fails loudly if one article
  body gets close to that.

## meta.json fields

```jsonc
{
  "type": "developers",              // projects | developers | mixed
  "title": { "zh": "…", "en": "…", "ja": "…", "ko": "…" },
  "intro": { "zh": "…", "en": "…" }, // index card summary + meta description
  "publishedAt": "2026-08-01",       // ISO date; listing is newest first, ties by slug descending
  "tags": ["developer-story"],
  "subject": {                       // optional feature subject (Article + about Person JSON-LD)
    "kind": "developer",             // developer | repo
    "id": "zRzRzRzRzRzRzR",          // username or owner/name
    "nickname": "张昱轩 (Yuxuan Zhang)",
    "headline": { "zh": "…", "en": "…" }
  },
  "items": [                         // optional card list
    { "kind": "repo", "id": "owner/name", "blurb": { "zh": "…", "en": "…" }, "stats": {} }
  ]
}
```

`stats`: repo → `stars`, `language`, `description`, `avgScore`,
`contributors: [{ username, tier }]`; developer → `name`, `tier`, `score`,
`followers`, `totalStars`, `languages`. Tiers use the engine's Chinese labels
(夯 / 顶级 / 人上人 / NPC / 拉完了).

## Conventions

- Slugs are `[a-z0-9-]` (enforced by a CHECK constraint). Never rename a
  published slug: the URL is the SEO identity.
- Keep the set of collections finite and hand-picked. Don't generate tag ×
  locale pages; SEO comes from the quality of each page, not from the number
  of URLs.
