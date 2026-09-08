# Feed platform prerequisites and release gates

Use this checklist before enabling the independent Go Feed. The
[September 8 audit](../audits/2026-09-08-feed-platform.md) records what was
actually observed. This document specifies required follow-up; unchecked items
are not provisioned infrastructure or completed acceptance tests. Implement and
test locally while account administrators complete their respective items.

## Repository administrator: required checks and environments

The audited user has `WRITE` permission, not demonstrated settings administration
access. The project owner subsequently explicitly authorized merge bypass for
this implementation. It has succeeded on reviewed PRs after their complete CI
passed; record the PR head, actual CI checkout and merge SHA for each use. This
authorization does not waive validation or authorize changing protection rules.
Environment management still returns 403/404 with the available session. Do not
infer environment or ruleset administration from a successful merge bypass.

1. Open repository **Settings → Rules → Rulesets → Protect main**
   (`18206694`). Keep the current PR/review, deletion and force-push rules.
   Add **Require status checks to pass**, require the stable **Verify release**
   check from **GitHub Actions**, and require branches to be up to date before
   merging. Do not substitute an arbitrary check with the same display name.
2. Preserve `Verify release` as an always-running aggregate gate. As jobs are
   split, it must depend on Go, TypeScript, lint, both real storage contracts,
   upgrade migrations, Worker build and Docker build; missing, skipped or failed
   required jobs must fail the aggregate. Do not add path filters that let
   backend or workflow changes bypass it. Add the check after a real PR run has
   registered its exact context.
3. Restrict the existing **Production** environment to the selected branch
   `main`; prevent feature-branch deployment. Normal main releases remain
   automatic after PR approval and successful CI/staging gates; do not add a
   second manual review requirement to every normal deployment.
4. Create **Feed staging** with separate scoped credentials and its own resources.
   Create **Feed recovery** restricted to `main`, require the designated recovery
   operator's review and prevent self-review. Attach only recovery workflows to
   that environment. Record the operator/team and test that protection works
   before accepting the recovery runbook.
5. Set the deployment job's `environment` to the intended protected environment
   in the implementation PR. Environment settings have no effect on jobs that
   never reference them. The base production workflow currently has no such
   reference, so settings alone do not complete this step.
6. Review ruleset bypass actors with the repository owner. Retain only documented
   emergency authority, and require its use to produce an incident record. Do
   not remove existing administrators or alter bypass policy blindly.

Read back configuration after administrator changes; these commands do not
retrieve secret values:

```sh
gh api repos/hikariming/ghfind/rulesets/18206694
gh api repos/hikariming/ghfind/environments --jq \
  '{environments:[.environments[]|{name,protection_rules,deployment_branch_policy}]}'
gh secret list --repo hikariming/ghfind
gh run list --repo hikariming/ghfind --workflow ci.yml --limit 5
```

Save the resulting settings, check-run URL and tested rejection cases in the
release evidence. Do not report branch protection complete from a green CI run
alone. A passing historical run that skipped PostgreSQL is insufficient.

## Cloudflare administrator and platform owner

Target only account `8f19bebe359e4ec1a24c68c5f49c1584`. The audited Workers
settings show `free_tier=false`; billing subscriptions are inaccessible with the
available OAuth grant. Obtain dated billing-plan/eligibility evidence from an
account administrator, with payment details redacted. Confirm Container, D1,
Queues, R2, Vectorize/AI and registry permissions for the **Actions token**;
local OAuth permissions do not establish that token's permissions. Check secret
names and actual bounded operations, never print their values.

Create resources through the reviewed, environment-scoped Actions provision and
deployment workflows once implemented. Do not locally deploy production. Fill
the release resource manifest with actual IDs returned by provision operations:

| Resource | Staging isolation requirement | Production requirement |
| --- | --- | --- |
| Frontend/gateway | Separate Worker and OAuth callback registration | Existing frontend with rollout off by default |
| Go API and executor | Separate Worker/Container namespaces, immutable image digests | At most two `basic` API instances and one executor; independent readiness |
| Core assessment D1 | New isolated core D1 with reviewed fixtures | Existing core D1 `60d45096-bfe7-4de1-8b85-c1b66a466b0d`; additive source seam only |
| Feed D1 | New isolated Feed D1 with complete migrations | Existing Feed D1 `9c4ac13a-4c90-40a8-9d56-d7141f864bbf` for first cutover |
| Archive R2 | Dedicated bucket and restricted test data | Dedicated Feed archive bucket; do not repurpose Next cache |
| Task queues and DLQs | Distinct queues/consumers and task secrets | Finite retries, durable task state, replay and alert evidence |
| Identity/adapter secrets | Unique staging keys and short-lived request signatures | Separate keys from OAuth and unrelated services; environment-scoped |
| Semantic index/AI | Disabled until model/index manifest and bounded test exist | Separate index version and budget; enable only after semantic acceptance |

The existing `dev` core binding points to production. Do not use `--env dev`
for assessment writes, destructive contract fixtures, load or recovery tests.
The empty dev Feed database does not make the shared core safe. Do not alias an
uncreated staging resource to a production ID to make deployment pass.

All resource configurations must fail closed on unresolved IDs/credentials,
unexpected account, unintended shared storage or unsupported schema version.
The Go service must receive ordinary HTTP capability endpoints for CF storage,
not a D1 management API token or arbitrary SQL gateway.

## Billing and runtime acceptance

The approved incremental budget is **USD 100/month across production and
staging**, with projected operation at or below USD 80 and USD 20 headroom.
Existing evaluation-model spending is excluded; new embeddings and observability
are included. Validate account-specific inclusions and usage already consumed
by other applications. Billing alerts are not hard spending caps.

Containers charge for provisioned memory/disk while running and active CPU;
Workers, Durable Objects, network and logs also contribute. Use the current
[Container pricing](https://developers.cloudflare.com/containers/platform/pricing/)
and [instance definitions](https://developers.cloudflare.com/containers/platform/limits/)
when producing the estimate. Do not use the maximum instance count alone as
proof that the monthly budget is safe.

Record a dated estimate with measured active time, CPU, memory, requests, D1
reads/writes, R2 storage/operations, queue deliveries, network, logs and embedding
calls. Include staging, retries, DLQ replay, backfill and retained images.
Enforce instance, concurrency, per-call and batch limits; stop discretionary
backfills before accepted jobs or deletion recovery. Staging sleeps when idle.

On isolated staging, measure the same Go image used by ordinary Docker:

- Real `/healthz` and dependency-aware `/readyz`, build digest and contract/schema
  identity; no successful readiness merely because the process started.
  Go responses distinguish HTTP `contractVersion:"1"` from the compiled numeric
  `storageWriterVersion:2`, including when readiness fails. The storage writer
  field describes the binary's protocol, not an inferred live schema version.
  Container lifecycle probes require both fields on each API/executor response;
  missing or mismatched writer identity fails the probe.
- Cold start, concurrent requests, instance restart, temporary-disk loss and
  graceful shutdown; persistent task completion must survive each case.
- Normal p95 ≤800 ms, cold p95 ≤5 s; 10 RPS for at least ten minutes after the
  50,000-project/5,000-user/1,000,000-event fixture passes isolated CI. Record
  error rate, p99, D1 scanned rows, backlog and cost, not cache hits alone.
- Queue commit/ack failures, outbox lag p95 ≤60 seconds, deletion invalidation,
  bounded replay, application rollback ≤5 minutes and demonstrated recovery
  RPO ≤15 minutes / RTO ≤60 minutes.

Do not select Railway merely because billing evidence is inaccessible, a
resource is unconfigured or the first deploy fails. Escalate to the approved
external-PaaS fallback only with a documented CF platform limitation or measured
failure to meet the latency, recovery or budget targets after reasonable tuning.
Use fresh isolated services for that fallback, never silently reconnect the old
Railway deployment.

## Data owner: provenance and schema acceptance

Keep the operational core D1 unchanged until an independently verified
Turso/D1 comparison is available. A bounded read-only comparison must record
the endpoint/snapshot identity, cutoff watermarks, table/key sets, row versions,
content hashes and missing/different counts. Preserve differences for review;
do not print user records into build logs. Historical reports of acceptable
drift do not authorize new loss or a switch back to an outdated fallback.

Preserve the applied résumé migration from dev and test both a clean core schema
and the production upgrade shape. Never change the meaning of an applied
migration filename, delete `d1_migrations` rows or use a destructive down-migration
as application rollback. Feed migrations must preserve core ownership.

Build an initial admission manifest from verified submission receipts. Each
entry must identify the repository, analysis, receipt/evidence reference,
initiation type, receipt time, reviewer and admission decision. Restrict personal
identity/evidence records to the data system; commit only a non-sensitive
manifest/checksum summary. Completed assessment alone is insufficient. Existing
anonymous assessment submission remains available; new receipts can record that
channel without claiming an OAuth identity. Reusing an old completed assessment
must still record the current explicit submission. Missing historical evidence
stays quarantined under the new Feed path, with public project pages preserved.

Do not approve all pending tag proposals, infer submission from ownership or use
an unreviewed manually typed project list as provenance. Review proposals through
the protected governance interface and retain the decision maker and reason.

## Release owner: evidence required before cutover

Each phase hands off its base SHA, commits, public/adapter contract versions,
schema versions, resource IDs, test URLs/results, rollback point and next entry
conditions. Separate code built, code tested, code deployed and behavior observed.
No unchecked prerequisite becomes complete merely because a later phase starts.

Production release must verify upstream main CI provenance and exact SHA,
isolated staging gates, then immutable image publication **before** publishing
the Worker reference. Cloudflare's Worker/Container rollout is not atomic;
verify the active image and preserve compatibility with old instances before
enabling traffic. A prebuilt digest eliminates build-order exposure but not the
rollout compatibility window. See the
[Container deployment behavior](https://developers.cloudflare.com/containers/guides/deploy/).

The ordered cutover is internal accounts → 1% → 10% → 100%, with bounded checks
and an automated stop/rollback per step. First change runtime while retaining
Feed D1. Database promotion requires the separate snapshot/replay/checksum and
writer-fencing procedure, never just changing `FEED_STORE_PROFILE`.

Before declaring complete, retain real OAuth E2E, submission/assessment,
projection, Feed/pagination/preferences/events, deletion and recovery evidence
from a dedicated test identity. Mock tokens or mocked assessments must be
labelled as such. Production smoke has explicit request/event/cost limits and
does not perform load testing. Failure of WAF-blocked unauthenticated probes
does not establish Feed authorization correctness.

The audit's Worker rollback anchor is
`2d941c44-b50d-4c3c-95ab-32345858085a`; re-read before any release. After the new
service accepts writes, roll back application code only on the same compatible
fact source. Switching a database back requires reverse replay and a new fence.

Railway services, queues, databases and credentials remain untouched. Audit
private traffic, queue consumers, data writes, backup failure/recovery and bills
before any retirement proposal. The current failed legacy backup is not a
verified recovery path for the new Feed.
