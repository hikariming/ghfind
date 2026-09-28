# Feed stage 1 prerequisites: September 9 follow-up

Base: `aa8c683fefca182428a48c180af7e862f7469929`.
Observed September 9, 2026, 11:00–11:10 Hong Kong time (UTC+8).
This follow-up separates newly verified prerequisites from deployment acceptance.

## Cloudflare paid eligibility: verified

The authenticated Beiming account dashboard's
[Workers plans page](https://dash.cloudflare.com/8f19bebe359e4ec1a24c68c5f49c1584/workers/plans)
marks **Paid** as the current plan, priced at USD 5/month plus usage, and lists
Containers among the included products. Its Container memory, CPU and disk rates
match the existing planning calculator and the
[official rate card](https://developers.cloudflare.com/containers/platform/pricing/).

This supersedes the *unknown subscription eligibility* conclusion caused by the
earlier API 403. It does not change that API response into a success, prove an
invoice was paid, or establish the new Feed's measured cost. Shared-account
usage is not attributable to the new Feed, which has not been deployed.
The monthly planning ceiling remains USD 80 with USD 20 headroom; actual
Containers/D1/R2/Queues/Workers/DO/logging and embedding costs remain a staging
acceptance gate. No plan upgrade or financial action was performed.

## GitHub configuration permissions: insufficient in the active session

An explicit repository API GET and the browser both identify the active user as
`AsperforMias`. API permissions are `push=true`, `admin=false`, `maintain=false`.
The repository Settings page states that this session cannot access repository
options. The browser account switcher has no other authenticated account.

At 11:09 Hong Kong time, an authorized attempt to create the missing `Feed staging`
environment with custom deployment branch restrictions returned HTTP 403:
`Must have admin rights to Repository.` The environment was not created.
This was a GitHub authorization rejection, not an automatic tool approval
rejection. Existing PR merge bypass does not confer repository settings rights.

The successful environment listing still contains only `copilot`, `Preview` and
`Production`, without deployment protection rules or branch restrictions.
Required checks and dedicated Feed environments must be configured by a session
that actually has repository administration rights before stage 1 is accepted.
Do not weaken the release gate to work around this prerequisite.

## Remaining prerequisites and evidence boundaries

- Dedicated staging Cloudflare credential and independent service/OAuth/provider
  credentials must be installed in the correct GitHub environment, without
  placing values in source, command arguments, PR text or public artifacts.
- Two dedicated GitHub test identities and up to four approved repository keys
  must be recorded in the manifest. Account holders perform the initial login.
- The independently registered OAuth callback must match the isolated Web
  origin; the legacy dev environment still shares the production core D1.
- Complete local dual-profile E2E must pass before every branch push. Accurate
  HEAD CI and real CF OAuth/assessment/async E2E must pass before PR merge.
- Every push is followed by CF state readback; stage 1 does not enable production
  Go traffic or extend the production migration allowlist.

No Worker, Container, database schema, queue consumer or production route was
deployed by this prerequisite verification. Historical partial Docker and Linux
capacity reports retain their original scope and source identities.

## Isolated Web cache creation and readback

At 11:49 Hong Kong time the pinned-account Wrangler read returned R2 code
`10006` for `ghfind-feed-staging-web-cache`: the bucket did not exist. The
approved stage 1 resource was then created with `--update-config=false`, APAC
location hint and Standard storage class. Remote creation time is
`2026-09-09T03:49:45.259Z`. Subsequent reads confirmed the exact name, APAC,
Standard, zero objects/bytes and disabled public `r2.dev` access.

This is an empty staging resource creation, not a Worker deployment or business
acceptance. The existing five-resource provisioning receipt/hash is unchanged;
the Web cache has its own [readback record](../evidence/feed-stage1-web-cache.json).
No schema, queue consumer, production binding or traffic flag changed.
