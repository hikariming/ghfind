# Production readback after the runtime foundation merge

At `2026-09-08T05:11:17Z`, authenticated Cloudflare readback reports production
Worker `ghfind` version `156609fa-d14c-40c8-aec2-8170f9e66dca` at 100%. Its release
annotation names exact main SHA `b47b2ee4ab94fb2f833a3d613886ea41524c03bd`, matching
[the successful production workflow](https://github.com/hikariming/ghfind/actions/runs/34187756377).
The raw response is reduced to deployment identities, release annotations,
database bindings and a fixed allowlist of Feed routing flags in `readback.json`.
No secret values or account contact details are retained.

Core and Feed still bind their existing production D1 databases. No selected
Feed routing flag was present in the retained plain-text binding subset. This
record alone does not rule out other binding types and cannot prove the effective
runtime selection. The later [0ca5301 readback](../feed-production-0ca5301/README.md)
checks those flags across all binding types; neither observation is authenticated
Feed E2E evidence. No independent staging runtime, new remote Feed migration or
production Go traffic acceptance is established by this historical record.

Wrangler refreshed its existing OAuth session before these reads. Read access
to the Beiming account works; this does not create the separate Actions token
or prove that the protected operational environment has been configured.

The original JSON was committed on the integration branch as `7f44274` before
being included in a main PR. It is retained byte-for-byte. This document's
interpretation was narrowed when the delayed inclusion was reviewed; its
September 8 05:11 UTC observation does not describe the current active version.
