# Turso history follow-up — 2026-09-09

The existing ghfind Turso connection was located, but historical assessment
completeness is **still unverified**. Both bounded `SELECT 1` probes returned
HTTP 502 without a connection row. No Turso assessment keys or content were
retrieved, so there is no Turso/core-D1 count, key, version or content-hash
comparison to accept. A server error does not establish that the database was
deleted, that its credentials are valid, or that its contents are absent.

This supplement was prepared from repository base
`cc228bf2c467f45f7ac81a2bc62cb5da05460d2a`. The HTTP probes were observed on September 8,
2026 at 17:23–17:25 UTC, following configuration inspection (September 9 in the
operator's Asia/Hong_Kong time zone). The structured, non-secret record is
[2026-09-09-turso-history-readonly.json](2026-09-09-turso-history-readonly.json).
It contains configuration presence, scoped resource identities and query
outcomes; it is not a database snapshot.

## Prior gap and newly verified configuration

The [initial audit](2026-09-08-feed-platform.md) found no Turso settings in its
process environment or local `.env.local`. That narrow finding remains true:
this process has no `TURSO_*`/`LIBSQL_*` variables; `.env.local` has none, and
`.env.example` has empty Turso placeholders. The Turso CLI is not installed.
The historical `local-notes/cf-migration/` and `tmp/turso-dump.mts` paths named in
the migration record are absent from this checkout. Their absence here does
not prove there are no snapshots elsewhere.

Only the already identified Railway project and environment were inspected:

| Resource | Identifier | Newly observed |
| --- | --- | --- |
| Project | `815ec3e1-679a-41b4-a7c0-6ba65b64db8e` (`ghfind-staging`) | Existing project; no project enumeration outside this scope. |
| Environment | `b9d929d6-a1e4-4e74-b43f-38ed529cc6f1` (`production`) | Explicit scope on every configuration read. |
| API | `023799da-f0bc-4d85-94c8-b6a1ef71c5f5` (`ghfind-api`) | `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are present and nonempty. |
| Executor | `5c56db45-47ed-4a1a-af37-0225885aadf2` (`ghfind-worker`) | The same two settings are present and nonempty. |

The URL settings use `libsql` and the same `.turso.io` hostname. They do not
point to the Railway `ghfind-libsql` fixture. The hostname SHA-256 is
`a9504ace85deb1155e7ad449ecaf2ff78955820248b74bfd6c250fb13d0f0ee0`.
The hostname itself and token values are deliberately absent from the record.
Neither configured URL contains URL user-info or query credential fields.
This confirms a project-specific historical connection configuration, **not**
current successful database authorization or a complete historical dataset.

The Railway MCP read supplied scoped service identities and variable names.
The existing local Railway CLI authorization supplied the settings to a bounded
subprocess; values remained in process memory and were never printed, committed,
or used with another endpoint. CLI version was 5.49.6; Node was 22.17.0 and the
repository's existing `@libsql/client` was 0.17.4. No installation, login, Turso database-token
creation/refresh, service restart or resource change was performed.

## Read-only attempts

The application persistence helpers were not called: their Turso fallback can
initialize schema. Instead the existing SDK was used directly in explicit
`read` batch mode, followed by the documented HTTPS pipeline for the minimal
constant query. The SDK's read transaction mode restricts statements to reads;
the HTTP probe contained only `SELECT 1 AS connection_ok` and stream close.
See the official [Turso SDK reference](https://docs.turso.tech/sdk/ts/reference)
and [SQL-over-HTTP quickstart](https://docs.turso.tech/sdk/http/quickstart).

| Attempt | Bound and request | Result |
| --- | --- | --- |
| SDK schema discovery | One read batch, 25-second bound; exact table-name allowlist `project_assessments`, `project_analysis_runs`, then their column metadata | SDK error code `SERVER_ERROR`; no result set received. |
| Minimal API-configuration probe | 2026-09-08 17:23:45 UTC; existing API credentials, HTTPS `/v2/pipeline`, 20-second bound | HTTP 502; `application/json`; 86 response bytes; no connection row or structured protocol error code. |
| Single bounded retry | 2026-09-08 17:25:03 UTC; existing executor credentials, same hostname and query, 20-second bound | HTTP 502; `application/json`; 86 response bytes; top-level `error` field; no connection row or structured protocol error code. |

The server error body was not retained or printed. One earlier diagnostic used
an invalid local `libsql`→`https` URL conversion and did not establish an HTTP
response; it is excluded from remote failure counts. An uncleared local timer
after the failed SDK request also printed a timeout marker; this is not a second
remote response or evidence that Turso timed out. The table above retains only
actual observed SDK/HTTP outcomes.

No database write statement, runtime DDL, arbitrary remote SQL interface or
migration was executed. No user records, assessment prose or raw artifact
payloads were obtained. Read failure means `rowsAffected`/D1 `rows_written`
values are **not available**, rather than measured zero.

## Authority and remaining acceptance boundary

The operational core D1 remains `ghfind`,
`60d45096-bfe7-4de1-8b85-c1b66a466b0d`, through `GHFIND_D1`. Its already verified
production role is unchanged, and `src/lib/project-analysis-db.ts` still selects
the binding before the Turso fallback. No fresh D1 data query was made during
this supplement: without the other side, repeating its known row count would
not produce comparison evidence.

The [August 29 migration record](../plans/2026-08-28-cloudflare-migration-execution.md)
reports 31 tables/245k+ imported rows, an approximately one-hour write gap, and
historical byte-reconstruction corrections. These remain historical claims;
this attempt neither verifies nor disproves them. The earlier pasted instruction
calling Turso authoritative does not override the subsequently verified active
D1 path or authorize choosing records by the newest `updated_at`.

A later completion of this gate still requires a readable, identified Turso
endpoint or a verified read-only snapshot. The comparison must then record a
stable cutoff/watermark, assessment `repo_key` sets, linked analysis IDs and
versions, and canonical content digests on both sides, including recomputation
of assessment artifact hashes where available. Missing keys and differing
contents must be counted separately from schema-only or timestamp differences;
any concurrent changes must invalidate an unstable comparison. Until that
happens, all comparison counts and digests are **unknown**, not zero or equal.

No production cutover, core-source migration, loss acceptance, legacy-data
retirement, or permission change is authorized by this supplement. Feed work on
the established D1 source can continue within its separate release gates.
