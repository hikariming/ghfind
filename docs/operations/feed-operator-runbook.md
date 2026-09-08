# Bounded Feed recovery operations

This change provides an operator entry point for **isolated staging only**. Local contract tests establish authorization, resource checks, command bounds and uncertain-response behavior. They do not establish a successful deployed replay, delivered alert, or recovery SLO. Production remains rejected by both the client and runtime until a separate reviewed enrollment change includes the formal production manifest and tested release evidence.

## Required setup and release evidence

Use `.github/workflows/feed-operator.yml` from `main` with the exact 40-character deployed commit. It must be an ancestor of main with a successful `ci.yml` run. The workflow reads the actual `Feed staging operations` environment and fails closed unless it has required reviewers, prevents self-review, and disables administrator bypass. Configure this environment before attempting the workflow; a name alone is not protection.

The environment requires these values:

| Kind | Name | Purpose |
| --- | --- | --- |
| Variable | `FEED_STAGING_MANIFEST` | Reviewed isolated manifest accepted by `feed-platform-manifest.mjs` |
| Variable | `FEED_STAGING_RELEASE_EVIDENCE` | JSON output of `feed-platform-verify-deployment.mjs` for the exact SHA, Worker version and immutable image |
| Variable | `FEED_STAGING_RUNTIME_URL` | Exact runtime workers.dev origin in the verified Cloudflare account |
| Secret | `CF_FEED_STAGING_API_TOKEN` | Read Workers account subdomain and both Workers settings; use a separately scoped metadata credential where possible |
| Secret | `FEED_RUNTIME_ADMIN_SECRET` | Outer runtime operations authorization |
| Secret | `FEED_OPERATOR_SECRET` | Independent adapter authorization; never store this in runtime bindings or Go environment |

No URL or production target is accepted as workflow input. Before sending privileged operator tokens, the CLI reads the account subdomain, runtime service binding, and adapter D1/R2 binding IDs, rejecting any mismatch against the manifest. It then verifies `/healthz` reports the expected active Worker version and SHA. Health validation does not wake Go containers or depend on the unhealthy task completing.

The precise proxy is `POST /internal/runtime/feed-admin/v1/{status,replay}`. It requires the runtime bearer, `X-Feed-Operator`, contract version 1, staging target, release SHA and writer epoch headers. The runtime validates an exact command shape within 2 KiB and forwards only to the matching private adapter capability. It exposes no arbitrary URL, SQL, queue payload or service RPC.

## One command and a verifiable outcome

1. Run the workflow with action `status`, task kind `sourceEvent`, `deletion` or `coreSource`, and one exact event/deletion ID, or a positive decimal core outbox sequence. No wildcard or batch is supported. Inspect the artifact before requesting a replay.
2. Correct the identified dependency or configuration failure through the normal release process. Replay does not bypass writer fencing, deletion state or source validation.
3. Run `replay` for the same ID with an 8–500 character reason and an authorized reviewer. The workflow records `github.actor`. The command UUID is stable for a workflow run, including reruns; retain it in the incident record.
4. Inspect `commandState` and `executionState` separately. `accepted` means the adapter accepted the durable command. Only a subsequent `job.status=completed` proves completion. The client performs one status read before, at most one replay POST, and one status read after; it does not poll until success.
5. For `uncertain`, perform a separate status operation. If the exact command must be resubmitted, use its original UUID, kind, ID and reason. Never create a new UUID to hide an unknown outcome. `rejected` requires correction, not automatic retries.

A replay invocation makes at most seven requests: three metadata reads, one runtime health read, two status reads, and one replay write. Each request has a ten-second deadline; automatic retries are zero. Evidence retains bounded status fields, command identity and a reason hash, without secrets or raw task payload. GitHub artifacts retain it for 30 days; transfer the nonsecret evidence into the release/incident record when longer retention is required.

Source-event status includes `job`, current `delivery` and latest `terminalEvidence`. The delivery generation distinguishes a new replay from delayed messages from an older attempt. A terminal record with `isCurrent=false` is historical evidence and must not be interpreted as failure of the new generation. `published` proves queue publication was confirmed, not successful execution. A deletion is complete only when all necessary primary, archive and semantic cleanup phases are complete.

The source core outbox is a different lifecycle. An assessment whose event never reached the Feed execution registry may return `job:null` for `sourceEvent`; this does not mean its core transaction failed. Use `coreSource` with the exact positive decimal outbox sequence. Only a durable core `failed` record accepts a new command; pending, leased, delivered and unknown records reject. This strict command omits the Feed writer epoch and commits only against CORE_DB, while retaining the same dual operator authorization and runtime target checks. Status returns `sourceKind:coreSource`, `sequence`, source status/attempts/lease metadata and replay count/time. `source_delivered` proves only that the source queue accepted the event; check the Feed event separately for projection completion. No raw envelope is accepted or returned; do not use catalog reconciliation as an unbounded substitute.

## Failure and DLQ observation

A DLQ consumer first persists terminal evidence in the adapter and then acknowledges. Its own five failed retries move the original wrapper to `ghfind-feed-staging-terminal-parking`, which has no automatic consumer. Deployment preflight must read back the paid 14-day retention (`1209600` seconds). This is a finite recovery window, not durable storage without expiry: assign a responder and recover within 14 days; the source outbox and Feed delivery records remain the reconstruction facts. Queue replay from parking is not a public RPC or an unrestricted operator payload upload. Cloudflare documents [deletion after retry exhaustion without a DLQ](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/) and [finite configurable retention up to 14 days](https://developers.cloudflare.com/queues/platform/limits/).

Record these signals for a recovery drill: source outbox age, execution pending/lease age, replay-delivery status, deletion phase/failures, queue backlog and oldest message age, and DLQ and parking ingress plus persisted terminal evidence. Correlate by event/deletion ID and delivery generation. Use exact-ID `status` for the operator-facing evidence; use the Cloudflare Queues dashboard/API for queue metrics. Never dump queue message bodies into Actions logs.

For incident discovery before an ID is known, an administrator may use the reviewed read-only D1 diagnostics below against the **manifest-verified isolated Feed database**, with a row limit and a bound `now` in Unix milliseconds. These are administrative queries, never a runtime SQL endpoint. Confirm their query plan uses the status/lease indexes before running them against a larger target.

```sql
SELECT event_id,status,attempts,available_at,lease_until,last_error
FROM feed_execution_jobs WHERE status='dead_letter' LIMIT 20;
SELECT deletion_id,status,phase,failures,available_at,lease_until,last_error
FROM feed_cleanup_jobs WHERE status='failed' LIMIT 20;
SELECT delivery_id,event_id,status,attempts,available_at,lease_until,last_error
FROM feed_replay_deliveries WHERE status='failed' LIMIT 20;
SELECT event_id,status,lease_until
FROM feed_execution_jobs WHERE status='leased' AND lease_until<=:now
ORDER BY lease_until LIMIT 20;
```

Structured runtime failures and failed GitHub jobs are observable records. They are **not proof that an alert was delivered**. Before production acceptance, the release owner must record an assigned on-call owner, destination, thresholds for any DLQ or parking ingress / stuck deletion / projection age over 60 seconds, deduplication and escalation rules, then inject a bounded staging failure and retain the actual notification receipt and acknowledgement. No alert destination or notification delivery is configured or claimed by this change.

## Handoff and remaining gates

Handoff includes the exact commit, runtime contract version 1, manifest/resource names, Worker/image evidence, command UUID, before/after status, and any terminal delivery generation. Never include credentials. Completion still requires real staging replay with queue publication failure, lost acknowledgement and old-generation DLQ delivery, plus an end-to-end deletion recovery and an actual alert delivery drill. Production operations are unavailable until their explicit enrollment PR and protected environment pass the same checks.
