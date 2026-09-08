# Production readback after the runtime foundation merge

At `2026-09-08T05:11:17Z`, authenticated Cloudflare readback reports production
Worker `ghfind` version `156609fa-d14c-40c8-aec2-8170f9e66dca` at 100%. Its release
annotation names exact main SHA `b47b2ee4ab94fb2f833a3d613886ea41524c03bd`, matching
[the successful production workflow](https://github.com/hikariming/ghfind/actions/runs/34187756377).
The raw response is reduced to deployment identities, release annotations,
database bindings and a fixed allowlist of Feed routing flags in `readback.json`.
No secret values or account contact details are retained.

Core and Feed still bind their existing production D1 databases. No selected
Feed routing flag was present as a plain-text binding. Combined with the merged
source defaults, this establishes the existing runtime remains the default;
it is not authenticated Feed E2E evidence. The independent staging runtime,
new remote Feed migrations, source outbox and production Go traffic have not
been enabled by this readback or by merging the runtime foundation.

Wrangler refreshed its existing OAuth session before these reads. Read access
to the Beiming account works; this does not create the separate Actions token
or prove that the protected operational environment has been configured.
