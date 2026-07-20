# v9/v9/v4 Release Contract

## Runtime Contract

`v9/v9/v4` is the current canonical release. A user request runs one bounded
quick GitHub scan synchronously, materializes the deterministic v9 score, and
then generates or replays the matching v9 roast. The web application does not
create durable scan jobs, poll a queue, or depend on Vercel Cron or a resident
worker.

If the quick collector cannot complete, a verified `v5/v5/v3` artifact may be
served as a read-only emergency fallback. A successful quick scan always takes
precedence and overwrites the current profile atomically.

## Deployment Checks

1. Run `pnpm versions:check`, `pnpm typecheck`, `pnpm lint`, and `pnpm test`.
2. Deploy the web application and verify `/api/scan`, `/api/score/{username}`,
   and a default-model `/api/roast` complete without a `202` or
   `scan_enrichment_pending` response.
3. Verify a known v5/v5/v3 profile is served only when an induced quick-scan
   failure occurs.
4. Run `pnpm smoke:deployment` with the normal profile, score, autocomplete,
   leaderboard, and facet canaries.

## Change Control

Only one release component may change in a pull request. A release change must
include its migration/read behavior, rollback steps, and production smoke
coverage. Never use local-only version constants, and never invalidate stored
profiles by requiring a newly bumped version before its replacement data exists.

## Rollback

If the v9 quick path is unhealthy, revert the responsible application commit
while retaining existing `v5/v5/v3` artifacts. Do not alter score, roast, or
collection version constants as an incident shortcut; restore read behavior
first, then repair the producer in a separately reviewed change.
