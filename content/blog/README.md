# Blog content conventions

Posts live at `content/blog/<slug>/<locale>.md`. `en.md` is **required** and is
the source of truth; other locales are translations of it. Chart SVGs live in
`public/blog/<slug>/` and are referenced with standard markdown images.

## Frontmatter contract

```yaml
---
title: "Post title"            # translated per locale
description: "One-sentence summary for meta/OG"   # translated per locale
date: "2026-07-03"             # en.md only — ignored in translations
updated: "2026-07-05"          # optional, en.md only
tags: ["data", "github"]      # en.md only — ignored in translations
---
```

`date`/`updated`/`tags` are always read from `en.md` so they can't drift across
translations. A locale with no file falls back to the en body at that route
with an "untranslated" note; its canonical points at the en URL.

## AI translation workflow

To add a language, ask Claude Code:

> Translate `content/blog/<slug>/en.md` to <language>, writing
> `content/blog/<slug>/<locale>.md`. Rules:
> - Translate the body plus the `title` and `description` frontmatter.
> - Copy `date`/`updated`/`tags` unchanged (they're ignored anyway).
> - Do NOT alter: image paths/URLs, code blocks, numbers, footnote markers
>   (`[^1]`), or product names (ghfind, GitHub).
> - Keep heading structure identical (anchors are derived from headings).
> - Natural register for a technical blog, not word-for-word.

Then human spot-check: numbers intact, links work, tone reads natively.
Locale codes must match `src/i18n/routing.ts` for the page to be routable;
extra files for not-yet-supported UI locales are harmless (ignored until the
locale ships).
