/**
 * Machine-readable catalog of ghfind's atomic capabilities. Mirrors the CLI
 * command catalog and the /openapi.json spec so an agent can introspect what the
 * SDK can do — including whether a capability is deterministic or uses an LLM.
 */

export interface Capability {
  /** Method name on the {@link import("./client").GhFind} client. */
  method: string;
  /** HTTP endpoint(s) it calls. */
  api: string[];
  summary: string;
  /** Whether the capability involves an LLM. Scoring is always deterministic. */
  llm: boolean;
  /** How an agent should interpret the response. */
  response_semantics: string;
  agent_guidance: string;
}

export const DEFAULT_HOST = "https://ghfind.com";

export const catalog: Capability[] = [
  {
    method: "getScore",
    api: ["GET /api/score/{username}"],
    summary: "Fetch the deterministic score for any GitHub account.",
    llm: false,
    response_semantics:
      "Factual score payload: final_score, tier, sub_scores, percentile. Never calls an LLM. Indexed accounts return stored data (source: indexed, with tags/roast_line); unseen accounts are admitted to the Go quick-scan worker path (source: quick, coverage: quick, includes red_flags). Compatible old stored scores may return source: legacy_v5_v5_v3 with stale: true. 404 only if the GitHub login does not exist.",
    agent_guidance:
      "Preferred first call: cheapest, cacheable way to get a score — works even for accounts never seen before. Use scan() only when you also need the full metrics/repo/PR payload.",
  },
  {
    method: "getGitHubUser / userExists",
    api: ["GET https://api.github.com/users/{username}"],
    summary: "Confirm a GitHub account exists (client-side, via GitHub's own API).",
    llm: false,
    response_semantics:
      "Basic public GitHub profile, or null if the login does not exist. Runs on the caller's IP/quota, NOT ghfind's. No token needed (optional token raises GitHub's ~60/h anon limit).",
    agent_guidance:
      "Use to validate a handle before spending a call on scoring. Pass { verifyExists: true } to scan()/getScore() to do this automatically and fail fast on typos/nonexistent users.",
  },
  {
    method: "scan",
    api: ["POST /api/scan"],
    summary: "Crawl GitHub and compute the full deterministic scan + score.",
    llm: false,
    response_semantics:
      "Authoritative factual payload: metrics, repo/PR signals, deterministic sub_scores, red_flags, final_score. No writer-layer roast copy.",
    agent_guidance:
      "Use when you need full evidence or want to run your own analysis. Treat as the source of truth for scoring facts.",
  },
  {
    method: "score",
    api: ["POST /api/scan"],
    summary: "Compact scoring block derived from scan().",
    llm: false,
    response_semantics: "Just the `scoring` object (numeric score, tier, sub_scores, red_flags).",
    agent_guidance: "Use when you only need the numbers and don't want the full scan payload.",
  },
  {
    method: "roast",
    api: ["POST /api/scan", "POST /api/roast"],
    summary: "Generate the human-facing roast report + AI-adjusted score.",
    llm: true,
    response_semantics:
      "Presentation report: markdown roast, tags, roast_line, plus meta (final_score, tier, delta, percentile). The LLM may adjust the deterministic score by a bounded ±10.",
    agent_guidance:
      "Use only when you want the same report a human sees. Do not treat roast prose as independent factual evidence — use scan/score/getScore for facts. Pass byoKey to use your own model.",
  },
  {
    method: "vs",
    api: ["POST /api/vs-verdict"],
    summary: "Head-to-head verdict for two scored accounts.",
    llm: true,
    response_semantics:
      "Winner and gap bucket are deterministic. verdict/advice prose is LLM and may be null when a side is below the floor or the pairing is cached.",
    agent_guidance:
      "Both accounts must already be scored (call scan/getScore first). Winner is reliable even when verdict prose is null.",
  },
  {
    method: "leaderboard",
    api: ["GET /api/leaderboard"],
    summary: "Ranked public profiles (Hall of Fame / trending / heat / progress).",
    llm: false,
    response_semantics: "Cached ranking/discovery entries — a discovery surface, not fresh per-user scoring.",
    agent_guidance: "Use to discover candidates. For a specific user's facts, call scan/score/getScore.",
  },
  {
    method: "developers",
    api: ["GET /api/developers"],
    summary: "Discover developers by language, organization, or contributed repo.",
    llm: false,
    response_semantics: "Cached discovery categories or entries for a facet.",
    agent_guidance: "Use to find candidates by facet. Verify a specific account with scan/score/getScore.",
  },
  {
    method: "searchUsers",
    api: ["GET /api/search-users"],
    summary: "Prefix autocomplete over scored accounts.",
    llm: false,
    response_semantics: "Up to 6 matching scored users.",
    agent_guidance: "Use to resolve a partial handle to indexed accounts.",
  },
  {
    method: "stats",
    api: ["GET /api/stats"],
    summary: "Platform totals (number of scored accounts).",
    llm: false,
    response_semantics: "Aggregate metadata, not a per-user source.",
    agent_guidance: "Use for platform overview only.",
  },
  {
    method: "badgeUrl / cardUrl / vsCardUrl",
    api: ["GET /api/badge/{username}", "GET /api/card/{username}", "GET /api/card/vs/{a}/{b}"],
    summary: "Build image URLs (SVG badge, OG PNG cards). Pure — no request.",
    llm: false,
    response_semantics: "Returns a URL string.",
    agent_guidance: "Embed the badge in a README or the card in a share preview.",
  },
];

export function findCapability(method: string): Capability | undefined {
  return catalog.find((c) => c.method === method);
}
