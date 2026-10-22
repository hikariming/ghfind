# AGENTS.md

## Frontend Stack Rules（约束所有 agent）

所有前端工作（含子代理）必须先读本节，并在实现时遵守。规范原文（owner，逐字）：

> 前端提示词。优先复用成熟库、组件源代码可控、统一设计语言、严格限制重复依赖。再配合指定好各种库，就算 oneshot 也能出很不错的前端。UI 风格统一使用 shadcn/ui Nova；图标统一使用 Lucide；动画统一使用 Motion；布局库 react-resizable-panels；拖拽 dnd-kit；状态管理 Zustand。

补充约束（同样强制）：

- 信息卡片紧凑、纵向密集（不要又高又啰嗦）。
- 必须支持亮/暗主题（见下方 Frontend Theme Checks）。
- 必须移动端响应式（含约 390px 宽度）。
- 每个库单一版本，禁止重复/替代依赖（例如 framer-motion 与 motion 并存、多个图标库、多个状态库）。
- 新的 UI 原语必须落在 `src/components/ui`（shadcn/ui Nova + Radix 封装）。页面和功能组件只从 `@/components/ui` 取控件，不要直接从 `@radix-ui/*` 或其它 UI 套件引用。
- `components.json` 的 `style` 必须是 `radix-nova`（Radix + Nova），`iconLibrary` 必须是 `lucide`。现有已生成的控件不要为了换肤而整站重写；新 `shadcn add` 与新组件按 Nova 密度（更紧的 padding/margin）写。
- 分类白名单（只许这些，且同类只一个版本）：
  - 图标：`lucide-react`
  - 动画：`motion`（不要 `framer-motion`）
  - 状态：`zustand`
  - 拖拽：`@dnd-kit/*`
  - 布局（可调分栏）：`react-resizable-panels`
  - UI 套件：shadcn 源码在 `src/components/ui`，底层允许 `@radix-ui/*` 仅出现在该目录
- 机器闸门：`pnpm frontend-stack:check`（依赖白名单 / 锁文件单版本 / `components.json` / 本段原文）、ESLint `no-restricted-imports`、CI Application checks。不要删、不要降级为 warning。

### Reviewer checklist（每个前端 PR）

独立 reviewer 必须逐条打勾；不合规打回：

- [ ] 依赖：上述分类无替代库、无重复版本
- [ ] 组件来源：新控件在 `src/components/ui`，功能代码不直接引用 Radix / 其它 UI 套件
- [ ] 图标：只有 Lucide
- [ ] 动画：只有 Motion
- [ ] 信息卡片紧凑、纵向密集
- [ ] 亮/暗主题都检查过
- [ ] 移动端（含 390px）可用

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
