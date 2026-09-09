# Stage 1 delivery boundary and continuation

Base main: `aa8c683fefca182428a48c180af7e862f7469929`.
Branch: `codex/feed-acceptance-stage1`.
Status: implementation and local validation in progress; **not accepted in CF,
not merged, no production rollout**. Exact final pre-push SHA, raw local receipt,
CI run and post-push CF observation belong in the PR's evidence section.

## Implemented boundary

- The ordinary Go API/executor, actual Next OAuth callback and source finalization
  run through complete local journeys on workerd D1/R2 and PostgreSQL/pgvector
  with MinIO. Only external GitHub/assessment-provider transports are fixtures.
- The gateway supports a Cloudflare service binding while preserving signed
  identity and the Docker HTTP transport. Staging source creation/status routes
  require the two approved identities and up to four approved repositories.
- CI separately proves exact push checkout and PR merge compatibility. All four
  mandatory jobs emit source/tree receipts; the complete local E2E cannot skip a
  profile. New native Node tests are required independently from Vitest.
- The reusable staging workflow requires actual repository protection readback,
  isolated resources, dedicated credentials and holder logins. It builds/pushes
  the image before Worker changes, reads actual versions, executes real OAuth and
  assessment, and derives a current-run receipt only after the final readback.
- Production remains automatic after exact main CI and same-SHA staging E2E.
  Its legacy Feed setting and approved production migration boundary are retained.

Public Feed HTTP contract stays **1**, storage writer stays **2**. No core or Feed
migration is added by this delivery. The Web deployment manifest is **2**, with
an explicit validated conversion to the existing runtime manifest **1**. CI,
local journey, remote journey and staging receipt formats are separately versioned
and not interchangeable. Go can still run without Next/Cloudflare; full portable
image E2E and actual migration/restore acceptance remain stage 4.

## Actual prerequisites and unresolved gates

| Gate | Current evidence / next action |
| --- | --- |
| CF Workers Paid | Dashboard verified on September 9; see the [follow-up audit](../audits/2026-09-09-feed-stage1-prerequisites.md). Measured Feed costs remain unaccepted. |
| GitHub settings rights | Active `AsperforMias` session has push but no admin. Creating `Feed staging` returned actual HTTP 403; current policies fail `--verify-existing`. |
| Required checks and environments | Administrator must apply and read back the [guarded configuration](../feed-github-protection.md). No E2E or PR bypass exempts this gate. |
| Dedicated credentials | Staging CF, service, OAuth and provider credentials must be installed in the dedicated environment. No values belong in the repository or evidence. |
| Two identities and approved repositories | Names/IDs and up to four repository keys must be supplied; holders complete their first dedicated OAuth login. |
| Isolated resources | Existing core/feed D1, archive and three queues have audited IDs. Business schema, consumers and the new Web cache still need Actions provisioning/deployment/readback. |
| Full integrated local E2E | Must rerun at the final clean branch HEAD before every push, including after any subsequent fix/rebase. Intermediate worktree passes cannot authorize another SHA. |
| Real CF E2E | Not run. No Container, Web Worker or runtime has been deployed by this delivery yet. No merge until it passes. |

Missing settings permission is an external prerequisite, not evidence that CF
cannot support Feed. Do not activate external PaaS or weaken checks to bypass it.

## PR and release sequence

1. Commit each purpose independently. Run the complete local dual-profile journey
   and all changed checks on the clean exact HEAD. Preserve failed attempts.
2. Push only that validated HEAD and create a detailed draft PR. Read CF immediately
   after the push and record actual production/staging state, even if unchanged.
3. Wait for exact push CI and PR compatibility CI. Once prerequisites exist,
   dispatch `feed-staging.yml` at the candidate ref with its full `release_sha`.
   Its environment lock covers deploy, E2E and final readback.
4. Attach source/tree, commands, raw artifacts, image digest, Worker/Container
   versions, schema/resource identities, flags, costs and remaining gaps to the PR.
   Merge only after the real remote gate passes. Use **merge commit** by default;
   rebase is allowed with a fresh validation cycle. **Never squash.**
5. Validate the actual merged main SHA afresh. Production cannot borrow the
   branch's receipt, an older run attempt, mocked login, or a green badge alone.

## Rollback and next-stage handoff

This delivery has no production data promotion or traffic change to reverse.
If rejected before merge, leave production as-is and fix the candidate branch.
For a staging program rollback, redeploy a previously validated compatible SHA
through Actions using the same D1 facts. No table removal, reverse destructive
migration, ad hoc local deploy or old unvalidated program is a rollback method.

The release owner must serialize schema application, deployment and environment
tests. Subagents may independently prepare code/tests and read-only evidence;
they may not concurrently overwrite staging or change shared migrations.

Stage 2 and stage 3 start only after stage 1's real gates pass. Stage 2 owns CF
lifecycle/fault/DLQ/nonempty archive deletion/alerts/load/cost evidence. Stage 3
owns complete transactional changes, cross-profile mapping and atomic persistent
transfer. They share three subagent slots and one integration owner. Stage 4
waits for both, then stage 5 production rollout, stage 6 semantic validation and
stage 7 operations follow the approved dependency graph. Historical/Turso and
legacy Railway read-only audits may proceed independently; no legacy deletion
or database authority change is authorized by this handoff.
