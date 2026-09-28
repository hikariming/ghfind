# Production readback after capacity workflow integration

[PR #251](https://github.com/hikariming/ghfind/pull/251) merged exact tested head
`85e6b47a6777b71ce603ef9565da7e9ec2424b72` after
[required CI](https://github.com/hikariming/ghfind/actions/runs/34256060476) passed.
Merge `1bc35c368a5b73a353d3b07234be653ce7cc3ac4` passed
[main CI](https://github.com/hikariming/ghfind/actions/runs/34256682390) and the
[automatic production workflow](https://github.com/hikariming/ghfind/actions/runs/34257060780).

At **2026-09-08T17:39:31.338467Z**, a read-only Cloudflare API request reported
Worker `ghfind` at version `af79df38-bf39-4d4f-b561-41128564b68b`, 100% traffic.
Its release annotation matches that exact merge SHA. The
[filtered readback](readback.json) retains deployment metadata, D1 identities and
only the three named Feed configuration overrides. Every binding type was checked
for `FEED_BACKEND`, `FEED_STORE_PROFILE` and `FEED_SOURCE_OUTBOX_ENABLED`; none was
present. No credential values or unrelated settings are retained.

Core D1 remains `60d45096-bfe7-4de1-8b85-c1b66a466b0d`; Feed D1 remains
`9c4ac13a-4c90-40a8-9d56-d7141f864bbf`. Checked-in legacy/off defaults and the
existing application migration allowlist remain in effect. This release adds an
isolated synthetic capacity workflow and evidence validation; it does not enable
Go Feed, source outbox, Containers or a database promotion. The separate
[Linux capacity run](https://github.com/hikariming/ghfind/actions/runs/34257139145)
failed its latency and offered-request error thresholds. A successful application
release therefore does not establish Feed capacity or readiness for cutover.
