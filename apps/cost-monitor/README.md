# Cloudflare cost monitor

An independent Worker polls closed five-minute analytics windows with ten minutes
of ingestion allowance. A bounded SQLite Durable Object owns observations,
incidents and per-recipient delivery receipts; business requests do not pass
through it. Aggregation delay does not guarantee final or complete analytics.

## Read an alert

The subject names the affected feature or account cost signal. Each compact
section starts with the observed result and possible impact, followed by one
suggested action. Trigger and time-window evidence stays below it. HTML expands at
most three resources and three metrics per resource, then lists up to five other
resources and a remaining count. Plain text preserves every selected metric's
evidence once. Both use UTC+8 and support rolling upgrades from old text notices.
HTML supports light/dark email clients, narrow screens and keyboard focus.

- **Functional/runtime incident:** an observed operation failed or crossed a
  runtime threshold. Check the feature, recent deployment and upstream logs.
- **Account consumption/reported-cost incident:** complete account consumption
  windows or reported daily cost crossed a threshold. An incomplete collection
  can still prove extreme spending when its observed lower bound alone exceeds
  the single-window threshold. Analytics estimates are not an invoice.

Customer mail excludes collection gaps and per-resource SQL/CPU/operation
efficiency diagnostics. These remain in authenticated health, bounded metric
state and structured logs. Missing telemetry does not prove overspending or a
user outage, and cannot create a customer notification or a false recovery.
Automatic public probes are described as checks, not observed customer failures.
Runtime error ratios use counts and percentages, for example 3 of 12 calls failed.

Only fixed sanitized failure classifications leave collectors. Raw upstream
errors, SQL, parameters, user IDs, request bodies and keys are not retained or
included in mail. Recipient addresses remain private configuration.

## Notification timing

| Priority | Signal | Delivery / reminder |
| --- | --- | --- |
| P0 · 计费 | Account burn or reported daily cost, warning or critical | Immediate; 2h burn / 24h bill |
| P1 · feature / availability / monitor | Critical service errors; two consecutive failed probes; watchdog heartbeat interruption | Immediate; 6h |
| P2 · feature / Worker | Slow responses, warning errors, Worker errors, one failed probe | Hourly; 24h reminder per key |
| P3 · 监控 / 部署 | Delivery trouble; latest main deployment failure | Operations channel |
| Information | Recovered incidents | Daily footer only |

Subjects include priority, category, observed value and threshold. Billing leads
mixed incidents. Recovery never counts toward the active-item count. Each message
starts with problem, UTC+8 start time and duration, and impact. Legacy notices are
parsed into compact fields rather than copied verbatim.

At 09:00 UTC+8 every day, a daily report is sent even with no incidents. It includes
active issues, recoveries from the past 24 hours, observed consumption and coverage,
the latest reported bill, and heartbeat. Persisted per-recipient receipts retry a
missed daily send without duplicating successful recipients or the hourly digest.
Missing observations remain unknown; they never establish recovery.

A collection gap is one persisted diagnostic incident even if its reason changes;
two distinct complete windows close it. Upgrades discard old collection/efficiency
mail and delivery receipts before evaluation, so stale diagnostics cannot occupy
customer queue capacity or be retried to remaining recipients.

Each recipient receives at most one aggregate message per evaluation. Accepted
recipients are not resent on ordinary retries; failures remain queued. Sending is
limited to 8 attempts/hour and 120/day. Provider acceptance is not final delivery.
Check Email Service delivery logs. A crash after provider acceptance but before
recording its receipt can still duplicate a message.

## Sliding windows and cost meaning

Account consumption retains twelve complete five-minute buckets at most:

- Critical: both the latest **5-minute** and **15-minute** hourly rates exceed
  the critical threshold.
- Warning: both the **15-minute** and **1-hour** rates exceed the warning threshold.
- Extreme spend: a single five-minute bucket already consumes the critical hourly
  amount, so it alerts immediately without waiting for longer history.
- Even with incomplete collection, an observed five-minute consumption lower
  bound at or above that extreme threshold triggers a clearly marked notice.
  It does not enter complete-window averages, train a low baseline or establish
  recovery. Unknown costs remain unknown. A later correction of that same bucket
  is conservatively skipped for account history and notification; the next
  complete bucket resumes normal evaluation without counting consumption twice.
- Missing buckets stay unknown, never zero. Replays do not add consumption or
  train baselines twice. High current use with incomplete history cannot falsely
  close a consumption incident.

Default policies are $0.50/hour warning, $2/hour critical and $10/reported day
warning ($30/reported day critical). These are operator choices, not universal
SaaS limits; review them against the account's normal traffic and budget.

Fast estimates use published overage unit prices **before included allowances**,
not the amount actually charged. They cover D1 rows, Workers requests/CPU, R2
operations/storage, KV operations, DO SQL rows and Queue operations. External LLM
fees, DO compute, KV/D1 storage and products without adapters are outside this
fast total. R2 storage uses the latest hourly snapshot (max) per bucket and storage class within the last
three hours, queried with its own 1000-row bound (a truncated result is still an error), and
a 30-day conversion. A known storage gauge with no snapshot in that whole
lookback makes account cost coverage incomplete: old charges are neither copied forward as current data nor assumed
zero. Deleted buckets can remain conservatively unknown until a new snapshot or
the remembered gauge's original seven-day TTL expires. Observed Service failures,
slow calls and application Worker errors continue to notify while account cost
coverage is incomplete. Monitor Worker errors stay in operational diagnostics.

Closed reported daily billable usage is reconciled every six hours across all
products. Failed requests retry at most hourly and remain a collection gap until
success; a skipped billing tick cannot erase that failure. Reported billing can
be delayed or adjusted and stays separate from fast estimates.

Ordinary per-metric warnings need two consecutive valid windows. Account cost
warnings already require confirmed multiwindow history, so do not wait for two
additional evaluations. Healthy EWMA baselines
need twelve observations and minimum activity; suspicious data does not train
them. Relative 3x/10x anomalies also require $0.05/$0.50 per-hour estimated use,
including SQL fingerprints. SQL diagnostics require two windows even for absolute
critical thresholds. Worker errors need at least three errors and twenty calls;
separate key-feature signals retain immediate failure detection at low traffic.
DO/KV/R2/Queues ratios use account-wide Worker calls as a reference denominator,
not the actual number of operations on the individual resource.

## Collection bounds and failure isolation

Each collection makes eight bounded GraphQL calls, plus billing when due. API
responses are capped at 2 MiB. Unknown billable operations, unavailable core
sources and truncated core results are explicit gaps, never zero usage.

SQL fingerprints are optional diagnostics, not extra billable consumption:

- At most 48 diagnostic points, leaving 16 point slots and 8 KiB for later
  business/probe/billing additions within the 192-point/48-KiB frame limit.
- At most 96 diagnostic states within the overall limit of 256 metrics.
  Diagnostic states do not enter the 64-notice customer queue. Old
  fingerprint-heavy states are compacted; core observations take priority.
- Limited/failed SQL breakdowns appear in `Frame.diagnostics`, not as failed core
  collection. Missing fingerprints in incomplete breakdowns cannot prove recovery.

Evaluation uses a candidate state. Late frame/cardinality/storage failures do not
partially advance baselines, successful-collection times or billing freshness.
Window and candidate-state writes share a SQLite transaction. Accepted frames
leave 16 KiB for health and delivery state; sending preflights its recipient
receipt with 8 KiB remaining, so capacity exhaustion pauses mail before sending
and retains the outbox instead of losing an accepted receipt.
Expected upstream gaps are persisted normally, without throwing an uncaught
Worker exception that this monitor would ingest as another runtime incident.

One aggregate JSON row is retained per window: 24-hour TTL, 288 rows, at most
48 KiB per row. State has a seven-day TTL and 192-KiB cap. The outbox expires after
seven days; the last twelve delivery receipts expire after 24 hours. Indexed
cleanup runs per collection and through a daily alarm. A persisted lease prevents
concurrent polls.

## Key-feature checks

The API Tail Worker saves five-minute counts for README large/mini cards, badges,
homepage analysis and roast generation. It recognizes failed `roast.summary`
results even after HTTP 200. User-supplied model configuration errors, ordinary
4xx responses and client disconnects are excluded. Only fixed feature names,
times and counts are retained; Tail can retry, so counts are observations, not
financial accounting. No traffic does not establish recovery.

Each cycle also GET-probes the homepage and torvalds large/mini cards for HTTP
status and Content-Type. It does not start GitHub analysis or paid LLM generation.
Probe failures need two windows. Passing probes do not prove correctness for every
user's content. Tail arrives after streams finish; ingestion allowance also adds
to detection latency.

## Health and external watchdog

Authenticated `GET /health` version 2 separates `heartbeatHealthy`,
`collectionHealthy` and `deliveryHealthy`, with last attempted/completed ticks,
billing attempt/success and sanitized incident metadata. `internalDiagnostics`
counts active internal anomalies and includes at most 16 key/severity/lastSeen
records. Recipient receipts with addresses are omitted. Legacy `healthy` remains
the combined status.
`POST /run` performs a real collection and can send due mail; it is not read-only.

The GitHub Actions watchdog checks hourly. Missing/stale heartbeat or explicit
delivery failure fails the workflow. Optional `MONITOR_OPS_RECIPIENTS` routes
these faults to a separate operations mailbox; it never falls back to customer
`ALERT_RECIPIENTS`. Without ops recipients there is no email, and sending
credentials are not required. Upstream collection gaps remain in Worker health.
For legacy responses it uses `lastAttempt`, falling back to `lastSuccess` only
when the former field is absent.

A serialized job restores/saves bounded state through Actions cache, including
after partial send failure. State contains incident times and keyed HMACs of
monitor/recipient identities, not raw addresses, URLs or credentials. File writes
are atomic with mode 0600. Each recipient is retried independently; recovery is
silent. Cache eviction or administrator-key rotation can trigger a fresh notice.
Actions scheduling/cache retention are best-effort. The sending path still uses
Cloudflare Email Service, so a platform-wide outage requires another provider for
independent delivery.

## Private configuration and rollout

Use Wrangler secret input or a private bulk file for `CF_MONITOR_API_TOKEN`,
`MONITOR_ADMIN_TOKEN`, `PROBE_GITHUB_LOGIN` and `ALERT_RECIPIENTS`. The recipient JSON list supports empty
placeholders, for example `["owner@example.org", ""]`, with up to twenty addresses.
Never commit real recipients, credentials or private incident evidence.

The dedicated token is account-restricted: Account Analytics Read, Billing Read
and Email Sending Edit for the external watchdog. Native Worker mail uses the
`EMAIL` binding and an already-onboarded sender domain.

GitHub uses `CF_MONITOR_API_TOKEN`, `COST_MONITOR_ADMIN_TOKEN` and
`COST_MONITOR_RECIPIENTS` and `COST_MONITOR_PROBE_GITHUB_LOGIN` secrets plus the `COST_MONITOR_URL` variable. Optional
`COST_MONITOR_OPS_RECIPIENTS` is an independent JSON address list for the watchdog;
absent, blank or `[]` disables only its email path, not health checks. The workflow
provides `WATCHDOG_STATE_FILE`. Production requires successful main CI and source
SHA checks. Deploy the Tail consumer before its API producer. Production has no
synthetic routes or captured-mail mode.

## Validation

Run `pnpm --filter @ghfind/cost-monitor typecheck`,
`pnpm exec vitest run apps/cost-monitor/src/__tests__`,
`node --test scripts/cost-monitor-watchdog.test.mjs` and
`node scripts/cost-monitor-e2e.mjs`.

E2E uses isolated real workerd/SQLite with captured mail. It checks hourly batching,
urgent bypass, partial-recipient retries, silent long-running collection gaps,
legacy-outbox cleanup, recovery, storage limits, TTL cleanup and scheduled gaps. No live recipient is
used locally. A remote `COST_MONITOR_URL` changes the suite into an explicit
rehearsal that can send mail: only use an isolated E2E Worker with approved private
recipients, never production. Evidence belongs in private git-ignored files.

Design references: [Alertmanager grouping and inhibition](https://prometheus.io/docs/alerting/latest/alertmanager/),
[Google SRE symptom-based human alerts](https://sre.google/sre-book/monitoring-distributed-systems/),
[Google SRE multiwindow alerting](https://sre.google/workbook/alerting-on-slos/),
[Cloudflare Workers metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/),
[D1 metric definitions](https://developers.cloudflare.com/d1/observability/metrics-analytics/).
The windowing technique informs this policy; USD thresholds do not implement
Google's SLO error-budget formula.

The probe account is private environment configuration. If absent or invalid, the
homepage probe continues, account-card probes are skipped, and authenticated health
reports the skipped configuration. Never put a real account login in fixtures.

Superseded deployments exit successfully before mutations. The remote CI verifier
returns a `superseded` result; only the production authorization caller opts into
successful skip handling. Other callers fail closed. The watchdog records unhealthy
state with an Actions notice, avoiding an additional hourly workflow-failure email.

For an explicitly authorized live rehearsal, dispatch the cost-monitor workflow
with `exercise=true`. It verifies production health, deploys the isolated E2E Worker,
and sends simulated all-clear and P0-warning messages using the private recipients.
No production state is reset.

### Daily traffic report

The same five-minute cron sends a separate traffic report at 04:00 UTC (12:00
UTC+8). `nextTrafficReport` and accepted recipients survive retries; missed days
collapse into one report. Traffic sends bypass alert classification and limits,
but count towards mail attempt statistics. `TRAFFIC_REPORT_RECIPIENTS` optionally
overrides `ALERT_RECIPIENTS`. `/health` exposes the next send and traffic error.

Set repository variable `COST_MONITOR_ZONE_ID`; deployment copies it to private
Worker configuration `CF_ZONE_ID`. Analytics needs Zone Analytics:Read for this
zone and Account Analytics:Read for RUM. `TRAFFIC_HOST` defaults to `ghfind.com`.
RUM visits are browser visits, not distinct people. When no current RUM window is complete and nonempty, visitor windows fall back
to zone unique IPs. A missing previous period only suppresses that comparison. Missing data
is shown as unavailable, never zero. Zone referrer is unavailable on the current
plan; referrer rankings use RUM page loads.

All sources use the latest complete UTC-day cutoff (08:00 UTC+8), including the
previous comparison periods. Retention and query duration are discovered per dataset: only complete daily
buckets within retention qualify for 24h, 3d and 7d comparisons. Missing or
partially retained days suppress comparisons with a reason, rather than inflate
percentages. Each email spells out current/previous ranges and the prominent
24h window; a manual send before 08:00 correctly ends on the previous local day. Unique IPs are queried as whole-window aggregates,
not summed from daily values. The production D1 binding only executes EXPLAIN
and bounded counts using the existing covering state/time index. Scan counts
are completed/partial runs by update time, not new scores or first-time accounts.
Other business counts lack suitable time indexes and are explicitly unavailable.

Authenticated `POST /traffic-report/preview` renders live HTML without sending.
Production verification encrypts this HTML with AES-256-GCM and an RSA-OAEP
wrapped key using repository variable `TRAFFIC_PREVIEW_PUBLIC_KEY`. Only
ciphertext is uploaded as the seven-day-retention `traffic-report-preview`
Actions artifact; the owner keeps the private key locally. The local workerd suite tests the
noon boundary, receipt persistence, partial failures and missed-day catchup using
captured synthetic mail. Real provider acceptance followed by a crash before
receipt persistence remains an at-least-once delivery edge case.

The separate all-request chart uses zone Adaptive edge requests, then zone daily
totals, then explicitly labeled Workers invocations as a fallback. It retains
the RUM chart and never adds Workers calls to edge totals (service bindings can
count one incoming request multiple times). API/MCP/webhook paths take priority;
Mozilla UA requests excluding API/static paths approximate browser pages. The
remaining segment includes non-browser, static and unclassified requests. UA is
spoofable; this is not a human/bot classification. Accept filtering is unavailable
on the current plan. Missing or inconsistent sampled segments render a total-only
gray bar, never fabricated zeros. Workers include router/web/api/legacy services.

Two capability queries and five bounded data queries collect all windows, daily
buckets and rankings. Budget/rate-limit failures retry once, then display the
reason; permission errors do not retry. No extra cron or persistent counters are
introduced. Email includes plain text, table-based charts, Auto-Submitted and
Content-Language headers. SPF/DKIM/DMARC and provider acceptance cannot guarantee
Outlook inbox placement. Do not invent a Reply-To mailbox or unsubscribe endpoint
for this owner-only operational report.

Traffic email always requests the light palette, including explicit nested cell
colors and Outlook data-ogsc/data-ogsb overrides. Client-side forced inversion
can still vary; verify the actual received message as well as browser previews.
Subjects use the UTC+8 data-window dates and available visitor/edge-request/API
totals. Changes stay in the body. Missing edge/API totals are omitted; Workers
fallback invocations never masquerade as edge requests in a subject. Manually
sent real reports use `[手动]`; the isolated synthetic E2E environment keeps its
`[模拟]` safety marker. Deployment previews reject older theme/title templates.
