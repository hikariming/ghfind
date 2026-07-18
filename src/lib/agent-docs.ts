import { SITE_URL } from "@/lib/site";

/**
 * Single source of truth for the machine-facing prose surfaces: `/llms.txt`,
 * `/llms-full.txt`, `/index.md`, `/auth.md`, the OpenAPI description, and the
 * JSON-LD product copy. Keeping one canonical wording is deliberate — AI entity
 * resolution rewards a brand whose description is identical across the site,
 * the npm/PyPI package metadata, and the README ("cross-verified" = trusted).
 *
 * If you change PRODUCT_ONELINER, mirror it in packages/ghfind-js/package.json,
 * packages/ghfind-py metadata, and README.md so the entity stays consistent.
 */

/**
 * RFC 8288 Link header advertising the machine surfaces. Set on the markdown/doc
 * route responses, and appended by the middleware (src/proxy.ts) to every HTML
 * page after next-intl's hreflang links.
 */
export const AGENT_LINK_HEADER = [
  `<${SITE_URL}/llms.txt>; rel="llms-txt describedby"; type="text/plain"`,
  `<${SITE_URL}/openapi.json>; rel="service-desc"; type="application/openapi+json"`,
  `<${SITE_URL}/.well-known/api-catalog>; rel="api-catalog"`,
  `<${SITE_URL}/sitemap.xml>; rel="sitemap"; type="application/xml"`,
  `<${SITE_URL}/index.md>; rel="alternate"; type="text/markdown"`,
].join(", ");

/** The canonical one-sentence definition. Reused verbatim everywhere. */
export const PRODUCT_ONELINER =
  "ghfind scores any GitHub account 0-100 for real contribution value and trustworthiness with a deterministic, open-source engine — plus a savage one-line roast, head-to-head battles, and a ranked developer directory.";

/** A tight definitional paragraph (the passage LLMs lift into "what is X" answers). */
export const PRODUCT_DESCRIPTION =
  "ghfind is a developer-scoring and discovery tool for GitHub. It rates any account from 0 to 100 across six weighted dimensions — account maturity, original project quality, contribution quality, ecosystem impact, community influence, and activity authenticity — using a fully deterministic engine (the open-source github-account-value skill, AGPL). The same inputs always produce the same score; no LLM touches the number. On top of the score it adds an optional AI-written roast, developer-vs-developer battles, language/org/project leaderboards, and README score badges.";

/**
 * Named statistics from the public research dataset. Specific numbers are what
 * LLMs cite; slogans are not. Keep in sync with the blog post + data.json.
 */
export const NAMED_STATS = {
  accountsScored: "18,947",
  fullSnapshots: "3,444",
  dimensions: 6,
  flaggedShare: "under 1%",
} as const;

export const USE_CASES = [
  "Vet a GitHub account before hiring, sponsoring, or merging: get a reproducible 0-100 trust score instead of eyeballing stars and follower counts.",
  "Detect AI/bot/farmed contribution: the engine flags PR-farming, star inflation, and template-spam patterns that look plausible per-event but not in aggregate.",
  "Self-assess and improve: see your six-dimension breakdown and the specific gaps holding your score down.",
  "Compare two developers head-to-head with a deterministic winner and gap bucket.",
  "Discover top developers by programming language, organization, or contributed project.",
];

export const WHEN_TO_USE = [
  `Use GET ${SITE_URL}/api/score/{username} (or the MCP tool score_user) when you need one account's factual score/tier — deterministic, no auth, no LLM. It scores unseen accounts live on demand.`,
  `Use POST ${SITE_URL}/api/scan (or scan_user) when you need the full evidence payload: raw metrics, top repos, recent PRs, red flags, sub-scores. High-volume public histories can return 202; poll scan-status with the returned run_id before treating them as complete evidence.`,
  `Use POST ${SITE_URL}/api/roast (or the CLI) only when you want the human-facing prose roast — this is the one LLM path and it can spend model credit.`,
  `Use the leaderboard / developers / stats endpoints for discovery and platform context, NOT as fresh per-user scoring evidence (they are ranked snapshots).`,
  "Do NOT treat a low score as a factual claim about a person — scores use public signals only; private-org work is invisible to them.",
];

/** Markdown: the URL grammar block (same as the site Omnibox). */
export function urlGrammarMd(): string {
  return `## URL grammar (agent- and human-friendly)

- Roast / score a user: [${SITE_URL}/u/{username}](${SITE_URL}/u/{username})
- Compare two users: [${SITE_URL}/vs/{a}/{b}](${SITE_URL}/vs/{a}/{b}) (dictionary-ordered; /vs/b/a redirects to /vs/a/b)
- Language leaderboard: ${SITE_URL}/developers/language/{Language} (e.g. [/developers/language/Rust](${SITE_URL}/developers/language/Rust))
- Org leaderboard: ${SITE_URL}/developers/org/{org} (e.g. [/developers/org/huggingface](${SITE_URL}/developers/org/huggingface))
- Project leaderboard: ${SITE_URL}/developers/repo/{owner}/{name}
- Hall of Fame: [${SITE_URL}/leaderboard](${SITE_URL}/leaderboard)`;
}

/** Markdown: the programmatic REST surface with links. */
export function apiSummaryMd(): string {
  return `## Programmatic API

Machine-readable spec: [${SITE_URL}/openapi.json](${SITE_URL}/openapi.json) · API catalog: [${SITE_URL}/.well-known/api-catalog](${SITE_URL}/.well-known/api-catalog) · Auth: [${SITE_URL}/auth.md](${SITE_URL}/auth.md)

- \`GET ${SITE_URL}/api/score/{username}\` — deterministic score, no auth, no LLM; scores unseen accounts live. A \`202 scan_enrichment_pending\` means public history is still being collected; it is not a final score.
- \`POST ${SITE_URL}/api/scan\` { "username": "..." } — full deterministic scan payload (metrics + repo/PR signals + red flags). For large public histories it returns \`202 { error: "scan_enrichment_pending", run_id, retry_after }\` instead of a partial final payload.
- \`GET ${SITE_URL}/api/scan-status/{username}?run_id={run_id}\` — poll a previously requested durable scan using the opaque \`run_id\` returned by the initiating request. Only \`200 { status: "complete_public", scan }\` is complete factual evidence; \`202\` is still collecting and \`503\` is a failed/unavailable durable run.
- \`POST ${SITE_URL}/api/roast\` — LLM roast report (streaming); pass \`byoKey\` for your own model. It returns \`409 scan_enrichment_pending\` rather than roasting a partial large-history scan.
- \`POST ${SITE_URL}/api/vs-verdict\` { "a": "...", "b": "..." } — head-to-head verdict.
- \`GET ${SITE_URL}/api/leaderboard?view=trending|score|heat|progress&window=all|24h|7d|30d&limit={1-500}&offset={n}\` — paginated; walk pages via \`nextOffset\`.
- \`GET ${SITE_URL}/api/developers?type=language|org|repo&value={facet}&limit={1-500}&offset={n}\`
- \`GET ${SITE_URL}/api/search-users?q={prefix}\` · \`GET ${SITE_URL}/api/stats\`

Errors are JSON: \`{ "error": "<code>", "message": "...", "hint": "..." }\`. Responses carry \`RateLimit-*\` headers; a 429 carries \`Retry-After\`. A durable-history 202/409 also carries \`Retry-After\`; wait or poll instead of retrying the expensive POST loop. Write calls accept an \`Idempotency-Key\` header (scans are idempotent per username).

Bulk vetting (recruiting screens, candidate pipelines, account-trust checks at scale): the API is free for moderate use; if you need higher rate limits for batch scoring, email [lbm21@tsinghua.org.cn](mailto:lbm21@tsinghua.org.cn) or ask via [${SITE_URL}/contact](${SITE_URL}/contact) — this is a supported use case, not something to work around.`;
}

/** Markdown: the MCP server block. */
export function mcpSummaryMd(): string {
  return `## MCP server

Streamable HTTP MCP server at [${SITE_URL}/mcp](${SITE_URL}/mcp) (no auth, per-IP rate limited). Server card: [${SITE_URL}/.well-known/mcp/server-card.json](${SITE_URL}/.well-known/mcp/server-card.json).

Tools: \`score_user\`, \`scan_user\`, \`compare_users\`, \`get_leaderboard\`, \`search_users\`.`;
}

/** Markdown: SDKs + CLI. */
export function toolingMd(): string {
  return `## Official SDKs & CLI

- JavaScript / TypeScript (npm): [\`@hikariming/ghfind\`](https://www.npmjs.com/package/@hikariming/ghfind) — \`npm install -g @hikariming/ghfind\`
- Python (PyPI): [\`ghfind\`](https://pypi.org/project/ghfind/) — \`pip install --upgrade ghfind\`
- CLI: \`ghfind score {username} -o json\` · \`ghfind scan {username} -o json\` · \`ghfind roast {username} --lang zh|en\` · \`ghfind leaderboard\` · \`ghfind developers\` · \`ghfind stats\`

Scoring is deterministic and never calls an LLM. Roast/vs prose is the only LLM part and supports bring-your-own key. Source: [github.com/hikariming/ghfind](https://github.com/hikariming/ghfind).`;
}
