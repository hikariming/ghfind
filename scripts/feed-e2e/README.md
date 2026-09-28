# Complete local Feed E2E

Run from a clean, isolated worktree with no real `.env` files:

```sh
pnpm install --frozen-lockfile
pnpm --dir platform/feed install --frozen-lockfile
npm ci --prefix platform/runtime
pnpm exec playwright install --with-deps chromium
python3 scripts/feed-e2e/harness.test.py
node --test scripts/feed-e2e/ack-loss.test.mjs
python3 scripts/run-feed-e2e.py --release-sha "$(git rev-parse HEAD)" --directory /tmp/feed-e2e-unique-attempt --execute
```

Omitting `--execute` prints a plan and cannot yield a passed receipt. Missing Docker,
Go, locked dependencies, browser, database, executor, or object storage fails.
No environment is optional and neither profile can be skipped. Each attempt must
use a fresh output directory; failed evidence is never overwritten.

The test builds the actual `cmd/feed-api`, `cmd/feed-worker` and migration command,
runs real PostgreSQL/pgvector and MinIO Docker containers, and starts the actual
Feed Worker in a local workerd runtime with persisted D1 and R2. A custom **test
process** serves the unmodified Next router with its actual D1 binding. All three
projects enter via `POST /api/project-analyses`; their status polling executes the
real reconciliation/finalization service and source database transaction.

Only GitHub's authorize/token/profile responses and the external assessment
provider are fixtures. The application creates and verifies its own OAuth state
and session cookies. The fixture does not mint application cookies, directly
insert projections, replace application storage methods, or add a production
provider/auth bypass. It is local provider-fixture E2E, **not real GitHub OAuth or
real model evaluation evidence**.

The production source relay and queue consumer run against an explicitly local,
fsync-backed delivery transport. The real Go executor receives persisted messages
over HTTP and acknowledges only after durable completion; each message is
redelivered once to check ack loss. This does not establish remote CF Queues
behavior, lifecycle SLOs, or disaster recovery.
The first executor response must be `completed`, the second `duplicate`; exact
persisted job, projection, submission evidence, tag and proposal snapshots must
remain unchanged across redelivery. Failure tests reject repeated execution,
changed durable state and a missing current projection.

Two independent browser contexts complete the OAuth callback. The journey checks
anonymous denial, gateway identity-header stripping, cross-user token rejection,
stable pagination after impressions, source receipts/outbox, worker projection,
manual governance HTTP authorization, profile changes from saves, duplicate event
handling, explicit negative filtering, deletion ownership, token fencing and
final deletion `completed` after the actual executor cleanup.

`run.json` is the pre-push receipt: exact clean source SHA/tree, both profiles,
eight mandatory milestones, and successful resource cleanup are required. Only
owned Docker resources (matching both random owner and source labels) are removed.
Every subprocess, including the browser journey, starts in its own registered
process group. Cleanup verifies the whole group is gone even when its parent has
already exited, and escalates after a deadline. Failure tests cover parent exit,
command timeout and preservation of an unrelated process group.
Application binaries and fixture data remain in the private output directory for
failure inspection. Generated logs contain local fixtures only; command logs
redact generated credentials. Never publish raw browser state or fixture databases.
The baseline journey starts with empty archives. Nonempty object deletion and
object-byte recovery require the separate stage 2/4 acceptance scenarios.

CI must independently validate the receipt and rerun the same journey. A local
receipt never authorizes merge or production; accurate-SHA CI and real CF staging
E2E remain separate mandatory gates.
