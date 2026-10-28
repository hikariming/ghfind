# Feed avatars and author cards

Local UI captures of `/feed` with explicitly labelled local integration fixtures (69 and 90 scores), not production account activity.

- `hover-light.png`: light theme, author card, ghfind-only counts and GitHub/X brand links.
- `hover-dark.png`: dark theme, 69-point author with the shared NPC avatar frame.
- `mobile-dark.png` / `mobile-light.png`: 390 × 844 viewport; card remains within viewport, no horizontal overflow.

Author cards open on hover or keyboard focus; Profile and author links navigate to `/u/{github_login}`. Touch users can follow the existing profile link. Light, dark, and automatic theme controls were exercised.

Post frames use the verified score recorded at publication; the composer and hover card use the currently saved verified score. Curated imports marked `unscored` never acquire a synthetic rating frame. The card's X account URL uses the stored, bound X user ID, not a guessed handle. Missing X bindings omit that link.

Validation: 2055 Vitest tests, root typecheck and lint, Astro and router typechecks, frontend-stack check. Lint has three existing unrelated warnings. No database migration or generated GraphQL/baseline changes.
