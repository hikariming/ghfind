# Local D1 candidate query audit

This is an explicit, bounded **local workerd/D1** experiment. It does not use
remote bindings, real repository data, OAuth accounts, or GitHub API calls.
From `platform/feed`, run `pnpm capacity:local`. The command typechecks the
fixture, creates fresh local test databases, seeds 50,000 synthetic projects,
executes three `FeedStore.candidates` calls, and compares every recalled branch
with the pre-change SQL on the same data. It saves actual binding observations
to `../capacity-results/candidate-capacity.json` relative to this directory.
This file snapshot is deliberately updated on each explicit run because elapsed
times vary. Ordinary `pnpm test` excludes capacity fixtures; it runs the smaller
hard-filter and migration regression tests.

The fixture has 50,000 valid assessment artifacts, completed source runs,
matching current assessments, explicitly synthetic `verified_backfill` receipts,
delivered source outbox records, and corresponding published Feed projections
with matching projection hashes and analysis IDs. The raw assessment SHA is
distinct from the projection SHA. Every fixture description and receipt makes
the synthetic origin explicit. These are schema-valid bootstrap fixtures, not
evidence that the live assessment or Queue pipeline executed. The fixture has
one user, zero events, 49,950 common-tag projects, 50 rare-tag projects and 2,500
long-tail projects. No historical consent is inferred and no proposals are
approved. Local core migrations 0005/0006 are required for the synthetic source
records; no production migration is run by this command.

## Observed query work

Baseline is the adapter at commit `6326cda` (prior Feed schema migrations through
0006), before candidate changes. Raw baseline observations, including SQL and
`EXPLAIN QUERY PLAN`, are in `evidence/baseline.json`. The initial query
optimization is commit `4fe8e6e`. Current observations include
governance/assessment fences at `65cfb2f`; the harness records the full checked-out
implementation SHA automatically. Optimized observations are
in `../capacity-results/candidate-capacity.json`; that report records applied
migration names and tool versions. Migration 0008 is index-only and changes no
facts, epoch or reader/writer compatibility contract. This independent branch
does not contain the integrator's schema-compatibility migration 0007; it does
not affect the measured candidate queries.

| User preference | Baseline total rows read | Current total rows read (`65cfb2f`) | Tag/latest/quality/discovery | Merged items |
| --- | ---: | ---: | --- | ---: |
| No positive tags | 151,069 | 709 | 0 / 40 / 20 / 20 | 78 |
| Common `artifact:micro-tool` | 2,085 | 2,240 | 80 / 40 / 20 / 20 | 154 |
| Rare `artifact:database-infra` | 201,546 | 1,492 | 50 / 40 / 20 / 20 | 127 |

Totals include the actual user/preference reads, all recall queries, tag hydration
and impression lookup performed by the store. They exclude fixture generation,
old-query comparison and EXPLAIN calls. `rowsRead` is the unmodified D1 binding
`meta.rows_read`, including index work. A `SEARCH ... USING INDEX` plan alone
does not prove bounded work: the former rare-tag query used the published-order
index yet read 200,051 rows to find only 50 matches.

The changes address that observed behavior:

- Empty positive preferences do not execute a tag query (formerly 150,000 rows).
- A tag-index probe reads at most 512 memberships to choose an equivalent plan.
  It returns a count, never candidate IDs. Common tags retain the catalog-order
  walk (401 rows for 80 items here); the probe adds 514 reads in this fixture.
- Sparse tags materialize **all** matching repositories with the tag-id index,
  then use primary-key lookups and the unchanged hard filters before sorting
  and limiting to 80. The rare set takes 53 probe reads plus 303 candidate reads.
  Temporary DISTINCT/order B-trees are limited by the complete sparse match set
  in this snapshot (50 matches), rather than the whole catalog. No business
  candidates are clipped by the probe limit.
- Latest and quality already use their exact ordering indexes and are retained.
- Migration 0008 adds a partial index matching discovery's exact OR predicate
  and ordering. Discovery now reads 40 rows (no preferences) or 60 rows (one
  explicit positive preference) for 20 items, versus 401 or 421. EXPLAIN uses
  `idx_feed_projects_discovery_order` without a temporary ordering sort.

The initial common-tag total rose by 153 reads: the new probe costs 514 and
the discovery index saves 361. With the later taxonomy and current-assessment
fences, the total difference is 155 reads (2,240 versus 2,085). This tradeoff removes the much larger empty/rare scans without
forcing dense tags to materialize and sort the entire catalog. Concurrent writes
between probe and recall can change the best plan, but both plans always query
the full current matching set and preserve eligibility. Large numbers of hard
exclusions or changing tag distributions can still require substantial reads;
this experiment does not establish a universal per-request read bound.

## Timing and acceptance boundaries

The baseline single method samples were 244 / 7 / 262 ms (empty/common/rare).
The initial optimized record was 6 / 10 / 4 ms; another pass was 13 / 16 / 12 ms.
After governance/assessment fences, the recorded pass is 5 / 6 / 4 ms,
illustrating local sample variability. These are small local samples on a shared development
machine, with no HTTP gateway, Container startup, Go ranking, network latency,
remote D1, or 10 RPS load. They are not p95/p99 measurements or SLO acceptance.
Each query's `durationMs` includes waiting for the real binding while recall
branches run concurrently; optimized `engineDurationMs` comes directly from D1
`meta.duration`. Baseline reports did not capture engine duration. A reported
zero is the binding's timer resolution, not proof that a query has no cost.

Normal contract tests cover both sides of the plan threshold, two overlapping
positive tags, deterministic ordering, and 180 higher-ranked rows rejected for
unpublished, stale-analysis, revoked-evidence, moderation, project-negative and
explicit-tag-negative reasons. They also recheck withdrawal after recall and
reapply the index migration twice without changing facts. The 50,000-project
experiment compares exact ordered repo IDs for every branch with the previous
SQL and enforces fixture-specific read regression bounds.

The follow-up at `65cfb2f` additionally checks the same 50,000 current-assessment
fixture after tag membership/hydration and behavior filters were restricted to
the current analysis. All ordered branch candidate IDs still match the pre-change
queries on this fixture. Dedicated governance tests cover stale assignments on
both sides of the sparse/dense threshold; this capacity fixture intentionally
contains current assignments only. No records or source evidence were removed
to obtain the measured improvement.

Remaining release gates include 5,000 users and 1,000,000 events, complete Go/API
contracts at scale, the prescribed bounded staging concurrency run, D1 remote
row/latency evidence, cold starts, and full cost accounting. No production
rollout or readiness claim follows from this query audit.
