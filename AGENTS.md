# AGENTS.md

## Frontend Theme Checks

This app supports three theme modes: light, dark, and auto. Any frontend change
that affects layout, colors, cards, typography, controls, modals, reports,
leaderboards, share surfaces, or floating comments must be checked in both light
and dark resolved themes.

When adding or changing Tailwind classes, avoid hard-coding dark-only surfaces
without a light-theme counterpart. Prefer existing semantic patterns such as
`border-white/10`, `bg-white/[0.02]`, `bg-white/5`, and the global
`html[data-theme="light"]` mappings in `src/app/globals.css`.

Before calling a frontend change done:

- Toggle Light, Dark, and Auto from the navbar theme control.
- Manually inspect the touched page in both light and dark modes.
- Check text contrast, card borders, hover states, form fields, modals, footer
  areas, generated report markdown, and mobile/navigation surfaces when relevant.
- Watch for background seams, overly dark translucent panels in light mode, and
  overly bright borders in dark mode.
- Run `pnpm typecheck` and `pnpm lint`.

## Astro Migration (apps/)

Pages are moving from the Next app to `apps/web` (Astro + React islands),
fronted by `apps/router`, which picks the Worker per path (`src/routes.ts`).
Shared locale logic lives in `packages/i18n`, used by both `src/proxy.ts` and
`apps/web/src/middleware.ts`, so the two stacks route visitors identically.

- A migrated page must keep its URL, metadata, and hreflang identical: run
  `pnpm tsx scripts/seo-diff.mts <next-base> <astro-base> <paths...>` and get
  zero unallowed diffs before adding the path to the router table.
- Reuse components from `src/components` as islands (see
  `apps/web/src/islands`); `next-intl` and `@/i18n/navigation` are shimmed.
- Also run `pnpm --filter @ghfind/web typecheck` and
  `pnpm --filter @ghfind/router typecheck`.
