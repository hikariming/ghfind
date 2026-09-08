# Application release readback at 0ca5301

At `2026-09-08T18:41:55.013714Z`, two read-only Cloudflare API calls read the
`ghfind` Worker settings and deployments in Beiming account
`8f19bebe359e4ec1a24c68c5f49c1584`. The filtered original response in
[readback.json](readback.json) retains only the three Feed activation flags,
D1 identities and latest deployment metadata. No credential values or unrelated
bindings were retained.

[Exact-main CI 34263794374](https://github.com/hikariming/ghfind/actions/runs/34263794374)
and [production release 34264155390](https://github.com/hikariming/ghfind/actions/runs/34264155390)
completed successfully for `0ca53012559a512d61a55a5eca373dca2f8f139c`.
The observed active Worker version was `3fac2561-fc17-4592-bc47-5fffc8460acb`
at 100%, deployment `a5cce821-ba39-44d1-8e16-a937c69176fc`.
Its release annotation matches the exact main SHA. The deployment was created
at `2026-09-08T18:39:25.375626Z` by the Actions release path; the API's `wrangler`
source describes that path, not a local manual deployment.

Every binding type was checked for `FEED_BACKEND`, `FEED_STORE_PROFILE` and
`FEED_SOURCE_OUTBOX_ENABLED`; all three were absent. Existing code therefore
keeps the legacy Feed runtime and source-outbox-off defaults. The verified core
D1 remains `60d45096-bfe7-4de1-8b85-c1b66a466b0d`, and Feed D1 remains
`9c4ac13a-4c90-40a8-9d56-d7141f864bbf`.

This is timestamped application-release readback. It does not establish a Go
Container deployment, staging acceptance, authenticated OAuth E2E, enabled source
capture, applied new Feed migrations, database promotion or capacity acceptance.
No database query, schema mutation, request workload or traffic change was
performed by this readback. Later application releases require their own version
readback when relevant; this record must not be silently rewritten as current.
