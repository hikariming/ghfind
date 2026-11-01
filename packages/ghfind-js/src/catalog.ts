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
      "Factual score payload: final_score, tier, six-dimension sub_scores, and v10 risk_assessment/risk_notes. Never calls an LLM. Indexed accounts return stored data (source: indexed, with tags/roast_line); unseen accounts are admitted to the Go quick-scan worker path (source: quick, coverage: quick). Compatible old stored scores may return source: legacy_v5_v5_v3 with stale: true. 404 only if the GitHub login does not exist.",
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
      "Authoritative factual payload: metrics, repo/PR signals, deterministic sub_scores, v10 red_flags/risk_assessment/risk_notes, and final_score. No writer-layer roast copy.",
    agent_guidance:
      "Use when you need full evidence or want to run your own analysis. Treat as the source of truth for scoring facts.",
  },
  {
    method: "score",
    api: ["POST /api/scan"],
    summary: "Compact scoring block derived from scan().",
    llm: false,
      response_semantics: "Just the `scoring` object (numeric score, tier, six sub_scores, v10 risk_assessment, risk_notes, and actual red_flags).",
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
  {
    method: "bot status",
    api: ["GET https://bot.ghfind.com/api/v1/repos/{owner}/{repo}"],
    summary:
      "CLI only: `ghfind bot status <owner/repo>`. Settings, recent and failed jobs, the latest cleanup and the audit log of the ghfind Review GitHub App on one repository.",
    llm: false,
    response_semantics:
      "Requires a personal API token with the bot permission: select Manage the ghfind Review bot at https://ghfind.com/integrations when creating it. Existing tokens remain scan-only. Needs write access to the repository; viewer.admin says whether you may change anything. Errors are {error: code}: invalid_token, token_scope_required, not_found (App not installed, no such repository, or no write access), admin_required, rate_limited.",
    agent_guidance:
      "First call when a user reports a problem with the bot on their repository. Check settings, jobs.failed and cleanup before acting.",
  },
  {
    method: "bot settings get / bot settings set",
    api: ["GET|PATCH https://bot.ghfind.com/api/v1/repos/{owner}/{repo}/settings"],
    summary:
      "CLI only: `ghfind bot settings set <owner/repo> [--issues on|off] [--prs on|off] [--comments-enabled on|off] [--triage on|off] [--prompt TEXT] [--allowed-labels a,b]`. Changes only the given switches. Admin only.",
    llm: false,
    response_semantics: "Requires a personal API token with the bot permission: select Manage the ghfind Review bot at https://ghfind.com/integrations when creating it. Existing tokens remain scan-only. Returns the saved settings. --allowed-labels must name existing repository labels; review: labels are rejected.",
    agent_guidance: "Change one switch at a time and confirm the user asked for it.",
  },
  {
    method: "bot pause / bot resume",
    api: ["POST https://bot.ghfind.com/api/v1/repos/{owner}/{repo}/pause", "POST .../resume"],
    summary:
      "CLI only: `ghfind bot pause <owner/repo>` turns off issue and PR processing and cancels queued jobs; `resume` turns both back on. Admin only.",
    llm: false,
    response_semantics: "Requires a personal API token with the bot permission: select Manage the ghfind Review bot at https://ghfind.com/integrations when creating it. Existing tokens remain scan-only. Returns the settings; pause also returns cancelled_jobs.",
    agent_guidance: "Pause before a cleanup, otherwise new issues and PRs are labelled again while it runs.",
  },
  {
    method: "bot backfill / bot retry",
    api: ["POST https://bot.ghfind.com/api/v1/repos/{owner}/{repo}/backfill", "POST .../retry"],
    summary:
      "CLI only: `ghfind bot backfill <owner/repo> [-n 25]` queues the newest open items (1-100, one backfill at a time); `ghfind bot retry <owner/repo> [job-id]` requeues failed jobs. Admin only.",
    llm: false,
    response_semantics: "Requires a personal API token with the bot permission: select Manage the ghfind Review bot at https://ghfind.com/integrations when creating it. Existing tokens remain scan-only. 202 on success; backfill_busy (409) while a backfill is pending or running.",
    agent_guidance: "Use retry after fixing the cause shown in `bot status` jobs.",
  },
  {
    method: "bot cleanup / bot cleanup confirm / bot cleanup status / bot cleanup cancel",
    api: [
      "POST https://bot.ghfind.com/api/v1/repos/{owner}/{repo}/cleanups",
      "GET .../cleanups/{id}",
      "POST .../cleanups/{id}/confirm",
      "POST .../cleanups/{id}/cancel",
    ],
    summary:
      "CLI only: `ghfind bot cleanup <owner/repo> [--labels review|triage|all] [--comments] [--delete-label-definitions]` previews what the bot would remove and returns a confirm token; `ghfind bot cleanup confirm <owner/repo> <token> [--wait]` executes it. Admin only.",
    llm: false,
    response_semantics:
      "Requires a personal API token with the bot permission: select Manage the ghfind Review bot at https://ghfind.com/integrations when creating it. Existing tokens remain scan-only. Removes only what the bot wrote: review: labels, intent labels the bot recorded applying, and its own marked comments. Labels people applied are never removed. Label deletion requires the latest exact-name event to identify this bot; unknown history is preserved. Review definitions are deleted only when unused. Intent label definitions are never deleted. The preview changes nothing; the token expires 10 minutes after the preview is ready. Execution is queued, respects GitHub quota and is idempotent (gone or preserved items count as skipped).",
    agent_guidance:
      "Always run the preview first and show the user the counts. Run confirm only after the user agrees to that exact preview. Pause the bot first if the preview warns bot_active.",
  },
];

export function findCapability(method: string): Capability | undefined {
  return catalog.find((c) => c.method === method);
}
