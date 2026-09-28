# Contributing to GH Find

Start with a small, focused change and describe the user-visible problem in your
pull request. Include how you verified the result and link the relevant issue.

## Prerequisites

- Node.js 22, matching CI. Next.js requires at least 20.9.0; the full toolchain
  should be run with the CI version.
- pnpm **11.24.0**, pinned by `packageManager` in `package.json`.
- Docker for the local database below, or another reachable HTTP libSQL/Turso
  server dedicated to development.
- A GitHub personal access token for public-data collection. A classic PAT with
  no scopes is sufficient for public data; do not grant private repository write
  access for this setup.
- Go **1.23.0 or newer** only when working on the Go CLI/backend.

## Isolated local setup

From your checkout:

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
```

Start an HTTP libSQL database bound to localhost:

```sh
docker run -d --name ghfind-libsql -p 127.0.0.1:8080:8080 \
  -v ghfind-libsql-data:/var/lib/sqld \
  ghcr.io/tursodatabase/libsql-server:latest
```

On Apple Silicon, use the `latest-arm` image tag. For other architectures or
server options, see the [libSQL Docker guide](https://github.com/tursodatabase/libsql/blob/main/docs/DOCKER.md).
The named volume retains your local data. On subsequent runs, use
`docker start ghfind-libsql` instead of creating the same container again.

Replace the placeholder token in `.env.local` and set:

```dotenv
GITHUB_TOKEN=<your public-data GitHub PAT>
TURSO_DATABASE_URL=http://127.0.0.1:8080
TURSO_AUTH_TOKEN=
```

Use the server's auth token if it requires authentication. The application
creates its local libSQL schema on first database use. The web database client
does **not** support `file:` URLs.

Start the app in the isolated local mode:

```sh
CI=true pnpm dev
```

PowerShell equivalent: set `$env:CI = 'true'`, then run `pnpm dev`.

Here `CI=true` skips the development Cloudflare binding initialization in
`src/instrumentation.ts`; it does not make this a production deployment. Current
top-level Wrangler bindings use remote D1, so a bare `pnpm dev` can attempt to
connect to Cloudflare. This setup instead uses your explicit local libSQL URL
and needs no Cloudflare login. Keep deployment credentials and production
database/Redis URLs out of your local environment. Cloudflare-specific features
such as Feed require their own local binding setup and are not covered by this
minimal scan setup.

## Verify a real scan

A rendered homepage is not enough: a fresh scan must collect GitHub data **and
persist the result** before it can succeed. In another terminal:

```sh
curl --fail-with-body --max-time 180 \
  -X POST http://localhost:3000/api/scan \
  -H 'Content-Type: application/json' \
  --data '{"username":"octocat"}' \
  -w '\nHTTP %{http_code}\n'

curl --fail-with-body http://localhost:3000/api/score/octocat
```

Both requests should return HTTP 200 and a score for `octocat`. On the first scan
in a fresh local database/cache, check that the scan is not a legacy fallback and
the score can be read back. Large accounts may take longer than small accounts.
Use `curl.exe` in PowerShell if `curl` resolves to a shell alias.

## Required and optional configuration

| Setting | Local scan requirement |
| --- | --- |
| `GITHUB_TOKEN` | Required for accurate GitHub collection; replace the example value. |
| `TURSO_DATABASE_URL` | Required in the isolated setup above; must be reachable. |
| `TURSO_AUTH_TOKEN` | Required only when your database server requires authentication. |
| `LLM_API_KEY` | Needed for operator-funded roast text, not deterministic scores. |
| Upstash Redis | Optional for local scanning; enables shared caching/rate limiting. |
| Turnstile | Optional locally; configured verification changes scan request requirements. |
| GitHub OAuth | Optional for public scans; needed to exercise signed-in features. |

See [`.env.example`](.env.example) for feature-specific variables. Do not commit
tokens or `.env.local`. Production uses the Cloudflare `GHFIND_D1` binding, not
this local database, and requires `UPSTASH_REDIS_REST_URL` plus
`UPSTASH_REDIS_REST_TOKEN`: protected uncached requests fail closed when the
limiter is unavailable. Do not enable `RATE_LIMIT_FAIL_OPEN` as a normal setup
step. Deployment details belong in the
[Cloudflare runbook](docs/operations/cloudflare-deployment-runbook.md).

## Checks before a pull request

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Run relevant regression tests while developing, then the project checks above
for code changes. For Go CLI changes also run `pnpm cli:test` and
`pnpm cli:build`. CI runs additional release, Cloudflare, storage, and Feed E2E
checks; report any check you could not run rather than claiming it passed.
Documentation-only changes need link/command review, not an unrelated full
test run.

For frontend changes, follow [AGENTS.md](AGENTS.md):

- Toggle **Light**, **Dark**, and **Auto** from the navbar theme control.
- Inspect the changed page in both resolved light and dark themes.
- Check contrast, borders, hover states, inputs, modals, footer areas, report
  Markdown, and mobile/navigation surfaces when affected.
- Watch for background seams, overly dark panels in light mode, and overly
  bright borders in dark mode. Prefer existing semantic Tailwind patterns and
  the light-theme mappings in `src/app/globals.css`.
- Run `pnpm typecheck` and `pnpm lint`.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Homepage loads but scan returns a persistence-related 503 | Database URL/authentication, container health, and reachability. The board may degrade without a database; fresh scans cannot. Repeated retries will not fix missing configuration. |
| `file:` database URL fails | Use an HTTP libSQL server or hosted Turso URL; this application uses the web client. |
| Startup requests Cloudflare authentication | Use `CI=true pnpm dev` for the isolated libSQL setup. Check that inherited environment variables do not point to remote services. |
| `github_token_required` or GitHub authentication failure | Replace `ghp_xxx` with a valid public-data PAT; restart the dev server after configuration changes. |
| `github_rate_limited` / `scan_busy` | Respect `Retry-After`; avoid repeatedly scanning large accounts. |
| Turnstile failure | Leave Turnstile unconfigured for the minimal local setup, or exercise the configured browser verification flow. |
| Roast text fails but scoring works | Configure a supported LLM provider when testing text generation; an LLM key is not needed for score verification. |

