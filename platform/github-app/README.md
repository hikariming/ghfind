# ghfind Review GitHub App

**English** · [中文](./README.zh.md) · [Project README](../../README.md)

**Your review time is scarce. Make every first look more informed.**

A busy queue should not mean opening every author's profile by hand. ghfind Review
adds a public-profile score label and a concise profile comment to each new issue
and PR, including drafts. You get source context where you already work, so you
can prioritize attention and investigate unfamiliar sources before a deep review.

[**Install ghfind Review on your first repository**](https://github.com/apps/ghfind-review/installations/new)

## Turn score bands into a review queue

Use the five `review:` labels to define your team's triage policy. Lower bands
stay visually quiet; soft apricot and wheat mark the higher bands without a harsh
block of color. Each bot comment includes the profile URL, exact score and
interval, so maintainers can follow the evidence without repeating the same
account lookup.

Paste these filters into your repository's Issues or Pull requests search:

| Review queue                           | GitHub search                                |
| -------------------------------------- | -------------------------------------------- |
| Open PRs with a high profile score     | `is:open is:pr label:"review: high"`   |
| Open PRs in the highest band           | `is:open is:pr label:"review: top"`    |
| Low-band issues needing a source check | `is:open is:issue label:"review: low"` |
| Missing scores needing manual context  | `is:open label:"review: no-score"`     |

Start with a queue that fits your available review time. Use low and no-score
bands as a prompt to inspect the source and submission before spending more time;
use higher bands to find authors with stronger public-profile signals. This gives
you a practical first screening step for potentially low-quality incoming work.

The thresholds are currently fixed at **40, 70 and 90**; per-repository threshold
configuration is not available. You choose how to handle each band using GitHub
filters and your team's process. The App labels and comments; it does not block,
close or reject issues/PRs. The score measures the author's public profile, not
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
   `top`, and `no-score` labels, then queues a score for every issue and pull
   request that is already open. Owner-customized colors/descriptions are preserved;
   original bot-owned grey defaults are upgraded to the palette below.
   Archived labels and case conflicts are reported for the owner to fix.
   Issues already labeled `review-level:` keep that older, longer name.
3. The installation setup page offers GitHub sign-in to view accessible
   repository jobs. Retrying a failed repository job requires repository admin
   permission. Sign-in is optional for automatic labeling.
4. Open a new issue or PR (drafts and empty descriptions are supported). Processing
   is asynchronous; wait for the queue, then refresh. Confirm the label and comment
   are authored by `ghfind-review[bot]`.
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
| No labels or comment               | Confirm the App is installed on this repository and required permissions were accepted. Open issues and pull requests are queued at install; a large backlog is labeled one page at a time. Open the installation's setup page and sign in to inspect job status. |
| Initialization fails               | Check for archived labels or conflicting capitalization; fix them in the repository's Labels page, then use **Retry (admin)** on the setup page.                                                          |
| `review: no-score`                     | The score is missing, invalid or could not be retrieved within the retry budget. It is not zero. A missing GitHub account stays no-score. A timeout or cloud error is retried 20 and 60 minutes later; a recovered score replaces the label and updates the bot comment. After 60 minutes, only the author or a repository admin can comment `@ghfind-review` on that issue or PR to rescore it. |
| No additional comment after replay | Expected: the App reconciles its existing comment rather than adding another.                                                                                                                             |
| Want to stop processing            | Remove the repository from the App installation, suspend it or uninstall it. Existing labels and comments remain.                                                                                         |

The setup page is reached from the App installation flow/settings; it requires GitHub
sign-in for status visibility. Only repository admins may retry failed jobs.

The score thresholds match PR #288 at `f72a4b3`: 40, 70 and 90. A score outside
0–100, a missing score or exhausted score retries produces `review: no-score`, never
an inferred zero. This is an author-profile signal, not a code-quality review or
permission to merge. Both `issues.opened` and `pull_request.opened` are processed.
The author or a repository admin can comment `@ghfind-review` on an open
no-score issue or PR to request one fresh score. Installing the App, or adding
a repository, also queues every issue and pull request that is already open.
Closed items are left untouched. Editing or reopening an existing item does
not score it again.

## Runtime

- Separate Worker, Queues and D1; no writes to scoring/Feed databases.
- Webhook HMAC validates the raw body before admission. Only minimal task
  metadata is retained; PR text/code is not stored or executed.
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
  resumes them. A missing score from ghfind still uses `review: no-score` and
  says the score service failed, not that the App quota was exhausted.
  A transient no-score schedules two later scores, at 20 and 60 minutes.
  The 60-minute pass is the last automatic attempt. Each follow-up runs only
  while that issue or PR is still open and still labeled `review: no-score`.
- The score is persisted before the first PR label write. Replays reconcile
  current labels, add the target first, and remove only known obsolete review
  labels. Unrelated labels and owner customization remain unchanged.
- Installation-scoped discovery paginates repositories. Repository tasks mint a
  repository-scoped token and refetch the repository by ID, handling renames and
  access revocation. Suspended/deleted installations cannot mint usable tokens.
- D1 sessions contain encrypted user tokens; Secure/HttpOnly/SameSite cookies,
  one-use OAuth state, origin/CSRF checks, and live repository-admin checks guard
  retries. A supplied installation ID is never treated as proof of access.
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
Issues and Pull requests write permissions and the `issues`, `pull_request`
and `issue_comment` event subscriptions. `issue_comment` is how a repository
admin asks for a no-score rescore; adding it does not add a permission.
Existing installations must accept the added Issues
permission in their GitHub installation settings. GitHub
also delivers installation lifecycle events automatically. Keep optional OAuth
on installation disabled: it is only needed to view the setup dashboard.

## Deploy

The production account is pinned to `8f19bebe359e4ec1a24c68c5f49c1584` (the same
account as ghfind). App ownership in GitHub does not change Cloudflare billing.
Before deploy, verify `wrangler whoami`, `wrangler d1 list`, and
`wrangler queues list`. Never substitute another Cloudflare account to get a
deploy through. The default configuration is for local/staging development;
staging's placeholder D1 ID must be provisioned before a remote staging deploy.

Set non-secret `APP_ID`, `APP_CLIENT_ID`, `APP_SLUG` in the production vars.
Secrets are `APP_PRIVATE_KEY`, `WEBHOOK_SECRET`, `APP_CLIENT_SECRET`, and a random
32-byte `SESSION_SECRET`. Supply a private JSON file on first deploy:

```sh
pnpm exec wrangler d1 migrations apply ghfind-bot --remote --env production
pnpm exec wrangler deploy --env production --secrets-file /absolute/private/worker-secrets.json
```

Pushing `platform/github-app` to `main` runs GitHub App checks, then CI deploys
`ghfind-bot` with `wrangler deploy --env production`. Existing Worker secrets
stay in place. The score service deploys with the main site workflow after CI
succeeds.

For later rotations use `wrangler secret bulk` with a private file. Never put
secret values in command arguments, GitHub comments, screenshots or logs.
Bootstrap deployments keep `ENABLED=false` and use throwaway local credentials;
they are not an operational GitHub App until replaced by real credentials.

Enable processing only after credentials, avatar and webhook configuration are
ready. Production uses `ALLOWED_ACCOUNTS=*` after real installation/labeling E2E
verification. For a separate restricted deployment, use a comma-separated list
of repository owner logins.

## Observe and recover

The setup page shows the latest 100 installation jobs intersected with the
user's accessible repositories. Only repository admins can submit Retry. For a
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
that repository; verify five labels exist before opening a draft PR. Check the
GitHub timeline's actor login/type/avatar, the applied level against the live
score, and the setup status. Redeliver the same event and ensure there is no new
label transition. Remove repository access/uninstall and confirm no further
writes. Unit tests and a deployed health page alone do not establish bot identity.

Validated against the live service on 2026-09-15:

- A new private test repository received all five labels automatically on install.
- A draft PR by `AsperforMias` received `review-level: high` for a live score of
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

## Author-score comment

After label reconciliation succeeds, the App creates or updates its own comment:

| Profile                                              | Score      | Level                | Score interval  |
| ---------------------------------------------------- | ---------- | -------------------- | --------------- |
| [AsperforMias](https://ghfind.com/en/u/AsperforMias) | 82.7 / 100 | `review: high` | 70 ≤ score < 90 |

The template is `scoreComment` in `src/review.ts`. It uses the same persisted score
as the label. A missing score shows “No score” with no numeric interval, never
zero, and tells the author or a repository admin they can comment `@ghfind-review` to score
again. That instruction is written in code so the comment does not mention any
person. The footer explains that this is an author-profile signal.

Before posting, all comment pages are searched for the marker and this App's bot
identity. Matching comments are updated only when the body differs; user comments
with a copied marker are not modified. A failed label write cannot post a success
comment. Comment failures retain the durable job for retry, which reconciles the
label and checks existing comments before creating another. GitHub does not expose
an idempotency key for comment creation, so reconciliation handles ambiguous
responses rather than blindly reposting.

The existing `jobs.pr` column stores either the issue or PR number: GitHub shares
that number namespace and exposes both through the Issues API. No schema migration
is needed for this extension.

Issue/comment extension verified on the live service on 2026-09-15 in
`AsperforMias/ghfind-bot-demo-20260915`: empty-body issue #3 and draft PR #4 each
received one high label and one comment from `ghfind-review[bot]`, with the live
score 82.7, a working profile URL and interval `70 ≤ score < 90`. Both real GitHub
opened deliveries were redelivered (HTTP 202); each still had one label event and
one score comment. Test installation 161860552 accepted Issues write permission.

Repeat verification using:

```sh
node scripts/e2e.mjs verify owner/test-repository app-slug issue-or-pr-number
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

Authors with a current public GitHub profile email receive score emails by default, without signing in or subscribing first. Missing, invalid, bot and GitHub noreply addresses are skipped. Commit emails are not used because commit metadata does not prove mailbox ownership. The public email is rechecked before delivery. [Email preferences](https://bot.ghfind.com/notifications) also lets authors explicitly authorize a verified primary email, choose English/Chinese, or resume after opting out. Private email access still requires the author's GitHub user authorization.

After a new issue/PR is labeled and commented, the author can receive their score,
interval, profile URL, and—when available—their percentile and score rank among accounts
indexed by ghfind. These are **site score statistics**, not the repository's PR review
order or a prediction of when maintainers will respond. Missing statistics are omitted.

Delivery uses an independent D1 outbox, deduplicated per repository/issue number/author.
There is at most one attempt per author per 24 hours and 100 attempts per UTC day globally.
Email failures do not roll back labels or comments. Ambiguous sends are marked `uncertain`
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
   user authorization and a controlled-recipient E2E test have passed. Local, staging, and the hosted production App keep `EMAIL_ENABLED` false until sending is explicitly turned back on.
5. Scheduled processing drains the outbox. Monitor `author_emails.state` for `uncertain`
   results (`provider_id` records accepted sends; `error_code` contains only sanitized codes) and `email_daily_budget` for capacity. Pausing the bot also pauses email sending.
