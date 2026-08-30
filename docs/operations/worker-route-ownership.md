# Worker route ownership

All public application routes execute inside the OpenNext Cloudflare Worker.
`next.config.ts` intentionally contains no `GHFIND_BACKEND_ORIGIN` rewrites,
and there is no Vercel gateway, Railway API, RabbitMQ worker, or Go process on
the request path.

| Surface | Worker contract |
| --- | --- |
| `GET /api/stats`, `/api/search-users`, `/api/leaderboard`, `/api/developers`, `/api/facet-rank/{username}`, `/api/score/{username}` | Direct application reads through the Cloudflare-compatible data adapters. |
| `POST /api/scan` | Bounded synchronous GitHub collection and deterministic score persistence; no public scan-job queue or polling endpoint. |
| `POST /api/roast`, `POST /api/vs-verdict` | In-process request protection, scoring, persistence, and streaming where applicable. |
| OAuth, `/api/me`, follows, comments, reactions, campaign leaderboard/SSE, and admin backfills | In-app handlers using the Worker configuration and data adapters. |
| `/mcp`, badge/card/OG routes, OpenAPI, sitemap, and pages | In-app routes and renderers; no cross-origin presentation API. |
| Project analyses | The Worker owns admission and status endpoints; Mosoo remains the external evaluator. |

`src/lib/__tests__/backend-route-ownership.test.ts` is the enforced registry of
all `src/app/api` routes. Any new API handler must be added there and reviewed
for runtime compatibility before release.

Worker bindings are defined only in `wrangler.jsonc`. See
[the Cloudflare Worker runbook](./cloudflare-worker-runbook.md) for deployment,
smoke, and rollback procedures.
