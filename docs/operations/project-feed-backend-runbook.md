# Cloudflare-native project Feed runbook

## Scope and operating boundary

The personalized project Feed is a same-origin Cloudflare Worker API backed by
the dedicated `GHFIND_FEED_D1` database binding. It does not run a Railway service,
Vercel function, PostgreSQL database, RabbitMQ worker, Gorse instance, Redis
cursor store, or a scheduled directory scan.

`project_analysis_runs` and `project_assessments` remain in the core
`GHFIND_D1` evaluation store. The `feed_*` tables introduced in dedicated Feed
migration `migrations-feed/0001_feed_baseline.sql`
are rebuildable Feed projections and Feed-only user facts. A Feed fault must
never fail an assessment finalization, score, leaderboard, OAuth, or project
detail request.

Current production algorithm: `cloudflare-tag-quality-v1`.

- Candidate facts are completed evaluations that are source-inspected or
  stronger, have no critical risk, and have no unoverridden `high` risk in
  `license`, `security`, `supply_chain`, or `privacy`.
- Canonical tags are eligible for recall. Assessment tags with a free-form
  namespace/slug are stored as evidence-backed proposals and have zero recall
  effect until an administrator creates or maps a canonical tag.
- The baseline ranks tag affinity, saved-tag similarity, product score,
  confidence, freshness, and long-tail exposure; MMR limits repetitive tags.
  There is no online embedding, LLM ranking, Gorse, or hidden model fallback.
- A signed, principal-bound cursor fixes a deterministic candidate sequence
  for 30 minutes. Impression tokens bind a user, project, request and rank.

## Deployment prerequisites

The existing `deploy-cf-production.yml` workflow applies both D1 migration
streams before deploying the OpenNext Worker. Do not manually apply either
stream to production while that workflow is in progress.

`ghfind-feed-dev` and `ghfind-feed` are separate D1 databases. A development
deployment or local migration must never point at the production Feed database.

Required existing Worker secrets:

- `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, and `AUTH_SECRET` for GitHub OAuth.
  `AUTH_SECRET` also signs Feed cursors and impression tokens; there is no
  second Feed signing secret.
- `FEED_ADMIN_SECRET` for internal Feed reconciliation and taxonomy-review
  endpoints. It must be different from OAuth credentials and never supplied to
  a browser.

Optional Worker variable:

- `FEED_MODE=baseline` (or omit it) enables the D1 baseline.
- `FEED_MODE=off` is the serving kill switch. `DELETE /api/feed/profile`
  remains available so user data deletion is not blocked by an incident.

The Feed migration creates Feed-only tables, the active taxonomy version, and
the closed-enum artifact/lifecycle tags. Historical directory projection and
product-tag proposals are then created by the bounded reconciliation endpoint
below; they are deliberately not a cross-database migration query.

## Post-deploy activation

After the main deployment completes, verify a signed-in GitHub account can
call these same-origin APIs:

1. `GET /api/feed/tags` returns taxonomy version `1` and canonical tags.
2. `GET /api/feed/preferences` lazy-creates the Feed profile.
3. `PUT /api/feed/preferences` accepts no more than 30 unique canonical
   `tagId` entries with `value` `1` or `-1`.
4. `GET /api/feed/projects?limit=20` returns only publishable assessed
   projects. An empty `items` list is valid while the catalog is small.
5. `POST /api/feed/events` accepts `{ "events": [...] }` with at most 50 UUID
   events; an `impression` represents at least 50% card visibility for one
   second.

The Worker projects each newly finalized project analysis immediately after
the evaluation transaction commits. This projection is deliberately
best-effort: failures are logged as `feed.project_projection_failed`, while the
evaluation remains completed. Historical repair is explicit, bounded, and
operator-triggered, not a periodic full-table scanner:

```sh
curl -fsS -H "Authorization: Bearer $FEED_ADMIN_SECRET" \
  "https://ghfind.com/api/internal/feed/reconcile?limit=100"
```

If `nextCursor` is returned, invoke the endpoint again with its `updatedAt`
and `repoKey` values until it is `null`. This is a repair tool for a failed
projection or an intentional taxonomy migration; it must not be scheduled as
a perpetual sweep.

Review proposed assessment tags before they can affect recommendations:

```sh
curl -fsS -H "Authorization: Bearer $FEED_ADMIN_SECRET" \
  "https://ghfind.com/api/internal/feed/tags/review?limit=100"

curl -fsS -X POST -H "Authorization: Bearer $FEED_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"proposalId":"…","action":"create","reason":"evidence reviewed"}' \
  "https://ghfind.com/api/internal/feed/tags/review"
```

`action: "map"` requires an existing `canonicalTagId`; `action: "reject"`
preserves the audited proposal but never puts it in recall. There is no fuzzy
or embedding-based automatic acceptance.

## Fault handling and rollback

- D1 unavailable: only `/api/feed/*` returns `503 feed_unavailable`; the rest
  of the Worker remains independent.
- A user changes preferences or project state: their old cursor returns
  `410 feed_cursor_expired`, requiring a fresh stream. This prevents pages
  being continued against a different profile.
- A stale or cross-user impression token returns `400
  invalid_impression_token`; do not retry it with another account.
- Feed API rate limits are D1-local and per user: feed reads 60/minute,
  events 120 batches/minute, preferences/state 20/minute. The rate-window
  cleanup is scoped to the requesting user and is not a background sweep.
- To stop serving quickly, set `FEED_MODE=off` in the Worker environment and
  deploy the normal Cloudflare release. Do not drop `feed_*` tables or revert
  a production D1 migration.

Cloudflare D1's backup/restore controls are the disaster-recovery mechanism
for Feed-only facts. Since the project catalog is reconstructible from
assessments, recovery priority is user preferences, saved/not-interested state,
served-item logs, and immutable events. No operation should restore a D1
backup into a production binding without the existing Cloudflare recovery
change procedure and a scratch validation first.

## Explicitly deferred capabilities

Semantic embeddings, pgvector, Gorse, collaborative filtering, online
bandits, paid tagging providers, LLM re-ranking, sponsored candidates, and
front-end infinite-scroll behavior are intentionally outside this deployment.
They require their own data-protection, offline-evaluation, and cost decision;
none is silently activated by the baseline APIs.
