# ghfind Review GitHub App

**English** · [中文](./README.zh.md) · [Project README](../../README.md)

**Your review time is scarce. Make every first look more informed.**

A busy queue should not mean opening every author's profile by hand. ghfind Review
adds a public-profile score label to each issue. The band is visible in the issue
list, so you can prioritize attention before a deeper look.

[**Install ghfind Review on your first repository**](https://github.com/apps/ghfind-review/installations/new)

## Turn score bands into a review queue

Use the five `review:` labels to define your team's triage policy. Lower bands
stay visually quiet; soft apricot and wheat mark the higher bands without a harsh
block of color.

Paste these filters into your repository's Issues search:

| Review queue                           | GitHub search                                      |
| -------------------------------------- | -------------------------------------------------- |
| High-band issues                       | `is:open is:issue label:"review: high"`            |
| Highest-band issues                    | `is:open is:issue label:"review: top"`             |
| Low-band issues needing a source check | `is:open is:issue label:"review: low"`             |
| Missing scores needing manual context  | `is:open is:issue label:"review: no-score"`        |

Start with a queue that fits your available review time. Use low and no-score
bands as a prompt to inspect the source and submission before spending more time;
use higher bands to find authors with stronger public-profile signals. This gives
you a practical first screening step for potentially low-quality incoming work.

The thresholds are currently fixed at **40, 70 and 90**; per-repository threshold
configuration is not available. You choose how to handle each band using GitHub
filters and your team's process. By default the App only labels issues and pull
requests. It posts conversation comments or intent labels only when a repository
admin turns them on in [repository settings](#repository-settings), and it never
blocks or closes submissions. The score measures the author's public profile, not
the submission's quality, and a new contributor may have a limited public record.

Missing labels are initialized automatically. All actions use the independent
**`ghfind-review[bot]`** identity and ghfind avatar.

## Install

The service is live at <https://bot.ghfind.com>. Install
[ghfind Review](https://github.com/apps/ghfind-review/installations/new).
The registered App is owned by **AsperforMias** (App ID `4950248`) and writes as
`ghfind-review[bot]` with the ghfind avatar. Production processing is open to all
accounts (`ALLOWED_ACCOUNTS=*`). Each owner must install the App and choose the
repositories it may access.

1. Follow the installation link and select repositories. Grant **Issues: read and write**, **Pull requests:
   read and write** and the implicit **Metadata: read** permission.
2. The App automatically creates missing `review: low`, `medium`, `high`,
   `top`, and `no-score` labels. Existing issues and pull requests are not
   queued; a repository admin can [backfill](#repository-settings) them later.
   Owner-customized colors and descriptions are preserved;
   original bot-owned grey defaults are upgraded to the palette below.
   Archived labels and case conflicts are reported for the owner to fix.
   Issues already labeled `review-level:` keep that older, longer name.
3. The installation setup page offers GitHub sign-in to view accessible
   repository jobs. Retrying a failed repository job requires repository admin
   permission. Sign-in is optional for automatic labeling. The same sign-in
   opens [repository settings](#repository-settings) at <https://bot.ghfind.com/admin>.
4. Open a new issue or pull request. An empty description is fine. Processing is asynchronous;
   wait for the queue, then refresh. The `review:` label is added by
   `ghfind-review[bot]`.
5. If your repository already uses the old `PR review level` Actions workflow,
   disable it before switching to this App to avoid duplicate processing.

You do not need to add a workflow, personal access token or secret to your repository.
For personal repositories, installation is managed by the account owner; organization
installations may require an organization owner to approve the request.

### Existing installation: accept Issues permission

Open [GitHub Settings → Applications → Installed GitHub Apps](https://github.com/settings/installations),
select **Configure** for ghfind Review, then **Review request → Accept new permissions**
if prompted. Issues read/write access is required alongside Pull requests read/write.
New installations request both automatically.

### Troubleshooting and removal

| Symptom                            | What to check                                                                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No label                       | Confirm the App is installed on this repository and required permissions were accepted, and that issues or pull requests are switched on in repository settings. Existing items are labeled only after an admin runs **Backfill existing items** in repository settings. Open the installation's setup page and sign in to inspect job status. |
| Initialization fails               | Check for archived labels or conflicting capitalization; fix them in the repository's Labels page, then use **Retry (admin)** on the setup page.                                                          |
| `review: no-score`                 | The score is missing, invalid, or could not be retrieved within the retry budget. It is not zero. A missing GitHub account stays no-score. A timeout or cloud error is retried 20 and 60 minutes later; a recovered score replaces the label. After 60 minutes, only the author or a repository admin can comment `@ghfind-review` on that issue to rescore it and update the label. |
| Want to stop processing            | Remove the repository from the App installation, suspend it, or uninstall it. Existing labels remain.                                                                                         |

The setup page is reached from the App installation flow/settings; it requires GitHub
sign-in for status visibility. Only repository admins may retry failed jobs.

The score thresholds match PR #288 at `f72a4b3`: 40, 70 and 90. A score outside
0–100, a missing score or exhausted score retries produces `review: no-score`, never
an inferred zero. This is an author-profile signal, not a code-quality review or
permission to merge. New issues and pull requests are labeled from
`issues.opened` and `pull_request.opened`.
The author or a repository admin can comment `@ghfind-review` on an open
no-score issue to request one fresh score; the label is updated.
Installing the App, or adding a repository, only sets up labels. Existing open
items are queued when a repository admin runs a backfill from repository
settings. Backfilled issues and pull requests do not send email. A later new
issue or pull request can.
Closed items are left untouched. Editing or reopening an existing issue does
not score it again.

## Repository settings

Sign in with GitHub at <https://bot.ghfind.com/admin> (also linked from the home
page and the setup page). The page lists the App installations you can access,
then the repositories in an installation that your GitHub account can reach.
Settings are keyed by the GitHub repository ID, which is globally unique, so
they survive same-owner renames and uninstalling/reinstalling the App (the row
also records the last installation that saved it). A transfer to a new owner
resets AI opt-ins, selected intent labels and custom comment prompts; the new
owner must opt in again. Reads require repository write or admin access.

- **Who can see and change them.** Signed-in users with repository **write** or **admin**
  access through the installation can view its settings. Saving requires
  repository **admin** permission, checked live with your GitHub token on every
  save (the same rule as Retry); everyone else gets a read-only form. Saves are
  same-origin form posts with a CSRF token. An installation or repository ID in
  the URL never grants access by itself.
- **Issues / pull requests.** Two switches, both on by default, control whether
  new issues and new pull requests are scored and labeled. They are checked when
  a job runs, so turning one off also stops jobs already queued.
- **Backfill existing items.** Install, adding a repository, unsuspending and
  accepting new permissions only set up labels. A separate form on the
  repository page queues the newest 1–100 open items (default 25) in one GitHub
  request, newest first, obeying the issue and pull request switches. It has the
  same admin, origin and CSRF checks as saving, remembers the chosen number, and
  is refused while a backfill for that repository is pending or running. The
  page shows the last backfill's state, time and result. Every run processes its
  items again, even ones handled before, so running it after turning on intent
  labels reaches existing items. Backfilled items
  never send a score email or get a comment.
- **Intent labels (off by default).** The admin ticks which of the repository's
  existing labels the bot may use; `review:` labels are excluded. For each new
  issue or pull request, the title and the first 8,000 characters of
  the description (passed to the model as untrusted data) and the ticked labels with
  their GitHub descriptions go to the LLM, which picks at most three. The bot only
  adds labels that are ticked and still exist; it never creates, renames or
  removes labels, and it skips an item that already carries a ticked label.
  Rescore and mention jobs do not triage again.
- **Comments (off by default).** When on, the bot posts one score comment for
  each author in the repository (no-score comments are also capped at three per
  repository). An optional prompt sets the language and tone: the LLM sees only
  that prompt and the score facts, never the issue text, and writes a short
  plain-text greeting above the fixed score table. Links, mentions, markdown and
  HTML are stripped from the greeting; the table is not changed. Without a prompt,
  or if the LLM fails, the plain table is posted. Backfill never comments,
  and rescores only update an existing comment.

Production intent classification is configured with `TRIAGE_PROVIDER=jev` and
the `OPENROUTER_API_KEY` secret for Jev's OpenRouter Decisions API. Local/staging
configuration retains `TRIAGE_PROVIDER=llm` with the optional `LLM_API_KEY`.
AI greetings independently use `LLM_API_KEY`;
unavailable greetings fall back to the plain score table. Missing classifier
credentials disable intent labeling. Issue and pull request text is never stored;
opting in sends it to the configured classification provider.

## Bring your own AI service (BYOK)

The repository's **AI service** tab lets an administrator choose the platform
service or a separately configured service for that repository. From
<https://bot.ghfind.com/admin/repositories>, open a repository and select
**AI service**. Supply a public HTTPS API base URL, API key, model identifier and
protocol, save the settings, then explicitly run **Test connection**. Saving or
testing does not enable content classification: intent labels remain off until
the administrator enables them and selects existing repository labels.

- **OpenAI-compatible Chat Completions (`llm`)** supports both content
  classification and generated comment greetings. Comments have their own
  opt-in switch and prompt; the author-score table is not an AI code review.
- **Jev Decisions (`jev`)** supports content classification only. It does not
  generate greetings.
- **Repository isolation.** Configuration and encrypted credentials belong to
  the repository ID and current owner, with live repository permission checks.
  Reading needs repository write access; saving, replacing or removing keys,
  and connection tests require repository admin access. A different repository
  cannot reuse the saved credentials through its settings. Same-owner renames
  keep the configuration; transfer to a different owner disables the previous
  provider configuration and credentials until the new owner configures the
  service explicitly. A key from the previous owner is never inherited.
- **Credential handling.** API keys are encrypted at rest and are never echoed
  back into HTML or API responses. A saved-key indicator is not the key itself.
  Leave the key input empty to keep a saved key, enter a new key to replace it,
  or use the explicit remove-key action. Changing the endpoint or protocol
  requires a fresh key so an existing credential cannot be sent to a different
  service by changing only its URL. Secrets stay on the server; browser storage and
  frontend environment variables must not contain them.
- **Testing and billing.** Test connection is an explicit request using the
  saved configuration. It stores no Issue/PR sample text and makes no GitHub
  writes. Your provider bills requests made with your key, including the test.
  Failure of a repository's own service never silently falls back to the
  platform service; optional classification or greeting generation must report
  or handle the failure without using platform AI credentials.
- **Endpoint boundary.** Supply an HTTPS base URL with a public hostname, not a
  complete request URL with query parameters or a fragment. IP literals,
  private/internal hostnames and URL credentials are rejected. Requests do not
  follow redirects, so a provider cannot redirect the saved credential to
  another host. Select the protocol explicitly; a model name does not select
  the protocol for you. Public A/AAAA answers and CNAME chains are checked before
  each request, with bounded DNS time and response size. Workers fetch performs
  its own DNS lookup afterward, so this is not DNS address pinning and does not
  eliminate a rebinding race. Adding private/VPC egress requires a separate
  endpoint policy.

### Operator setup for BYOK

Apply the additive bot migration `0008_byok.sql` before enabling the repository AI
service routes. It stores provider configuration and encrypted key ciphertext;
it does not put plaintext API keys in D1. Configure the Worker secret
`BYOK_ENCRYPTION_KEY` with **32 random bytes encoded as base64url**. Generate a
new value once with Node's `crypto.randomBytes(32).toString("base64url")` and
install it through Wrangler's secret input, outside version control. This is an
operator encryption secret, separate from a user's provider API key and from
`LLM_API_KEY` or `OPENROUTER_API_KEY`.

Keep this encryption secret stable across deployments. Replacing it without a
planned re-encryption process makes previously saved keys unreadable. There is
no automatic re-encryption command; affected users must provide their keys again.
Unreadable BYOK keys disable AI without switching to platform credentials. Do not
add it to public Worker vars, the frontend bundle, example configuration or
request logs. BYOK needs the encryption secret even when platform AI providers
are unavailable; platform configuration alone does not enable any repository's
classification switch.

### BYOK API

Use the existing `Authorization: Bearer ghf_...` authentication with an
explicit `bot` token scope. Changes and tests recheck current GitHub admin
permission; reads use the existing one-minute permission cache and require
repository write access. These routes do not return the provider API key.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/repos/{owner}/{repo}/ai-provider` | Read provider metadata. |
| `PATCH` | `/api/v1/repos/{owner}/{repo}/ai-provider` | Choose platform or BYOK settings; optionally replace the key. |
| `POST` | `/api/v1/repos/{owner}/{repo}/ai-provider/test` | Explicitly test the saved connection; send JSON `{}`. |
| `DELETE` | `/api/v1/repos/{owner}/{repo}/ai-provider/key` | Remove the saved BYOK key; send JSON `{}`. |

Send `Content-Type: application/json` with write/test requests. A BYOK update
contains `mode: "byok"`, `provider: "llm"` or `"jev"`, `base_url`, `model`, and
an optional `api_key`. A first save or an endpoint/protocol change requires a
new `api_key`; omitting it or sending an empty string keeps a valid existing
key only for the same endpoint and protocol. Keys must contain 8–4,096 printable
ASCII characters without internal spaces; outer spaces are trimmed. For Jev, the model must belong to
the supported `typesafe/jev-1.13` family. Use `{"mode":"platform"}` to explicitly
select the operator-managed platform provider. Switching modes does not remove
a saved BYOK credential; use the separate key removal endpoint to do that.
Removing the key selects BYOK with no usable credential, rather than silently
enabling the platform provider.

Provider metadata contains only
`{mode, provider, base_url, model, has_key, storage_available, ready, updated_at}`.
`has_key` indicates credential presence for the selected service, not the key itself;
`storage_available` reports migration/encryption configuration availability.
`ready` describes locally usable configuration, not a successful upstream
connection test. `updated_at` is an ISO 8601 timestamp string, or `null`
for a configuration without a saved update. Keys, ciphertext, upstream response
bodies and submitted sample text must not be exposed as provider metadata.

## Desktop console

After GitHub sign-in, `/admin` opens the global Dashboard. Its flat metric strip,
account health table, Issue/PR processing table and activity history use current
authenticated memberships and live repository write permission. `/admin?installation_id=…`
opens an account dashboard; repository, task, activity and installation pages
remain separate sidebar destinations. Dashboard navigation clears account filters,
while the other destinations keep the selected account.

Global reads check at most four accounts and 25 repositories per account on each
page, with one bounded repository listing per account. Account and repository
pagination and coverage text identify incomplete scope. Counters cover jobs
updated in the last 30 days within that scope; tables show retained history.
Scoped task and activity pages have independent filters and pagination. Activity
is repository-scoped history: older records have no installation or owner
provenance and must not be interpreted as an installation audit trail.

Installation management keeps the selected workspace. The account menu offers
All accounts and native account links, supports keyboard navigation, and resets
repository-specific filters on account changes. Repository forms preserve list
filters, page and language, warn before discarding unsaved settings, and prevent
duplicate submissions with pending feedback. Statuses use plain text and marks;
settings use ruled sections instead of stacked cards.

Issue and PR jobs share each repository's GitHub number order, ascending, applied
before SQL pagination. Repositories group by current canonical name; immutable
admission time and binary job ID break ties, and unnumbered operations follow
numbered items. Changing parallel-consumer completion timestamps does not reorder
the task list or legacy setup list (issue #370). Chronological activity and the
API's recent-job summary retain their own purposes.

Repository settings have separate settings, AI service, preview, backfill, cleanup and
activity tabs. Processing switches require current admin permission and affect
future events. Historical scans remain explicit. Intent preview sends a sample
title/body to the same classifier using saved, current allowed labels; it never
changes GitHub or saves the sample. It is limited to one request per repository
per minute, including failed provider calls.

For a local desktop preview, run
`pnpm exec tsx platform/github-app/scripts/dev-dashboard.mts --installations=2`
from the repository root and open `http://127.0.0.1:4201/admin`. This runs the
actual Worker with all migrations in isolated ephemeral D1 and synthetic GitHub
identity, repositories and history. GitHub writes and background consumers are
disabled; classification is disabled by default. Add `--jev` only to explicitly
enable real model calls with the private local credential file. The preview is
not production acceptance or a replacement for GitHub OAuth testing.

Use `--installations=0`, `=1` (default), or `=2` to check empty, single-account,
and multiple-account states. While the preview runs without `--jev`, run
`pnpm exec tsx platform/github-app/scripts/dashboard-ux-acceptance.mts`
to exercise global/account navigation, native account switching, forms, browser
Back, numeric task order, and light/dark/auto themes in English, Chinese and Arabic
at desktop/mobile sizes. The script submits a disabled-provider preview to check
its error state; it makes no real model calls. Run fixture modes sequentially on
port 4201.

The bot records every intent label it adds (repository, issue number and label
name) in `triage_labels`, so a cleanup can remove exactly those and never a label
a person applied. Setting changes, pauses, backfills, retries and cleanups are
written to `audit_log` with the admin's login and whether they came from the web
or the API.

## Clean up

The repository page has a **Clean up** card. It removes only what the bot wrote:

- bot-applied `review:` labels on issues and pull requests (candidates found with one label search per band);
- intent-label candidates recorded after acknowledged writes in `triage_labels`;
- the bot's own score comments: author is `<slug>[bot]` and the body starts with
  the comment marker. The newest 5,000 repository comments are scanned; run
  again for older ones.
- optionally unused `review:` label definitions, checked across open and closed
  issues and PRs immediately before deletion. Combined cleanup removes proven
  bot assignments first; any remaining assignment preserves the definition.
  Intent label definitions belong to the repository and are never deleted.

Before removing an issue or PR label, execution checks its latest exact-name
label event across at most five event pages. Only a `labeled` event attributed
to this bot permits removal; human reapplications, unknown actors, failed reads
and histories exceeding the cap are preserved. Label presence and the local
ledger alone never authorize removal.

A cleanup is a preview first: a queue job counts candidate items (at most 5,000; the
preview says when it was truncated) and writes nothing to GitHub. The admin then
confirms within 10 minutes. In the web admin only the admin who started the
preview can confirm it; the API needs the one-time confirm token. Execution runs
in queue steps of 40 GitHub calls, parks on the App quota like other jobs, can be
cancelled between items, and counts already gone or preserved items as skipped.
The execution count may be lower than the preview. A replay is harmless. One cleanup per repository can be active. If score labels
are still on, the preview warns that new items will be labeled again; pause first.

## CLI and API for agents

Repository admins (and their agents) can do everything above from a terminal
with the ghfind CLI, using a personal API token from
<https://ghfind.com/integrations> in `GHFIND_API_KEY`. When creating the token,
explicitly select **Manage the ghfind Review bot**. Existing tokens remain
scan-only; `token_scope_required` means you must create a new token with this
permission. The permission is required for all bot commands, including reads,
and repository permissions are still checked on every request:

```sh
ghfind bot status owner/repo                    # settings, failed jobs, last cleanup, audit log
ghfind bot pause owner/repo                     # issues and PRs off, queued jobs cancelled
ghfind bot cleanup owner/repo --labels all --comments   # preview only; prints a confirm token
ghfind bot cleanup confirm owner/repo <token> --wait    # execute that preview
ghfind bot resume owner/repo
ghfind bot settings set owner/repo --triage off
ghfind bot backfill owner/repo -n 25
ghfind bot retry owner/repo [job-id]
```

The CLI calls `https://bot.ghfind.com/api/v1/repos/{owner}/{repo}` (`GET` status,
`GET|PATCH /settings`, `POST /pause|/resume|/backfill|/retry|/cleanups`,
`GET /cleanups/{id}`, `POST /cleanups/{id}/confirm|/cancel`). The bot sends the
token to ghfind.com (`GET /api/account/whoami`, through the service binding) to
learn the GitHub account, then checks that account's current permission on the
repository with the installation token on every request: reading needs write
access, every change needs admin. No GitHub user token is stored or needed by the
CLI. Errors are JSON `{"error": code}`. "Not installed", "no such repository" and
"no write access" all answer `not_found`, so a token cannot probe private
repositories. Each GitHub account may make 60 requests a minute and 600 an hour
(`rate_limited` with `Retry-After`). A read reuses a permission check for one
minute and a denial is remembered for one minute, so polling and probing cost no
GitHub quota; every change re-checks live. Retrying a failed job closes it first,
so it is retried once, and the new job keeps the original kind (a backfilled item
still sends no email or comment).

Scoped-token rollout: first apply main-site migration
`migrations/0015_ghfind_api_tokens.sql` before
`migrations/0018_ghfind_api_token_scopes.sql` on the main `ghfind` database,
then deploy the main site (token creation, listing and `/api/account/whoami`),
then deploy the bot that requires the `bot` scope. Its legacy `SCORE=ghfind`
service target must expose the new whoami response before declaring bot CLI
readiness. Production CI waits for that successful matching backend release.
Manual deployments must preserve this order; an old backend rejects bot calls
until scopes are available, and these calls fail closed. The main-site workflows
apply only explicitly approved migrations before Worker deployment: include
these migrations and their SHA-256 values in `ops/feed-application-schema-release.json`
(dev and application production) and `ops/feed-production-schema-release.json`
(full production). The bot's
separate database migrations do not apply this main-site migration.
Existing tokens keep `scan` only. During a rolling deployment, a missing scopes
column is read as `scan` only and bot-enabled creation is refused until the
migration is applied; a whoami response without `bot` is rejected by the bot.

## Runtime

- Separate Worker, Queues and D1; no writes to scoring/Feed databases.
- Webhook HMAC validates the raw body before admission. Only minimal task
  metadata and repository settings are retained; issue text is not stored or
  executed. With intent labels on, the title and description are sent to the
  configured LLM provider and discarded.
- D1 is the durable outbox. Queue sends are recovered by a one-minute cron.
  Delivery IDs deduplicate redelivery. The queue runs 96 consumers, 24 for
  each of the four GitHub tokens. That is the backend worker pool: one Worker
  script, ninety-six invocations at once, each calling the same score API.
  A second job for the same issue waits.
- An atomic ten-minute lease excludes duplicate executions. Execution budget is
  eight minutes from first claim, not from webhook arrival; four minutes are
  reserved for GitHub operations. Each HTTP call is capped at sixty seconds,
  including streamed body reads. Seven retries maximum, using 5/10/20-second
  backoff and GitHub Retry-After/reset guidance. No webhook sleep loops.
  A GitHub App hourly quota stop parks every pending job for that installation
  until the reset time, without writing `review: no-score`. The one-minute cron
  resumes them. A missing score from ghfind still uses `review: no-score`.
  A transient no-score schedules two later scores, at 20 and 60 minutes.
  The 60-minute pass is the last automatic attempt. Each follow-up runs only
  while that issue is still open and still labeled `review: no-score`.
- The score is persisted before the label write. Replays reconcile
  current labels, add the target first, and remove only known obsolete review
  labels. Unrelated labels and owner customization remain unchanged.
- Installation-scoped discovery paginates repositories. Repository tasks mint a
  repository-scoped token and refetch the repository by ID, handling renames and
  access revocation. Suspended/deleted installations cannot mint usable tokens.
- D1 sessions contain encrypted user tokens; Secure/HttpOnly/SameSite cookies,
  one-use OAuth state, origin/CSRF checks, and live repository-admin checks guard
  retries and settings saves. A supplied installation ID is never treated as
  proof of access.
- LLM calls (`src/llm.ts`) use an OpenAI-compatible `/chat/completions` endpoint,
  are capped at sixty seconds within the job budget, and never block labeling:
  a failure leaves the score label in place and posts the plain comment.
- Score reads use the `SCORE` service binding to the existing `ghfind` Worker.

The labeling contract was ported from #288; the CLI implementation is not
imported because that PR was closed in favor of this App and its Node entry point/internal retry
loop do not fit queue execution. Keep the threshold/label fixtures aligned if
the contract changes.

## Develop and verify

```sh
cd platform/github-app
pnpm install --frozen-lockfile
pnpm types
pnpm typecheck
pnpm test
pnpm build
```

Tests run inside workerd with a real local D1, native service-binding transport
for the score fixture, and mocked external GitHub requests. Keep the service
binding unmocked so runtime-specific fetch restrictions remain covered. HTTP
redirects are handled manually and rejected as non-success responses; Workers
does not implement `redirect: "error"`.
Compatibility date is `2026-09-10`, the newest supported by the pinned test
runtime. `wrangler types --strict-vars=false` keeps rollout switches string-typed.
The separate GitHub App checks workflow runs this package on PRs and pushes.
For UI changes also run repository `pnpm typecheck` and `pnpm lint`, and inspect
Light, Dark and Auto in the navbar.

## Register under the maintainer account

The production App is already registered under **AsperforMias**. Do not register
a duplicate when deploying updates. The following procedure is for a separate
self-hosted App. Registration is distinct from repository installation; GitHub
may require account two-factor/sudo verification.
Installing into `hikariming`'s personal repositories must be completed by that
account's owner.

```sh
node scripts/register.mjs https://bot.example.com /absolute/private/credentials.json
```

Open the printed loopback URL, confirm the logged-in account and register the
App. The script binds only `127.0.0.1`, uses a one-time random state, exchanges
the manifest code directly with GitHub, and writes credentials with mode `0600`.
It refuses to overwrite an existing credentials file. Keep the terminal running
until the callback succeeds; stop it afterward. Never commit the output.

In App settings, upload `assets/avatar.png` (200×200, derived from the website
icon). Confirm webhook is `/webhook`, OAuth callback `/callback`, setup `/setup`,
Issues and Pull requests write permissions and the `issues` and `issue_comment`
event subscriptions. `issue_comment` lets the issue author
or a repository admin ask for a fresh score on an open `review: no-score` issue.
Adding it does not add a permission.
Existing installations must accept the added Issues
permission in their GitHub installation settings. GitHub
also delivers installation lifecycle events automatically. Keep optional OAuth
on installation disabled: it is only needed to view the setup dashboard and
repository settings.

## Deploy

The production account is pinned to `8f19bebe359e4ec1a24c68c5f49c1584` (the same
account as ghfind). App ownership in GitHub does not change Cloudflare billing.
Before deploy, verify `wrangler whoami`, `wrangler d1 list`, and
`wrangler queues list`. Never substitute another Cloudflare account to get a
deploy through. The default configuration is local/staging development. Staging
is provisioned as Worker `ghfind-bot-staging`, D1 `ghfind-bot-staging` and queues
`ghfind-bot-staging`/`-dead`; it uses throwaway App credentials and cannot write
to GitHub.

Set non-secret `APP_ID`, `APP_CLIENT_ID`, `APP_SLUG` in the production vars.
Secrets are `APP_PRIVATE_KEY`, `WEBHOOK_SECRET`, `APP_CLIENT_SECRET`, and a random
32-byte `SESSION_SECRET`. Supply a private JSON file on first deploy:

```sh
pnpm exec wrangler d1 migrations apply ghfind-bot --remote --env production
pnpm exec wrangler deploy --env production --secrets-file /absolute/private/worker-secrets.json
```

Apply every pending migration before the code that needs it is deployed. In
particular, `0006_repo_settings.sql` must be applied before deploying the
repository-settings release. If the table is missing, settings reads fall back
to the defaults so webhooks keep working, but saving settings and backfills fail
until the migration is applied. `0007_bot_operations.sql` (intent label records,
audit log, cleanups) must be applied before the cleanup/API release: until it is,
the admin/API controls and intent-label records depend on that schema.

The `ghfind bot` API authenticates through ghfind.com's `/api/account/whoami`.
Deploy the legacy `ghfind` main site with the scoped route before this Worker;
until then the API answers `auth_unavailable`.

`LLM_API_KEY` is an optional secret and is deliberately not in
`secrets.required`. Without it, AI greetings are off; intent classification is
also off when using the `llm` provider. Production Jev uses its separate
OpenRouter secret. The settings page reports these capabilities separately.
For AI greetings or the local/staging LLM classifier:

```sh
pnpm exec wrangler secret put LLM_API_KEY --env production
```

`LLM_BASE_URL` (default `https://api.stepfun.com/v1`) and `LLM_MODEL` (default
`step-3.7-flash`) are optional vars in `wrangler.jsonc`; leave them empty for
the defaults or point them at another OpenAI-compatible provider.

For Jev intent classification, set `TRIAGE_PROVIDER=jev`, install the optional
`OPENROUTER_API_KEY` secret, and retain `JEV_MODEL=typesafe/jev-1.13`.
Production vars already select Jev; this does not enable any repository's
intent-label opt-in. `JEV_BASE_URL` is an operator-only API root, defaulting to
`https://openrouter.ai/api`; the Worker appends `/alpha/decisions`. A trailing
slash is optional. Custom roots must use HTTPS without userinfo, query or
fragment, and must implement the same typed Decisions API and pinned model.
Configure the URL in Worker vars, not repository settings; the API key stays
in the `OPENROUTER_API_KEY` secret. Invalid URLs disable Jev readiness and fail
before sending any request. Redirects are rejected without forwarding the key.
`JEV_THRESHOLD=0.8` is a conservative initial setting, not a calibrated accuracy
claim. Each saved existing label is evaluated against its GitHub description;
at most three qualifying labels are added. Invalid or unavailable decisions
produce no labels and do not fall back to a generative model.

Run the reproducible live evaluation from the repository root:

```sh
pnpm exec tsx platform/github-app/scripts/jev-live.mts
```

The script reads `OPENROUTER_API_KEY` from the private local file documented in
the script, never from command arguments. Use a non-production credential;
outputs contain fixtures and sanitized statuses, not credentials. The generic
question evaluates each description against at least one actual problem,
request, question or explicitly stated change; secondary PR changes can qualify.
It does not substitute label-name guesses for a supplied description.

Use `JEV_EVAL_SUITE=semantic-groups` for two repository-local simulated groups,
including conflicting descriptions for identical label names. To capture public
Dify examples locally, run
`pnpm exec tsx platform/github-app/scripts/jev-dify-snapshot.mts`; it only
performs GitHub GET requests. Then run `jev-live.mts` with
`JEV_EVAL_SUITE=dify-snapshot` and `JEV_EVAL_FIXTURES=<local-json>`. No Dify configuration or
label is written. The strict final eight-case Dify evaluation passed 7/8: a broad
Agent description also matched a workflow-memory PR at the inclusive 0.8
threshold. This small sample does not establish calibrated production accuracy;
Jev remains opt-in, and the default provider remains `llm`.

PRs and pushes run GitHub App checks. Production bot deployment is the final
`deploy-bot` job of **Deploy production (Cloudflare)**, after the successful
legacy `ghfind`/SCORE deployment and smoke checks for the same CI SHA. It checks
that SHA is still current main, serializes production deployments, applies bot
migrations, then deploys the matching Worker. Existing Worker secrets stay in
place. A failed or stale main-site release cannot deploy the bot.

For later rotations use `wrangler secret bulk` with a private file. Never put
secret values in command arguments, GitHub comments, screenshots or logs.
Bootstrap deployments keep `ENABLED=false` and use throwaway local credentials;
they are not an operational GitHub App until replaced by real credentials.

Enable processing only after credentials, avatar and webhook configuration are
ready. Production uses `ALLOWED_ACCOUNTS=*` after real installation/labeling E2E
verification. For a separate restricted deployment, use a comma-separated list
of repository owner logins.

## Observe and recover

The setup page shows up to 100 authorized installation jobs in repository and
shared GitHub-number order, with membership and historical owner filtering before
the limit and live write permission checked before display. Only repository admins can submit Retry. For a
failed discovery job, a maintainer can redeliver the installation webhook from
GitHub App settings; use the SQL/operator procedure below for a fresh budget.
Replaying a completed delivery is intentionally a no-op.

```sh
pnpm exec wrangler d1 execute ghfind-bot --remote --env production \
  --command "SELECT id,kind,state,attempts,result,updated FROM jobs ORDER BY updated DESC LIMIT 30"
```

An operator may reset one **failed** job after fixing the cause (use its actual
ID): `UPDATE jobs SET state='pending', attempts=0, started=0, score=NULL, lease=0,
due=0 WHERE id='<job-id>' AND state='failed'`. Cron will enqueue it again. This is
also the way to recover an exhausted discovery job. Failed tasks stay in D1;
retry/deadline exhaustion and other terminal processing errors also send their
ID to the dead-letter queue. Infrastructure queue failures use the configured
DLQ. No user token or raw payload belongs in a DLQ entry.

Pause with `ENABLED=false` and redeploy. Pending tasks remain durable. Uninstall
or remove a repository in GitHub to revoke access; existing labels stay in place.
Rollback the Worker version with `wrangler rollback --env production`; do not
roll back/drop the D1 schema. Completed/cancelled records are purged after 30 days
by cron; expired dashboard sessions are purged at the same time.

## Real E2E acceptance

Use an empty, disposable repository in the maintainer account. Install only on
that repository; verify five labels exist before opening an issue. Check the
GitHub timeline's actor login/type/avatar, the applied level against the live
score, and the setup status. Redeliver the same event and ensure there is no new
label transition. Remove repository access/uninstall and confirm no further
writes. Unit tests and a deployed health page alone do not establish bot identity.

Validated against the live service on 2026-09-15:

- A new private test repository received all five labels automatically on install.
- An issue opened by `AsperforMias` received a high-band label for a live score of
  **82.7**. The GitHub timeline recorded `ghfind-review[bot]` (type `Bot`) with
  the custom avatar, not the maintainer or GitHub Actions identity.
- GitHub redelivered the same opened event successfully (HTTP 202); the timeline
  still contained exactly one review-label event.
- The OAuth setup dashboard showed initialization and labeling as done. Light,
  Dark and Auto themes were checked with actual job rows.
- After uninstalling the test installation, the previously issued token returned
  HTTP 401 for reads and label writes, and new token creation returned HTTP 404.
  Existing labels remained unchanged. The disposable repository was archived.

The production App is available for installation; `hikariming/ghfind` still needs
its personal account owner's installation. This package does not install the App
in that repository or replace its workflows merely by being merged.

Repeat a label check with:

```sh
node scripts/e2e.mjs verify owner/test-repository app-slug issue-number
```

## Label palette

| Label            | Score interval                      | Color            | Hex       |
| ---------------- | ----------------------------------- | ---------------- | --------- |
| `review: low`      | 0 ≤ score < 40                      | Muted light grey | `#d9dee3` |
| `review: medium`   | 40 ≤ score < 70                     | Light blue       | `#b6dfff` |
| `review: high`     | 70 ≤ score < 90                     | Soft apricot     | `#e2c0a2` |
| `review: top`      | 90 ≤ score ≤ 100                    | Soft wheat       | `#ded0a6` |
| `review: no-score` | No valid score; no numeric interval | Neutral grey     | `#c3c7ce` |

Higher score levels stay warmer, at a lower saturation so light-mode GitHub
does not glare. New labels use this palette. Existing labels with the App's
original `ededed` color and exact default description are upgraded during
initialization (also run before labeling). Owner-customized colors or
descriptions remain unchanged. Issues already labeled `review-level:` keep
that older, longer name.

## Author emails

Scores below 40 suppress author emails for both issues and pull requests, including mail already pending when the rule is deployed. The check runs before public email discovery and before delivery limits are consumed. A score of exactly 40 remains eligible; unavailable scores retain their existing notification behavior.

Authors with a current public GitHub profile email receive score emails by default, without signing in or subscribing first. Missing, invalid, bot and GitHub noreply addresses are skipped. Commit emails are not used because commit metadata does not prove mailbox ownership. The public email is rechecked before delivery. [Email preferences](https://bot.ghfind.com/notifications) also lets authors explicitly authorize a verified primary email, choose English/Chinese, or resume after opting out. Private email access still requires the author's GitHub user authorization.

After an issue is labeled, the author can receive their score, interval, profile
URL, and—when available—their percentile and score rank among accounts indexed by
ghfind. These are **site score statistics**, not a processing order or a prediction
of when maintainers will respond. Missing statistics are omitted. A newly opened
pull request uses the same per-person, cross-repository 72-hour quiet period.
Existing issues and pull requests queued by an admin backfill are labeled without sending mail.

Delivery uses an independent D1 outbox. One person receives at most one score email
every 72 hours, across repositories. Extra messages created during that quiet period
are cancelled; they are not held until the 72 hours end. The next labeled issue or
pull request can send one more email after the quiet period. The global cap is 100
emails per UTC day.
Email failures do not roll back labels. Ambiguous sends are marked `uncertain`
and are not automatically resent, avoiding duplicate mail at the cost of possible missed
notifications. Inspect these records before any manual recovery.

Every email contains an unsubscribe link and one-click unsubscribe headers. Visiting the
link asks for confirmation; submitting it removes the encrypted email subscription and
cancels pending mail. A persistent GitHub user-ID opt-out prevents reenrollment across repositories, even after event records expire. Only explicit author resubscription clears it. A send already in progress may complete. Subscription email addresses
are encrypted using `SESSION_SECRET`; providers' errors and recipient addresses are not
logged. Email event records are retained for 30 days.

### Operator setup

1. Apply all pending Wrangler D1 migrations, including `0002_author_email.sql` and `0003_email_delivery_receipt.sql`, and `0004_default_author_email.sql`.
2. Add **Email addresses: read** under the App's **Account permissions**. Authors must
   authorize that permission themselves; repository owners cannot consent for them.
3. Onboard a sending subdomain, for example `wrangler email sending enable mail.example.com`,
   and verify SPF, DKIM and DMARC records. Set `EMAIL_FROM` to an address on that domain.
4. Configure the `EMAIL` sending binding and set `EMAIL_ENABLED=true` only when the domain,
   user authorization and a controlled-recipient E2E test have passed. Local/staging defaults to false; the hosted production App enables it after controlled-recipient validation.
5. Scheduled processing drains the outbox. Monitor `author_emails.state` for `uncertain`
   results (`provider_id` records accepted sends; `error_code` contains only sanitized codes) and `email_daily_budget` for capacity. Pausing the bot also pauses email sending.
