# Isolated Feed staging resource readback

Observation window: 2026-09-08 02:44–03:47 UTC. Target account:
`8f19bebe359e4ec1a24c68c5f49c1584` (Beiming). This supplements the initial audit;
absence recorded earlier does not describe the resources created later.

Wrangler's authenticated account selection and `/containers/me` succeeded. The
reported per-deployment limits are 4 vCPU, 12 GiB memory and 20 GB disk; aggregate
limits are 1,500 vCPU, 6 TiB memory and 30 TB disk, with a Durable Objects offset
of 2,000. Workers account settings report `free_tier=false`. The subscription
endpoint still returns 403; the exact invoice/plan name has not been verified.
These observations establish accessible platform features and quotas, not actual
Container deployment, measured spend or Actions-token permissions.

| Resource | Verified identity |
| --- | --- |
| Isolated core D1 | `ghfind-feed-staging-core`, `69bdae1c-ac36-4883-8fa4-9ffa54ebd033` |
| Isolated Feed D1 | `ghfind-feed-staging-db`, `7526684c-b57d-412e-89ba-812cd30798e8` |
| Archive R2 | `ghfind-feed-staging-archive` |
| Main queue | `ghfind-feed-staging-jobs`, `c128f5a45ac14ddaa48dbd26ece73b4b` |
| DLQ | `ghfind-feed-staging-dlq`, `52bade26ef83411cb0ff16accf49b391` |
| Terminal recovery parking | `ghfind-feed-staging-terminal-parking`, `63071f3bf30f457792d2ac63049a6d22` |

The first five resources were journaled under plan hash
`62a5c7ddf0585141a6923d0072c67f8d7448d8deaf7ea55e1dbbbb74637068da`.
The terminal parking queue is an additional separately journaled create; the
original five-resource receipt and hash were preserved. Its create completed at
03:46:02 UTC and API readback at 03:46:56 UTC confirmed
`message_retention_period=1209600` seconds and no consumers. This is a finite
14-day recovery window, not indefinite retention. Actual acceptance of that
retention setting is additional paid-feature evidence, not an invoice.

No Worker or Container deployment, business schema application, user writes or
production Feed cutover is established by these resource receipts. The isolated
resources do not reuse the shared dev/core D1. A dedicated Actions token remains
pending final creation approval in the logged-in Cloudflare UI; no value is
recorded here. Runtime and adapter credentials must remain independent.

GitHub PR #245 and #246 were merged using the user's explicit bypass authority
after their CI passed. The environment settings API separately returns 403 and
the logged-in settings page returns 404. Merge authority does not establish
repository environment-administration authority. Required-check and recovery
protection settings must be read back before declaring those gates complete.

The 79.70 USD rate-card scenario in `feed-platform-cost.mjs` is unmeasured and
contains an explicit 10 USD assumption for other services. No measured monthly
cost or hard billing cap is claimed. Staging deployment and production gates
remain in force until the corresponding evidence is collected.
