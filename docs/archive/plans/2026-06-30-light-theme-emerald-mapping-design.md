# Light Theme Emerald Mapping Design

## Problem

The profile detail page renders domain topics with Tailwind's
`bg-emerald-500/10` and `text-emerald-200/90` utilities. Those values work on
the default dark surface, but the global light-theme compatibility layer does
not remap either utility. The resulting pale green foreground and translucent
background have insufficient visual contrast on the light profile card.

## Decision

Keep the profile component's existing semantic Emerald utilities and add their
light-theme equivalents to `src/app/globals.css`:

- Map `bg-emerald-500/10` to a restrained light Emerald surface.
- Map `text-emerald-200/90` to the same readable dark Emerald foreground
  already used for `text-emerald-300` in light mode.

This is a global mapping so future uses of these utilities inherit correct
light-theme behavior. Dark mode remains unchanged because every override is
scoped below `html[data-theme="light"]`. Auto mode continues to use whichever
resolved theme the navbar theme controller writes to `data-theme`.

## Verification

Add a static Vitest contract that reads `globals.css` and asserts both missing
selectors are scoped to the light theme with the intended declarations. Run
the focused test through a red-green cycle, then run the full test suite,
`pnpm typecheck`, and `pnpm lint`.

Finally, use the navbar theme control to inspect the affected profile in Light,
Dark, and Auto. Check the topic text, pill background, surrounding card border,
language bars, and nearby typography for contrast or theme regressions.
