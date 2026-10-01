# Cloudflare cost monitor

An independent scheduled Worker polls closed five-minute analytics windows with
10 minutes of ingestion allowance. D1 database and normalized SQL efficiency,
Workers CPU, R2 operations/storage, KV operations, DO SQL rows and Queue operations
are collected account-wide. R2/KV/DO/Queue operations are also normalized by
Worker invocation volume to distinguish normal traffic growth from amplification. Every six hours, reported daily billable usage is
reconciled across all products, including products without fast adapters.

Cost velocity extrapolates the latest five-minute window to one hour, including
R2 storage. It uses published overage rates **before included allowance**, rather
than an invoice prediction. R2 storage uses the peak of the last hour and a
30-day conversion. DO compute, KV/D1 storage and Containers are currently covered
by delayed billing reconciliation, not the fast burn-rate total. Billing data and
analytics can arrive late; a closed window is not a guarantee of final completeness.

Warnings require two consecutive windows. Critical absolute efficiency or spend
breaches alert immediately on the next available window. Relative thresholds use
a healthy EWMA baseline after 12 observations, with a minimum sample/volume gate;
suspicious data cannot train the baseline. Default spend thresholds are $0.50/hour
warning, $2/hour critical and $10/reported day warning. All thresholds live in the
Worker configuration/policy and should be reviewed against normal workloads.

Notifications are batched per recipient, repeat every 30 minutes while abnormal,
and recover after two valid normal windows. Failed recipients remain queued;
successful recipients are not resent on ordinary retries. Sending is limited to
8 attempts/hour and 120/day; pending messages remain queued on exhaustion. Native
email acceptance is not proof of delivery. Check Email Service delivery logs;
a crash between provider acceptance and persisting its receipt can cause a duplicate.

## Storage bounds

One SQLite Durable Object coordinates this account's low-frequency monitor only;
no business/user request passes through it. A persisted lease prevents concurrent
polls. Each time window is one aggregated JSON row. Raw SQL, parameters, user IDs,
request bodies and raw billing line items are not retained.

- Windows: 24-hour logical TTL, at most 288 rows, at most 48 KiB per row.
- State/baselines: 7-day TTL, at most 256 metrics and 96 KiB total; inactive baselines can be evicted earlier.
- Outbox: at most 16 aggregate notices, 7-day TTL; delivery receipts: last 12,
  at most 24 hours. Recipient addresses are private configuration.
- Cleanup uses indexed expiry and the window primary key at every collection;
  an alarm also reclaims expired rows when the cron stops (daily cleanup cadence).
- Collection has a fixed eight bounded GraphQL calls per run, plus one billing
  call per six hours. Responses are capped at 2 MiB. Truncation, unknown billing
  operation types and unavailable sources are explicit failures, never zero usage.

## Private configuration

Use `wrangler secret bulk` with `CF_MONITOR_API_TOKEN`, `MONITOR_ADMIN_TOKEN` and
`ALERT_RECIPIENTS`. The latter is a JSON list: `["owner@example.org", ""]`;
empty placeholders are ignored and additional recipients can be appended (max 20).
Never commit live addresses, credentials or incident evidence.

The dedicated API token is restricted to the account: Account Analytics Read,
Billing Read, and Email Sending Edit for the external watchdog's send API. Native
Worker sends use the EMAIL binding and an already-onboarded sender domain.

GitHub private configuration mirrors these as `CF_MONITOR_API_TOKEN`,
`COST_MONITOR_ADMIN_TOKEN`, `COST_MONITOR_RECIPIENTS` secrets, and `COST_MONITOR_URL`
variable. Production deploys only after successful main CI with exact-SHA checks.
A GitHub scheduled watchdog checks every 30 minutes independently of the Worker;
GitHub scheduling can be delayed, and its native-email path still depends on
Cloudflare Email Service. A platform-wide outage needs an additional external
mail provider to guarantee email delivery.

`/health` (GET) and `/run` (POST) require the admin bearer secret. The production
configuration has no test routes. A separate e2e environment enables fixed
synthetic scenarios; no arbitrary SQL or real resource writes are injected.

## Validation

`pnpm --filter @ghfind/cost-monitor typecheck`, `pnpm test`, and
`node --test scripts/cost-monitor-watchdog.test.mjs` verify policy and collectors.
`node scripts/cost-monitor-e2e.mjs` starts isolated real workerd/SQLite and verifies
first alert, partial-recipient retry, duplicate suppression, reminders, recovery,
storage limits, TTL purge and the scheduled failure path. CI runs this suite.

For remote acceptance, set `COST_MONITOR_URL` to the isolated e2e Worker and
`MONITOR_ADMIN_TOKEN` privately. The same suite first collects real Cloudflare
analytics and sends clearly labelled rehearsal messages to the configured list.
Optionally set `COST_MONITOR_EVIDENCE` to a **private, git-ignored** output file.
Confirm those message IDs are delivered in Email Service logs, then clean up the
e2e Worker. Never run synthetic scenarios against the production Worker.
