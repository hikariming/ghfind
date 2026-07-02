# Home Username Links Design

## Goal

Increase visits to ghfind profile pages by routing username links on the home page to the existing localized user detail route instead of GitHub.

## Scope

- Change the generated score card's `@username` link to `/u/{username}`.
- Change each home leaderboard `@username` link to `/u/{username}` so it matches the row's existing destination.
- Keep GitHub links on the user detail page unchanged.
- Preserve the current layout, typography, colors, hover treatment, and click areas.

## Approach

Use the locale-aware `Link` exported by `@/i18n/navigation` at both call sites. This keeps locale routing consistent with existing internal navigation. Do not add a shared component because two direct call sites do not justify another abstraction.

## Testing

- Add focused component coverage proving the leaderboard username and generated score username resolve to internal profile routes rather than GitHub.
- Run the relevant test first and confirm it fails before implementation.
- Run the full test suite, `pnpm typecheck`, and `pnpm lint` after implementation.
- Manually inspect the affected home states in resolved light and dark themes, and verify the Auto control resolves correctly.
