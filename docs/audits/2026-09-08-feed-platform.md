# Feed platform audit — 2026-09-08

This is a read-only evidence snapshot for the independent Go Feed work. The
implementation base and freshly fetched `origin/main` were
`41ce4cd829f431fa2e20133e0c2509bbe1d5fad3`; `origin/dev` was
`c2118c73abdc2b501c4552679067bfaa1d8cf8f5`. Inspection took place around
01:50–02:00 UTC. No remote configuration, data, traffic or deployments changed.
Database queries returned `rows_written = 0`. GitHub secrets were inspected by
name only; their values were neither retrieved nor printed.

## Decision and evidence boundaries

Proceed with a standalone Go Feed API/executor, Cloudflare Containers first,
and a Worker binding adapter. Keep the current Feed D1 as the first production
fact source. Deliver PostgreSQL as a tested alternative; do not switch runtime
and database in the same release. This is an implementation decision, **not a
claim that Containers or the alternative profile have passed production gates**.

The core D1 is the operational assessment source: the active Worker binds it,
and `src/lib/project-analysis-db.ts` selects `getD1Binding()` before Turso.
`src/lib/feed.ts` projects assessments from that same core client. Existing
Turso fallback code does not make Turso the active production source.

Historical migration completeness remains unresolved. The earlier
[migration execution record](../plans/2026-08-28-cloudflare-migration-execution.md)
claims an August 29 import and approximately one hour of writes left in the old
database. That is a historical report, not a current data comparison or renewed
authorization to discard data. Neither this process nor local `.env.local`
provided Turso connection settings. No production Turso endpoint was verified,
and no contents or credentials were obtained from GitHub Secrets. Never resolve
the difference by picking the newest database or replaying an unverified dump.

## Verified platform snapshot

| Surface | Observation | Evidence / consequence |
| --- | --- | --- |
| Repository | `hikariming/ghfind`, default branch `main`, viewer permission `WRITE` | `gh repo view`; no admin permission established. |
| Production Worker | `ghfind`; active version `2d941c44-b50d-4c3c-95ab-32345858085a`, 100% | Wrangler deployment list and version view; release annotation contains the full base SHA. |
| Production CI | CI, deploy and bounded catalog reconciliation succeeded for the base SHA | [CI](https://github.com/hikariming/ghfind/actions/runs/34171918209), [deploy](https://github.com/hikariming/ghfind/actions/runs/34172057529), [reconcile](https://github.com/hikariming/ghfind/actions/runs/34172211591). |
| Core D1 | `ghfind`, `60d45096-bfe7-4de1-8b85-c1b66a466b0d` | Active `GHFIND_D1` binding; 261 assessments, all linked to a completed run. |
| Feed D1 | `ghfind-feed`, `9c4ac13a-4c90-40a8-9d56-d7141f864bbf` | Active `GHFIND_FEED_D1` binding; 261 projects, 235 currently published, 1,169 proposed tags. Users/events/served items each zero at observation time. |
| Existing dev | Feed database `bd305af9-2cab-4fe8-8c2f-324391cf105e` | Only `_cf_KV`, `d1_migrations`, `sqlite_sequence` tables; no Feed business schema. Dev and production share the core D1 in checked-in configuration. This is not isolated staging. |
| R2 | `ghfind-assets`, `ghfind-next-cache`, `ghfind-next-cache-dev` exist | Account-pinned bucket list. The active Worker binds `ghfind-next-cache`; an existing bucket is not evidence of Feed backups. |
| Containers / Queues / Vectorize / Workflows | No instances/applications, queues, indexes or deployed workflows listed in the target account | Read-only Wrangler listings. No operational capability, latency or recovery evidence yet. |
| CF account | `8f19bebe359e4ec1a24c68c5f49c1584`; Workers settings report `enabled=true`, `free_tier=false` | This supports non-free Workers configuration. Subscription API returned HTTP 403, code 10000. Invoice, billing eligibility and account-specific quotas remain unverified. |

Wrangler was 4.118.0. Account-wide R2 enumeration required explicit
`CLOUDFLARE_ACCOUNT_ID`; the local OAuth context has multiple accounts. Always
pin the target account, including commands that do not consume environment
bindings. A transient D1 fetch failure succeeded on one bounded retry; it was
not interpreted as a missing resource.

The live Worker exposes `fetch`; OpenNext also declares generated class exports
such as `DOQueueHandler`. These names alone do not show that business queues or
the new Feed control plane are connected.

## Migration drift and initial admission

The core database records these applied migration filenames:

| Filename | Applied at (UTC) |
| --- | --- |
| `0001_init.sql` | 2026-08-29 08:49:37 |
| `0002_v10_risk_columns.sql` | 2026-09-06 06:32:58 |
| `0003_v10_read_fallback.sql` | 2026-09-06 06:32:58 |
| `0002_user_resume_libraries.sql` | 2026-09-07 13:14:28 |
| `0004_project_assessment_sync_index.sql` | 2026-09-07 17:10:35 |

The extra résumé migration is present on `origin/dev`, introduced by
`d59c34fc5b14f5e065883534a8d676e395b202e1` on September 6. Its table shape matches
remote `sqlite_master`: `github_id INTEGER PRIMARY KEY`, `login TEXT NOT NULL`,
`data TEXT NOT NULL`, `updated_at INTEGER NOT NULL`. It is absent from main.
Do not renumber, replace or remove the applied entry, table or data; reconcile
its checked-in schema history separately without importing unrelated dev UI.
New Feed source migrations must also test this real upgrade shape.

Feed D1 has applied `0001_feed_baseline.sql` and
`0002_feed_candidate_order.sql`. The 235 published rows reflect the current
assessment-only gate, **not the stricter approved submission gate**.

The current `POST /api/project-analyses` endpoint accepts direct submissions
without requiring OAuth and reuses existing analyses. The persisted run schema
has repository/run identity and completion status but no submitter, submission
receipt, initiation channel or provenance type. The only current TypeScript
caller of `createProjectAnalysis` is that route; this does not establish how
each historical/imported row originated. No durable per-project submission
evidence was established for the 261 existing candidates during this audit.

Apply these admission rules in the new implementation:

1. A server-recorded receipt of an explicit project submission, or a reviewed
   historical receipt tied to the repository and analysis, establishes the
   submission prerequisite. Record provenance and receipt identity; do not
   infer the submitter from the repository owner. Keep existing anonymous
   assessment submission behavior; only Feed consumption requires OAuth.
2. A reused completed analysis still needs the new explicit-submission receipt.
   Receipt persistence must not depend on creating a fresh analysis run.
3. Verify valid completed assessment, current public eligibility and moderation
   separately. Submission evidence cannot override those hard gates.
4. Missing or ambiguous historical provenance defaults to quarantine in the
   **new Feed admission path**. Keep public project pages and existing facts;
   the audit itself does not unpublish production rows.
5. Repository discovery, stars, a completed run, a catalog reconciliation,
   a tag proposal or a migration import is insufficient submission evidence.
   Do not bulk-approve the 1,169 pending tag proposals to manufacture admission.

Therefore the strict initial admitted set is empty until receipts are supplied
or recorded. This is not evidence that nobody submitted those projects.

## Git and CI findings

The named historical changes were verified using Git objects: `00e92af` and
`117437d` were authored by AsperforMias (Go extraction and Next gateway);
`fd9f650`, `ccdaa1e`, `06641a2` by hikariming (Cloudflare and route migration);
`8d28106` by akou (CF release workflow); `6268726` by AsperforMias (merge).
The current Next config has no Go backend rewrite. The deployed Feed business
path remains in Next/TypeScript at the audited base.

Ruleset `18206694`, [Protect main](https://github.com/hikariming/ghfind/rules/18206694),
is active on the default branch. It prohibits deletion/non-fast-forward updates
and requires a PR, one approving review, dismissal after new pushes, code-owner
review and last-push approval. It has **no `required_status_checks` rule**.
The response reports `current_user_can_bypass=always`; this is not authorization
to bypass the agreed PR/review process. The legacy branch-protection endpoint
returned 404, which is not proof that the separate ruleset is missing.

`Production`, `Preview` and `copilot` environments have no protection rules or
branch policies. The production deploy job at the base SHA does not reference
an environment. It already gates `workflow_run` on successful upstream push CI
for main and checks out its exact SHA; preserve those provenance checks. It
currently deploys and rolls back one OpenNext Worker, so its rollback cannot be
reused unchanged for a multi-service Container release.

`CF_API_TOKEN` and `FEED_ADMIN_SECRET` repository secret names exist. Their
presence says nothing about scope or future Container/queue permissions.
The `Verify release` CI job runs Go, TypeScript, lint, local migrations and
builds, but provisions no PostgreSQL. `feed_postgres_integration_test.go` skips
when `FEED_TEST_DATABASE_URL` is absent. The passing CI is not a two-profile
contract result or real OAuth E2E. Public smoke is likewise not authenticated
Feed write/recovery evidence. No new CI run or E2E was performed by this audit.

## Railway legacy surface

The locally unlinked CLI was queried with explicit project
`815ec3e1-679a-41b4-a7c0-6ba65b64db8e` (`ghfind-staging`) and environment
`b9d929d6-a1e4-4e74-b43f-38ed529cc6f1` (`production`). Project naming does not
establish data isolation.

| Service | Latest deployment / observation |
| --- | --- |
| `ghfind-api` | `92293715-7c36-4183-9cee-cb5cc65e7b97`, August 30; one RUNNING instance, deployment SUCCESS; `/healthz` and `/readyz` each HTTP 200. |
| `ghfind-worker` | `b5ce9acc-bd52-47f8-b849-b78752a2cc4a`, August 30; one RUNNING instance, deployment SUCCESS; both health endpoints HTTP 200. |
| `ghfind-feed-backup` | `18033c56-110c-4a69-923b-f6743c7877e9`, September 8 00:21:44 UTC; CRASHED, six-hour schedule still configured. Recovery coverage cannot rely on it. |
| Other resources | libsql, PostgreSQL/pgvector, RabbitMQ and mocks show RUNNING instances; migrate/bootstrap service records have no latest deployment. No resource was restarted or removed. |

The API's public HTTP metric for September 1 02:00–September 8 02:00 UTC totals
six requests. Read-only health probes in this task contribute to that traffic;
the total cannot establish real business usage. Railway CLI 5.49.4 `metrics`
failed its long-window sample-size limit; a read-only `httpMetrics` GraphQL
query with `stepSeconds: 900` supplied the result. Private calls, queue contents,
consumer activity, database writes, backup failure cause and actual cost were
not audited here. Neither zero business dependency nor safe retirement is proven.

## Open gates and handoff

| Gate | Owner / next evidence | Blocks |
| --- | --- | --- |
| Billing and CF runtime feasibility | Account administrator: billing/eligibility; platform implementer: isolated startup, lifecycle and cost measurements | Claiming CF production readiness; not local implementation. |
| GitHub release controls | Repository administrator: required checks and environment controls; release owner: workflow environment references | Production Feed cutover. |
| Historical source differences | Data owner: verified read-only Turso snapshot/endpoint and bounded key/hash comparison | Core source migration or deleting old data; not a Feed-only implementation on D1. |
| Initial project receipts | Data/product operator: evidence-backed manifest or new explicit receipts | Admitting those historical projects to the strict Feed. |
| Runtime, contracts, OAuth and recovery | Subsequent implementation stages: actual two-profile tests and isolated deployment evidence | Production traffic and final operational acceptance. |

Account permissions, absent resources and a first deployment failure are not
evidence that Cloudflare cannot support the workload. The Railway fallback
requires measured platform limitations or failure to meet the approved latency,
recovery and USD 100/month budget after reasonable CF work.

Handoff: base SHA and resource IDs above; schema versions remain unchanged;
rollback anchor remains Worker `2d941c44-b50d-4c3c-95ab-32345858085a`. No new
backend has been deployed. Operator follow-up is specified in
[Feed platform prerequisites](../operations/feed-platform-prerequisites.md).
