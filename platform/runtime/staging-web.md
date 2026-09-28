# Isolated OAuth Web staging

`staging.web.manifest.example.json` is an intentionally unusable version 2
example. Its schema requires independently reviewed D1 identities, paid-plan
and projected-cost evidence, a dedicated source-provider agent, one to four
approved repositories, and two distinct real GitHub accounts. A configuration
validation result proves none of those real journeys.

The existing version 1 runtime/provisioning manifest and five-resource receipt
hash stay unchanged. `feed-platform-web.mjs` explicitly derives the v1 core
manifest for older bounded probes; it never interprets a v1 manifest as a
complete OAuth environment.

## Fixed resources and prerequisites

- Web: `ghfind-feed-web-staging`, same account `workers.dev` subdomain as
  `ghfind-feed-runtime-staging`. Callback is exactly
  `<web origin>/api/auth/callback/github`.
- Dedicated cache: `ghfind-feed-staging-web-cache`; Feed archive remains
  `ghfind-feed-staging-archive`. Core and Feed D1 are the reviewed isolated
  staging IDs. All three known production/dev D1 IDs remain denied.
- Web bindings contain only those two D1 databases, its cache, assets, version
  metadata, and the `FEED_RUNTIME` service binding. The signed HTTP target origin
  remains mandatory even when the gateway uses the service binding.
- Web runtime secrets: `AUTH_SECRET`, `AUTH_GITHUB_SECRET`,
  `FEED_GATEWAY_SECRET`, and `MOSOO_API_TOKEN`. Operator, bridge, executor and
  source secrets are not Web bindings. Separate roles require separate values;
  the gateway key intentionally connects Web and runtime.
- Manifest `web.oauth.identities` has exactly ordinary and governance roles,
  each with a decimal safe-integer `githubId` string and exact GitHub `login`.
  Account holders complete their first GitHub login. Environment secrets
  `FEED_E2E_ORDINARY_STORAGE_STATE` and `FEED_E2E_GOVERNANCE_STORAGE_STATE` store
  those real browser states. Missing states fail before deployment. Each run
  still performs the actual GitHub OAuth begin/provider/callback journey.
- `GHFIND_DEPLOY_ENV=feed-staging` and the two exact account/repository
  allowlists are mandatory. Source creation is limited to one concurrent run
  and one create attempt. `FEED_SOURCE_OUTBOX_ENABLED=true` is deployed only
  after isolated core migrations; `FEED_BACKEND=go` alone would otherwise leave
  assessment completion without a Feed source event.

Resource creation, OAuth registration and operator approvals are separate
administrator work. This code neither creates resources from missing metadata
nor treats denied reads as absence. No unprotected environment is represented
as protected by the local validation tests.

## Workflow order and evidence

The reusable `feed-staging.yml` accepts `release_sha` and returns
`release_sha`, `evidence_artifact`, and `evidence_sha256`. It obtains secrets from
its own `Feed staging` environment; callers do not use `secrets: inherit`.
Read-only GitHub permissions and one staging concurrency lock cover the run.

An environment-free `protection` job first reads the enforced main ruleset and
all three deployment environment policies with `--verify-existing`. Missing or
unreadable checks/policies fail before the deployment job can enter `Feed staging`;
GitHub's automatic creation of empty environments cannot satisfy the prerequisite.
The nonsecret protection receipt is retained as its own current-run artifact.

1. `feed-ci-evidence.mjs verify-ci-remote` verifies the exact successful push
   CI, actual source/tree receipts, and complete local CF plus PostgreSQL E2E.
   A pull-request merge check or a head-SHA green badge is insufficient.
2. Validate all manifest prerequisites, save private browser/runtime credentials
   to fresh mode-0600 files outside the checkout, then read actual isolated
   D1, R2, queues and account subdomain identities.
3. Build Next/OpenNext using an explicit public environment. Dotenv/dev-vars
   files in the checkout are rejected; runtime/Cloudflare/provider credentials
   and arbitrary `NEXT_PUBLIC_*` values are not inherited by the compiler.
   Run Wrangler's local dry-run against the exact generated Web config.
4. Build and push the ordinary Go image first, obtain the registry digest, and
   render runtime config with that immutable reference. Apply only isolated
   schemas; deploy adapter and runtime; check readiness, SIGTERM/restart and
   actual Container application/instance versions. Those probes remain basic
   lifecycle checks and cannot stand in for OAuth or full E2E.
5. Deploy the dedicated Web Worker, populate only its cache and read back its
   active version, release tag, full allowed binding inventory and OAuth begin
   configuration. Execute the real remote runner, then read the active Web
   version again and require it to match the journey's version.
6. Generate the passing receipt only with all eight real milestones:
   OAuth callback, assessment finalization, source outbox, executor projection,
   governance, preferences, events, and completed deletion. `queued` deletion,
   mock providers, one identity, failed cleanup or old Container versions fail.

The job is bounded to 60 minutes, Web build/dry-run to 13 minutes and the remote
journey step to 26 minutes. The journey owns its stricter 25-minute, 450-request,
real-provider and targeted-fixture cleanup limits. This is not a load test.

Receipt CLI:

```sh
node scripts/feed-platform-staging-evidence.mjs verify receipt.json RELEASE_SHA FILE_SHA256
```

Verification binds the receipt to the current `GITHUB_RUN_ID`,
`GITHUB_RUN_ATTEMPT`, exact clean checkout/tree, source CI and immutable observed
versions. It is a trusted-workflow artifact contract, not an independently
signed attestation. Production must download the artifact from that same run
and verify its supplied SHA256. Failure logs/evidence are retained separately;
no passing receipt is manufactured for a failed or missing journey.

Only enumerated nonsecret evidence files are uploaded. Browser state files and
runtime secret files are always removed. Raw OAuth cookies, provider payloads,
instance environment and arbitrary runner logs are excluded from the final
public receipt. The independently retained remote runner receipt must follow
its own nonsecret evidence contract.

## Build inventory and remaining acceptance

The inventory hashes regular output files and relative internal symlink text
without following links. OpenNext retains pnpm links, including unused dangling
links, in intermediate trees. External/absolute links and asset symlinks are
rejected. The separate Wrangler dry-run validates the reachable deployed module
graph; an inventory alone would not prove a deployable bundle.

Local unit tests use explicitly synthetic manifests and API fixtures. A local
Next/OpenNext build or Wrangler dry-run does not prove Cloudflare deployment,
real OAuth, provider billing or runtime isolation. Full local dual-profile E2E
must pass before a push. The actual remote journey must pass before merge.
Production cutover, measured Cloudflare capacity/cold-start targets, monthly
availability, restoration and actual monthly costs remain separate gates.
