# Production readback after the stage 3 merge

At 2026-09-08T05:54:17Z the read-only Cloudflare API reported Worker `ghfind` active at version `b4bb9435-6a79-4a4d-b3aa-92274c41593e` with 100% traffic and annotation `release-2028e1a48365ab26f88492cfd37a7c51b2cd4554-from-upstream-main`. [Filtered evidence](readback.json) contains only deployment metadata, database binding identifiers and an explicit Feed flag allowlist; no token or secret binding values were retained.

[PR #247](https://github.com/hikariming/ghfind/pull/247) merged the exact tested head `4040e56118b4741e83ce91090e831e2530f9082a`. Its [PR CI](https://github.com/hikariming/ghfind/actions/runs/34191513054), the [merge CI](https://github.com/hikariming/ghfind/actions/runs/34191971968), and [production workflow](https://github.com/hikariming/ghfind/actions/runs/34192187703) succeeded.

The active Worker retained core D1 `60d45096-bfe7-4de1-8b85-c1b66a466b0d` and Feed D1 `9c4ac13a-4c90-40a8-9d56-d7141f864bbf`. No selected plaintext Feed override was present, so the checked-in legacy defaults remain in effect. The application migration allowlist still excludes the new Feed and source-outbox migrations. This is an application release readback, not evidence that the independent Go Feed, Containers, remote staging contracts, OAuth E2E, queue recovery or database promotion have been activated or accepted.
