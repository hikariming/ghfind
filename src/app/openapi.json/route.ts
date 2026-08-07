import { SITE_URL } from "@/lib/site";

export const dynamic = "force-static";
export const revalidate = 86400;

/**
 * /openapi.json — machine-readable contract for ghfind's public API, so agents,
 * SDK generators, and API directories can discover and call the endpoints.
 *
 * Documents only the public, stable surface. Auth/admin/OAuth internal routes are
 * intentionally omitted. Kept hand-authored (not generated) because the Next.js
 * App Router has no built-in OpenAPI emit; the two official SDKs (`ghfind` on npm
 * and PyPI) wrap exactly these endpoints.
 */
export function GET() {
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "ghfind API",
      version: "1.3.0",
      description:
        "Score any GitHub account 0-100 for value and trustworthiness with a deterministic engine, " +
        "plus open-source project evaluations, roasts, head-to-head battles, leaderboards, and developer discovery. " +
        "Official SDKs: `@hikariming/ghfind` on npm and `ghfind` on PyPI.\n\n" +
        "## Errors\n" +
        "All errors return `application/json` shaped as `{ error, message, hint }` — `error` is a " +
        "stable machine code, `message`/`hint` are human-readable. See the `Error` schema.\n\n" +
        "## Rate limits\n" +
        "Responses carry `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers; a " +
        "`429` and temporary request-protection `503` responses carry `Retry-After`. Write calls accept an `Idempotency-Key` request header " +
        "(scans are idempotent per username).\n\n" +
        "## Versioning & stability\n" +
        "The API is unversioned (`/api/*`) and evolves additively: new fields may be added, but " +
        "existing fields are not removed or repurposed without notice. Any breaking change is " +
        "announced at least 90 days in advance via the /blog and signalled with `Deprecation` and " +
        "`Sunset` response headers on affected endpoints.",
      termsOfService: `${SITE_URL}/privacy`,
      contact: { name: "ghfind", url: `${SITE_URL}/contact` },
      license: { name: "AGPL-3.0-or-later", url: "https://www.gnu.org/licenses/agpl-3.0.html" },
    },
    servers: [{ url: SITE_URL }],
    externalDocs: { description: "llms.txt", url: `${SITE_URL}/llms.txt` },
    tags: [
      { name: "scoring", description: "Deterministic 0-100 scoring (no LLM)" },
      { name: "roast", description: "LLM-written roast report (bring-your-own key supported)" },
      { name: "battle", description: "Head-to-head PK; deterministic winner, optional LLM commentary" },
      { name: "discovery", description: "Leaderboards, developer directory, search, stats" },
      { name: "projects", description: "Asynchronous Mosoo Cattle Agent evaluation of open-source projects" },
      { name: "images", description: "SVG badge and OG card images" },
    ],
    paths: {
      "/api/score/{username}": {
        get: {
          tags: ["scoring"],
          operationId: "getScore",
          summary: "Get the deterministic score for a GitHub account",
          description:
            "Read-only, no auth, cacheable, never calls an LLM. Returns the deterministic score, " +
            "tier, sub-scores, and percentile. If the account is already indexed you get the stored " +
            "payload (`source: \"indexed\"`, with tags/roast_line). Otherwise the Go API admits a " +
            "durable quick-scan job and waits for the independently restartable worker to persist the " +
            "result (`source: \"quick\"`, `coverage: \"quick\"`, includes red_flags, no LLM copy). " +
            "When only an old compatible stored score exists, the response may be `source: \"legacy_v5_v5_v3\"`, " +
            "`coverage: \"legacy\"`, `stale: true`. The only 404 is a GitHub login that does not exist. Rate limited per IP.",
          parameters: [
            {
              name: "username",
              in: "path",
              required: true,
              description: "GitHub login (case-insensitive)",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Score payload (indexed, quick-worker scored, or legacy fallback)",
              headers: {
                "RateLimit-Limit": { $ref: "#/components/headers/RateLimit-Limit" },
                "RateLimit-Remaining": { $ref: "#/components/headers/RateLimit-Remaining" },
                "RateLimit-Reset": { $ref: "#/components/headers/RateLimit-Reset" },
              },
              content: { "application/json": { schema: { $ref: "#/components/schemas/ScorePayload" } } },
            },
            "400": { description: "Invalid username", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "404": { description: "GitHub account does not exist", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "429": {
              description: "Rate limited (quick scoring path)",
              headers: { "Retry-After": { $ref: "#/components/headers/Retry-After" } },
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "503": { description: "GitHub or request protection temporarily unavailable", headers: { "Retry-After": { $ref: "#/components/headers/Retry-After" } }, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/api/scan": {
        post: {
          tags: ["scoring"],
          operationId: "scan",
          summary: "Run a bounded GitHub scan and compute the deterministic score",
          description:
            "Bounded factual payload: metrics, repo/PR signals, sub_scores, red_flags, and " +
            "final_score. Deterministic — no LLM. Work is admitted to the durable Go worker path; most calls " +
            "return the persisted result inline, while long-running jobs return 202 and a public status Location. In production, machine callers send " +
            "`Authorization: Bearer <api-key>`; browser callers pass a Cloudflare Turnstile token.",
          security: [{ bearerAuth: [] }, {}],
          parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["username"],
                  properties: {
                    username: { type: "string", description: "GitHub login" },
                    turnstileToken: { type: "string", description: "Cloudflare Turnstile token (browser callers)" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Full scan result",
              headers: {
                "RateLimit-Limit": { $ref: "#/components/headers/RateLimit-Limit" },
                "RateLimit-Remaining": { $ref: "#/components/headers/RateLimit-Remaining" },
                "RateLimit-Reset": { $ref: "#/components/headers/RateLimit-Reset" },
              },
              content: { "application/json": { schema: { $ref: "#/components/schemas/ScanResult" } } },
            },
            "202": {
              description: "Scan accepted and still running; poll the Location URL until `result` is present.",
              headers: {
                Location: { description: "Public scan job status URL", schema: { type: "string", example: "/api/scan/jobs/job_aaaaaaaaaaaaaaaa" } },
              },
              content: { "application/json": { schema: { $ref: "#/components/schemas/JobStatus" } } },
            },
            "400": { description: "Invalid body or username", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "401": {
              description: "Invalid API key",
              headers: { "WWW-Authenticate": { description: "Bearer challenge pointing at protected-resource metadata", schema: { type: "string" } } },
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "403": { description: "Turnstile verification failed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "404": { description: "GitHub account not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "429": {
              description: "Rate limited",
              headers: { "Retry-After": { $ref: "#/components/headers/Retry-After" } },
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "503": { description: "GitHub or request protection temporarily unavailable", headers: { "Retry-After": { $ref: "#/components/headers/Retry-After" } }, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/api/scan/jobs/{id}": {
        get: {
          tags: ["scoring"],
          operationId: "scanJobStatus",
          summary: "Query a public scan job admitted by POST /api/scan",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", example: "job_aaaaaaaaaaaaaaaa" } },
          ],
          responses: {
            "200": {
              description: "Current scan job state. Completed jobs include the persisted scan result.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ScanJobStatusResponse" } } },
            },
            "400": { description: "Invalid job id", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "404": { description: "Scan job not found or not a public scan job", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "503": { description: "Status or result temporarily unavailable", headers: { "Retry-After": { $ref: "#/components/headers/Retry-After" } }, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/api/project-analyses": {
        post: {
          tags: ["projects"],
          operationId: "createProjectAnalysis",
          summary: "Reuse or start an evidence-backed open-source project evaluation",
          description:
            "Returns a matching persisted result before creating an asynchronous Mosoo Cattle Agent task. " +
            "Product value is scored independently " +
            "from Stars, company backing, code volume, and contributor count. Unknown public repositories " +
            "receive source inspection only; code execution is restricted to a server allowlist.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["repositoryUrl"],
                  properties: {
                    repositoryUrl: { type: "string", description: "Public GitHub URL or owner/repository" },
                    ref: { type: ["string", "null"], description: "Optional branch, tag, or commit" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Matching completed result loaded from durable persistence",
              headers: {
                Location: { description: "Endpoint for the persisted analysis", schema: { type: "string" } },
                "Idempotency-Key": { description: "Stable analysis task key", schema: { type: "string" } },
                "X-Project-Analysis-Reused": { description: "Always true for a persisted replay", schema: { type: "string", enum: ["true"] } },
              },
              content: { "application/json": { schema: { $ref: "#/components/schemas/ProjectAnalysisAccepted" } } },
            },
            "202": {
              description: "Task created or deduplicated against an active task",
              headers: {
                Location: { description: "Polling endpoint for this analysis", schema: { type: "string" } },
                "Idempotency-Key": { description: "Stable Mosoo task key", schema: { type: "string" } },
              },
              content: { "application/json": { schema: { $ref: "#/components/schemas/ProjectAnalysisAccepted" } } },
            },
            "400": { description: "Invalid repository, ref, or request body", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "429": { description: "Per-IP project-analysis quota exceeded", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "503": { description: "Persistence or Mosoo execution layer unavailable", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/api/project-analyses/{analysisId}": {
        get: {
          tags: ["projects"],
          operationId: "getProjectAnalysis",
          summary: "Read project-evaluation progress or the persisted result",
          parameters: [
            { name: "analysisId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": {
              description: "Curated status; completed tasks include the current assessment and treasure history",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ProjectAnalysisView" } } },
            },
            "404": { description: "Analysis not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/api/roast": {
        post: {
          tags: ["roast"],
          operationId: "roast",
          summary: "Generate the human-facing roast report + AI-adjusted score (streaming)",
          description:
            "Takes a scan (or a username to reuse a cached scan) and streams a markdown roast report " +
            "plus meta (final_score, tier, delta, percentile, tags, roast_line). The only LLM endpoint " +
            "for scoring: the model may adjust the deterministic score by a bounded ±10. Pass `byoKey` " +
            "to use your own OpenAI-compatible provider instead of the server model. Response is a " +
            "text/plain stream using an in-band frame protocol (0x1f prefix: T=progress, M=base64 meta, " +
            "E=error); meta is also returned in the `X-Roast-Meta` header (base64 JSON).",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    scan: { $ref: "#/components/schemas/ScanResult" },
                    username: { type: "string", description: "Use a server-cached scan instead of passing `scan`" },
                    lang: { type: "string", enum: ["zh", "en"] },
                    byoKey: {
                      type: "object",
                      description: "Bring-your-own OpenAI-compatible LLM provider",
                      properties: {
                        baseURL: { type: "string" },
                        apiKey: { type: "string" },
                        model: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Streamed roast report", content: { "text/plain": { schema: { type: "string" } } } },
            "400": { description: "Missing scan / no LLM configured", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "409": { description: "The supplied scan does not match a persisted current score", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "429": {
              description: "Rate limited",
              headers: { "Retry-After": { $ref: "#/components/headers/Retry-After" } },
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "503": {
              description: "Request protection temporarily unavailable",
              headers: { "Retry-After": { $ref: "#/components/headers/Retry-After" } },
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/api/vs-verdict": {
        post: {
          tags: ["battle"],
          operationId: "vsVerdict",
          summary: "Head-to-head verdict for two scored accounts",
          description:
            "Both accounts must already be scored. The winner and gap bucket are deterministic; a " +
            "bilingual savage verdict + self-improvement advice are added by the LLM only when both " +
            "sides clear the floor and the pairing is not cached.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["a", "b"],
                  properties: { a: { type: "string" }, b: { type: "string" } },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Verdict (verdict may be null when below the LLM floor or cached)",
              content: { "application/json": { schema: { $ref: "#/components/schemas/VsVerdictResponse" } } },
            },
            "400": {
              description: "Invalid pair",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "404": {
              description: "One or both accounts not scored",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
            "429": {
              description: "Verdict generation rate limited",
              headers: { "Retry-After": { $ref: "#/components/headers/Retry-After" } },
              content: { "application/json": { schema: { $ref: "#/components/schemas/VsVerdictResponse" } } },
            },
            "503": {
              description: "Request protection temporarily unavailable",
              headers: { "Retry-After": { $ref: "#/components/headers/Retry-After" } },
              content: { "application/json": { schema: { $ref: "#/components/schemas/VsVerdictResponse" } } },
            },
          },
        },
      },
      "/api/leaderboard": {
        get: {
          tags: ["discovery"],
          operationId: "leaderboard",
          summary: "Ranked public profiles (Hall of Fame / trending / heat / progress)",
          parameters: [
            { name: "view", in: "query", schema: { type: "string", enum: ["trending", "score", "heat", "progress"] } },
            { name: "window", in: "query", schema: { type: "string", enum: ["all", "24h", "7d", "30d"] } },
            { $ref: "#/components/parameters/Limit" },
            { $ref: "#/components/parameters/Offset" },
          ],
          responses: {
            "200": {
              description: "Ranked entries",
              content: { "application/json": { schema: { $ref: "#/components/schemas/LeaderboardResponse" } } },
            },
          },
        },
      },
      "/api/developers": {
        get: {
          tags: ["discovery"],
          operationId: "developers",
          summary: "Discover developers by language, organization, or contributed repo",
          parameters: [
            { name: "type", in: "query", required: true, schema: { type: "string", enum: ["language", "org", "repo"] } },
            { name: "value", in: "query", schema: { type: "string" }, description: "Facet value; omit to list categories" },
            { $ref: "#/components/parameters/Limit" },
            { $ref: "#/components/parameters/Offset" },
          ],
          responses: {
            "200": {
              description: "Facet categories or entries",
              content: { "application/json": { schema: { $ref: "#/components/schemas/DevelopersResponse" } } },
            },
            "400": {
              description: "Invalid type",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
            },
          },
        },
      },
      "/api/search-users": {
        get: {
          tags: ["discovery"],
          operationId: "searchUsers",
          summary: "Prefix autocomplete over scored accounts",
          parameters: [{ name: "q", in: "query", schema: { type: "string" } }],
          responses: {
            "200": {
              description: "Up to 6 matching users",
              content: { "application/json": { schema: { $ref: "#/components/schemas/SearchResponse" } } },
            },
          },
        },
      },
      "/api/stats": {
        get: {
          tags: ["discovery"],
          operationId: "stats",
          summary: "Platform totals (number of scored accounts)",
          responses: {
            "200": {
              description: "Aggregate counts",
              content: { "application/json": { schema: { $ref: "#/components/schemas/StatsResponse" } } },
            },
          },
        },
      },
      "/api/badge/{username}": {
        get: {
          tags: ["images"],
          operationId: "badge",
          summary: "SVG score badge for a README",
          parameters: [
            { name: "username", in: "path", required: true, schema: { type: "string" } },
            { name: "lang", in: "query", schema: { type: "string", enum: ["zh", "en"] } },
          ],
          responses: { "200": { description: "SVG image", content: { "image/svg+xml": {} } } },
        },
      },
      "/api/card/{username}": {
        get: {
          tags: ["images"],
          operationId: "card",
          summary: "1200x630 OG PNG card for an account",
          parameters: [
            { name: "username", in: "path", required: true, schema: { type: "string" } },
            { name: "theme", in: "query", schema: { type: "string", enum: ["dark", "light"] } },
            {
              name: "variant",
              in: "query",
              description: "Specialty brag card; omit for the score card.",
              schema: { type: "string", enum: ["score", "contrib", "pr", "path", "work"] },
            },
            { name: "qr", in: "query", description: "Set to 1 for a scannable QR.", schema: { type: "string" } },
          ],
          responses: { "200": { description: "PNG image", content: { "image/png": {} } } },
        },
      },
      "/api/card/mini/{username}": {
        get: {
          tags: ["images"],
          operationId: "miniCard",
          summary: "README-sized SVG card (440x200, or 420x88 for the strip)",
          description:
            "Always 200: an unrated or unknown account renders a placeholder card at the same size, so an embedded image never breaks.",
          parameters: [
            { name: "username", in: "path", required: true, schema: { type: "string" } },
            {
              name: "variant",
              in: "query",
              description: "bars/radar are 440x200; strip is 420x88.",
              schema: { type: "string", enum: ["bars", "radar", "strip"], default: "bars" },
            },
            {
              name: "theme",
              in: "query",
              description: "auto embeds a prefers-color-scheme block so one URL suits both GitHub themes.",
              schema: { type: "string", enum: ["auto", "dark", "light"], default: "auto" },
            },
            {
              name: "lang",
              in: "query",
              schema: { type: "string", enum: ["en", "zh"], default: "en" },
            },
          ],
          responses: { "200": { description: "SVG image", content: { "image/svg+xml": {} } } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Machine API key (GITHUB_ROAST_CLI_API_KEY)" },
      },
      parameters: {
        Limit: {
          name: "limit",
          in: "query",
          required: false,
          description: "Page size (1-500). Defaults to the full list so legacy callers are unaffected.",
          schema: { type: "integer", minimum: 1, maximum: 500 },
        },
        Offset: {
          name: "offset",
          in: "query",
          required: false,
          description: "Zero-based index of the first entry to return. Walk pages via `nextOffset`.",
          schema: { type: "integer", minimum: 0, default: 0 },
        },
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          description: "Client-supplied key echoed back on the response; scans are idempotent per username, so a retried request is safe.",
          schema: { type: "string" },
        },
      },
      headers: {
        "RateLimit-Limit": { description: "Request quota for the window", schema: { type: "integer" } },
        "RateLimit-Remaining": { description: "Requests remaining in the window", schema: { type: "integer" } },
        "RateLimit-Reset": { description: "Seconds until the window resets", schema: { type: "integer" } },
        "Retry-After": { description: "Seconds to wait before retrying (on retryable 429/503 responses)", schema: { type: "integer" } },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          description: "Structured error. `error` is a stable machine code; `message`/`hint` are human-readable.",
          properties: {
            error: {
              type: "string",
              description: "Machine-readable error code",
              enum: [
                "invalid_body",
                "invalid_username",
                "turnstile_failed",
                "rate_limited",
                "rate_limit_unavailable",
                "account_not_found",
                "github_rate_limited",
                "github_unavailable",
                "scan_failed",
                "not_scored",
                "unauthorized",
                "invalid_type",
                "invalid_job_id",
                "not_found",
                "scan_result_unavailable",
                "invalid_repository",
                "invalid_ref",
                "analysis_not_found",
                "analysis_timeout",
                "artifact_missing",
                "artifact_invalid",
                "unexpected_input_request",
                "mosoo_unavailable",
              ],
            },
            message: { type: "string" },
            hint: { type: "string" },
            retry_after: { type: "integer", description: "Present on some 429/503 responses" },
          },
        },
        LeaderboardEntry: {
          type: "object",
          properties: {
            username: { type: "string" },
            display_name: { type: "string", nullable: true },
            avatar_url: { type: "string", nullable: true },
            profile_url: { type: "string", nullable: true },
            final_score: { type: "number" },
            tier: { type: "string" },
          },
        },
        LeaderboardResponse: {
          type: "object",
          properties: {
            entries: { type: "array", items: { $ref: "#/components/schemas/LeaderboardEntry" } },
            cached: { type: "boolean" },
            view: { type: "string", enum: ["trending", "score", "heat", "progress"] },
            window: { type: "string", enum: ["all", "24h", "7d", "30d"] },
            total: { type: "integer", description: "Total entries across all pages" },
            limit: { type: "integer" },
            offset: { type: "integer" },
            nextOffset: { type: "integer", nullable: true, description: "Offset for the next page, or null when exhausted" },
          },
        },
        DevelopersResponse: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["language", "org", "repo"] },
            value: { type: "string", nullable: true },
            entries: { type: "array", items: { $ref: "#/components/schemas/LeaderboardEntry" } },
            categories: {
              type: "array",
              items: { type: "object", properties: { value: { type: "string" }, count: { type: "integer" } } },
            },
            total: { type: "integer", description: "Total entries (or categories) across all pages" },
            limit: { type: "integer" },
            offset: { type: "integer" },
            nextOffset: { type: "integer", nullable: true, description: "Offset for the next page, or null when exhausted" },
          },
        },
        SearchResponse: {
          type: "object",
          properties: {
            users: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  username: { type: "string" },
                  display_name: { type: "string", nullable: true },
                  avatar_url: { type: "string", nullable: true },
                  final_score: { type: "number" },
                },
              },
            },
          },
        },
        StatsResponse: {
          type: "object",
          properties: {
            total: { type: "integer", nullable: true, description: "Number of scored accounts" },
            cached: { type: "boolean" },
          },
        },
        ProjectAnalysisAccepted: {
          type: "object",
          required: ["analysisId", "repoKey", "status", "phase", "progress", "retry", "statusUrl"],
          properties: {
            analysisId: { type: "string", format: "uuid" },
            repoKey: { type: "string", example: "owner/repository" },
            status: { $ref: "#/components/schemas/ProjectAnalysisStatus" },
            phase: { type: "string" },
            progress: { type: "integer", minimum: 0, maximum: 100 },
            retry: { $ref: "#/components/schemas/ProjectAnalysisRetry" },
            statusUrl: { type: "string" },
            reused: { type: "boolean", description: "True when an existing completed result was replayed" },
          },
        },
        ProjectAnalysisStatus: {
          type: "string",
          enum: ["queued", "creating_thread", "running", "finalizing", "completed", "failed", "cancelled", "expired"],
        },
        ProjectAnalysisRetry: {
          anyOf: [
            {
              type: "object",
              required: ["attempt", "maxAttempts", "nextAttemptAt"],
              properties: {
                attempt: { type: "integer", minimum: 1 },
                maxAttempts: { type: "integer", minimum: 1 },
                nextAttemptAt: { type: "integer", description: "Epoch milliseconds" },
              },
            },
            { type: "null" },
          ],
        },
        ProjectAnalysisView: {
          type: "object",
          required: ["analysisId", "repoKey", "canonicalUrl", "status", "phase", "progress", "retry", "createdAt", "updatedAt"],
          properties: {
            analysisId: { type: "string", format: "uuid" },
            repoKey: { type: "string" },
            canonicalUrl: { type: "string", format: "uri" },
            requestedRef: { type: ["string", "null"] },
            status: { $ref: "#/components/schemas/ProjectAnalysisStatus" },
            phase: { type: "string" },
            progress: { type: "integer", minimum: 0, maximum: 100 },
            retry: { $ref: "#/components/schemas/ProjectAnalysisRetry" },
            error: {
              anyOf: [
                {
                  type: "object",
                  required: ["code", "message"],
                  properties: { code: { type: "string" }, message: { type: "string" } },
                },
                { type: "null" },
              ],
            },
            createdAt: { type: "integer", description: "Epoch milliseconds" },
            updatedAt: { type: "integer", description: "Epoch milliseconds" },
            completedAt: { type: ["integer", "null"] },
            assessment: {
              type: ["object", "null"],
              description: "Validated product score, four dimensions, confidence, verification, community strength, exposure, risks, report, and exact commit identity.",
            },
            treasureHistory: { type: "array", items: { type: "object" } },
          },
        },
        VsVerdictResponse: {
          type: "object",
          properties: {
            a: { type: "string" },
            b: { type: "string" },
            winner: { type: "string", nullable: true },
            bucket: { type: "string" },
            verdict: {
              type: "object",
              nullable: true,
              properties: { zh: { type: "string" }, en: { type: "string" } },
            },
          },
        },
        ScorePayload: {
          type: "object",
          properties: {
            source: {
              type: "string",
              enum: ["indexed", "quick", "legacy_v5_v5_v3"],
              description: "indexed = current stored score; quick = current deterministic worker scan; legacy_v5_v5_v3 = compatible stale fallback",
            },
            coverage: { type: "string", enum: ["quick", "legacy"], description: "quick for current Go collection; legacy for accepted old stored scores" },
            stale: { type: "boolean", description: "true only for compatible legacy fallback scores" },
            cached: { type: "boolean", description: "quick path only: served from the scan cache" },
            red_flags: {
              type: "array",
              description: "quick path only: deterministic penalties",
              items: {
                type: "object",
                properties: { flag: { type: "string" }, penalty: { type: "number" }, detail: { type: "string" } },
              },
            },
            username: { type: "string" },
            display_name: { type: "string", nullable: true },
            avatar_url: { type: "string", nullable: true },
            profile_url: { type: "string" },
            final_score: { type: "number", description: "0-100, 2 decimals" },
            tier: { type: "string", enum: ["夯", "顶级", "人上人", "NPC", "拉完了"] },
            tier_key: { type: "string", enum: ["god", "elite", "solid", "npc", "trash"] },
            sub_scores: { $ref: "#/components/schemas/SubScores" },
            tags: { type: "object", nullable: true, properties: { zh: { type: "array", items: { type: "string" } }, en: { type: "array", items: { type: "string" } } } },
            roast_line: { type: "object", nullable: true, properties: { zh: { type: "string" }, en: { type: "string" } } },
            percentile: {
              type: "object",
              nullable: true,
              properties: {
                beat: { type: "number", nullable: true, description: "Percent of ranked accounts beaten" },
                total: { type: "integer" },
                rank: { type: "integer", nullable: true },
              },
            },
            scanned_at: { type: "integer", description: "Epoch ms of last score" },
            profile: { type: "string", description: "Human profile URL on ghfind.com" },
          },
        },
        SubScores: {
          type: "object",
          properties: {
            account_maturity: { type: "number" },
            original_project_quality: { type: "number" },
            contribution_quality: { type: "number" },
            ecosystem_impact: { type: "number" },
            community_influence: { type: "number" },
            activity_authenticity: { type: "number" },
          },
        },
        Scoring: {
          type: "object",
          properties: {
            sub_scores: { $ref: "#/components/schemas/SubScores" },
            base_score: { type: "number" },
            red_flags: {
              type: "array",
              items: {
                type: "object",
                properties: { flag: { type: "string" }, penalty: { type: "number" }, detail: { type: "string" } },
              },
            },
            total_penalty: { type: "number" },
            final_score: { type: "number" },
            tier: { type: "string" },
            tier_label: { type: "string" },
          },
        },
        ScanResult: {
          type: "object",
          description: "Full scan payload — identical shape to the open-source github-account-value skill output.",
          properties: {
            metrics: { type: "object", description: "Raw GitHub-derived metrics (snake_case)" },
            top_repos: { type: "array", items: { type: "object" } },
            recent_prs: { type: "array", items: { type: "object" } },
            flood_pr_titles: { type: "array", items: { type: "string" } },
            impact_repos: { type: "array", items: { type: "object" } },
            scoring: { $ref: "#/components/schemas/Scoring" },
          },
        },
        JobStatus: {
          type: "object",
          properties: {
            id: { type: "string" },
            kind: { type: "string", enum: ["scan.quick.v1", "score_snapshot.v1"] },
            username: { type: "string" },
            state: { type: "string", enum: ["queued", "running", "retrying", "completed", "failed"] },
            attempt: { type: "integer" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
            error: { type: "string" },
          },
        },
        ScanJobStatusResponse: {
          type: "object",
          properties: {
            status: { $ref: "#/components/schemas/JobStatus" },
            result: { $ref: "#/components/schemas/ScanResult" },
          },
        },
      },
    },
  };

  return new Response(JSON.stringify(spec), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=86400",
    },
  });
}
