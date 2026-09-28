# Feed Gateway production admission v1

This switch chooses whether an authenticated OAuth user may enter the independent Go Feed runtime. It does not change the Feed fact store, schema, writer epoch or deletion generation. It does not grant OAuth, operator or governance privileges. No client header, cookie, URL parameter or login name participates in admission.

`FEED_BACKEND` preserves the existing pre-rollout defaults: absent or `legacy` returns control to the existing Next Feed routes; `go` with no rollout keys forwards every authenticated user. Unknown values return `503 feed_unavailable`. Production candidate validation uses the complete explicit configuration below. Partial, malformed or unknown rollout configuration also returns 503 before reading the body or contacting any Feed store.

| Variable | Contract |
| --- | --- |
| `FEED_BACKEND` | `go` throughout writer-v2 rollout and subsequent operation. |
| `FEED_ROLLOUT_MODE` | `internal`, `percentage`, `all`, or `paused`. |
| `FEED_ROLLOUT_GITHUB_IDS` | Required CSV of 1–20 distinct positive safe-integer GitHub IDs, at most 1024 characters. The production operator's approved ID `109743670` belongs in deployment configuration; the application does not hard-code an account. |
| `FEED_ROLLOUT_SEED` | Required fixed 16–128 character string containing ASCII letters, numbers, `.`, `_`, `:`, or `-`. Keep unchanged throughout a rollout. This is a cohort identifier, not an authentication secret. |
| `FEED_ROLLOUT_BASIS_POINTS` | `0` for `internal` or `paused`; `1`–`9999` for `percentage`; `10000` for `all`. Integers only, without leading zeros. |

The supported percentage sequence is `internal/0`, `percentage/100` (1%), `percentage/1000` (10%), then `all/10000`, preserving the seed and internal accounts. The current production decision is a short, bounded `internal/0` candidate check followed by `all/10000` after the required gates; it avoids leaving other users unavailable through a prolonged percentage rollout. A user's bucket is the first four bytes of SHA-256 of `ghfind-feed-rollout-v1\n<seed>\n<decimal GitHub ID>`, interpreted as unsigned big-endian and reduced modulo 10000. An internal account is always admitted except in `paused`; other accounts require a bucket below the configured percentage. Stable identity and seed make increasing percentages nested, independent of request path and server instance.

## Writer safety and rollback

Users outside the admitted group receive `503 feed_unavailable`, `no-store`, and `Retry-After: 30`. They never enter the legacy implementation: legacy GET requests may also persist profiles or requests, and the legacy writer has not passed the writer-v2 deletion and governance contract. Once selected, Go errors, timeouts or lost acknowledgements never cause an automatic second attempt through another backend.

`paused/0` makes Feed temporarily unavailable to everyone without touching other API domains. Reducing admission likewise only makes excluded users unavailable; it never moves their writes to legacy. Setting `FEED_BACKEND=legacy` while any rollout key remains is rejected. This is an additional configuration guard, not a durable enrollment database or a replacement for the database writer fence.

After Go first accepts writes, rollback must use a compatible Go image against the same facts or pause Feed while recovering. Deployment tooling must preserve the explicit rollout configuration, must not delete its keys to restore the pre-rollout legacy default, and must not claim that a stateless environment switch establishes a safe database rollback. Schema compatibility, exact-SHA validation and promotion remain independent release gates.

## Transport, authentication and verification

The existing `FEED_RUNTIME` Cloudflare service binding changes transport only; production deployment maps it to `ghfind-feed-runtime-production`. The Gateway still signs the exact authenticated actor, method, escaped path/query and body hash using the independent `FEED_GATEWAY_SECRET`. It constructs outbound headers from scratch and strips client identity, cookies, authorization, forwarding headers and administrative credentials. The portable HTTP transport remains supported by `FEED_API_ORIGIN` where no service binding is configured. A configured binding failure never escapes to public HTTP.

The Gateway does not request aggregate runtime readiness on each Feed request. Candidate validation must establish the actual API build and dependencies separately; an executor readiness condition must not silently become a synchronous Feed API dependency.

Only an authenticated account in the internal list receives `X-Feed-Gateway-Backend: go` and `X-Feed-Gateway-Rollout` on a forwarded JSON response. These identify the route taken, not a successful write or the running Container SHA. Ordinary users receive neither header. Upstream headers and configured SHA values are not promoted into build proof. Actual Worker, image and schema identities belong in verified health/readiness results and the release manifest.

The added unit fixtures cover stable cohorts, invalid/partial settings, pause and backend-only rollback, body preservation for excluded users, forged client overrides, internal-only diagnostics, and no fallback after an uncertain Go mutation. These synthetic tests do not establish real OAuth, Cloudflare availability, schema compatibility or production cutover acceptance.
