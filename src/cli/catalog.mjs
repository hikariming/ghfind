export const DEFAULT_HOST = "https://ghfind.com";
export const DEFAULT_RELEASE_URL = "https://api.github.com/repos/hikariming/ghfind/releases/latest";

export const commandCatalog = [
  {
    name: "scan",
    usage: "ghfind scan <username> [-o json|pretty]",
    summary: "Call the website /api/scan endpoint and return the scan payload.",
    api: ["POST /api/scan"],
    output: ["json", "pretty"],
    response_semantics:
      "/api/scan returns factual structured scoring data: metrics, repository signals, PR signals, deterministic sub_scores, red_flags, and base final_score. It does not include writer-layer roast copy.",
    agent_guidance:
      "Use scan when you need objective account evidence or want to perform your own analysis. Treat this as the authoritative factual payload.",
    auth:
      "Production /api/scan checks machine auth or Turnstile before reading scan cache or using the server GitHub token. When Turnstile is enabled, CLI calls need --api-key/GHFIND_API_KEY backed by server-side GITHUB_ROAST_CLI_API_KEY, or a Turnstile token. GITHUB_ROAST_API_KEY remains a compatibility alias.",
    args: [{ name: "username", required: true }],
    options: ["--host", "--api-key", "--turnstile-token", "-o, --output"],
  },
  {
    name: "score",
    usage: "ghfind score <username> [-o json|pretty]",
    summary: "Call /api/scan and print only the scoring summary.",
    api: ["POST /api/scan"],
    output: ["json", "pretty"],
    response_semantics:
      "score is a compact view derived from /api/scan.scoring. It is factual structured scoring data and does not include writer-layer roast copy.",
    agent_guidance:
      "Use score when an agent only needs the numeric result, tier, sub_scores, and red_flags. Prefer this over roast for automated decisions.",
    auth:
      "Production /api/scan checks machine auth or Turnstile before reading scan cache or using the server GitHub token. When Turnstile is enabled, CLI calls need --api-key/GHFIND_API_KEY backed by server-side GITHUB_ROAST_CLI_API_KEY, or a Turnstile token. GITHUB_ROAST_API_KEY remains a compatibility alias.",
    args: [{ name: "username", required: true }],
    options: ["--host", "--api-key", "--turnstile-token", "-o, --output"],
  },
  {
    name: "roast",
    usage: "ghfind roast <username> [--lang zh|en] [-o json|markdown|pretty]",
    summary: "Call /api/scan, then pass the returned scan to the website /api/roast endpoint.",
    api: ["POST /api/scan", "POST /api/roast"],
    output: ["json", "markdown", "pretty"],
    response_semantics:
      "/api/roast returns the website presentation report. It includes writer-layer style: roast tags, roast_line, jokes, sarcasm, and markdown commentary. It also returns meta with final_score, tier, tier_label, delta, and percentile.",
    agent_guidance:
      "Use roast only when you need the same web-facing report a human sees. Do not treat roast prose as independent factual evidence; for factual scoring use scan or score.",
    auth:
      "Production /api/scan checks machine auth or Turnstile before reading scan cache or using the server GitHub token. When Turnstile is enabled, CLI calls need --api-key/GHFIND_API_KEY backed by server-side GITHUB_ROAST_CLI_API_KEY, or a Turnstile token. GITHUB_ROAST_API_KEY remains a compatibility alias.",
    args: [{ name: "username", required: true }],
    options: ["--host", "--api-key", "--turnstile-token", "--lang", "-o, --output"],
  },
  {
    name: "auth status",
    usage: "ghfind auth status [--host <url>]",
    summary: "Show the CLI target host and whether local machine-call credentials are configured.",
    api: [],
    output: ["json", "pretty"],
    auth: "Does not contact the server.",
    args: [],
    options: ["--host", "--api-key", "--turnstile-token", "-o, --output"],
  },
  {
    name: "update check",
    usage: "ghfind update check [-o json|pretty]",
    summary: "Check whether this ghfind CLI install is older than the latest GitHub release.",
    api: ["GET https://api.github.com/repos/hikariming/ghfind/releases/latest"],
    output: ["json", "pretty"],
    response_semantics:
      "Returns current_version, latest_version, update_available, release_url, and status. It only checks for updates; it does not self-modify the install.",
    agent_guidance:
      "Use update check before long-running automation to detect stale CLI installs. If update_available is true, tell the user to install the latest ghfind binary/package before relying on new commands.",
    auth: "Does not require authentication.",
    args: [],
    options: ["--release-url", "-o, --output"],
  },
  {
    name: "stats",
    usage: "ghfind stats [-o json|pretty]",
    summary: "Call /api/stats and return the platform's scored-account count.",
    api: ["GET /api/stats"],
    output: ["json", "pretty"],
    response_semantics:
      "/api/stats returns platform-level aggregate metadata, currently total scored accounts and cache status. It is not a per-user score source.",
    agent_guidance:
      "Use stats for platform overview only. Do not use it as evidence about an individual developer.",
    auth: "Does not require authentication.",
    args: [],
    options: ["--host", "-o, --output"],
  },
  {
    name: "leaderboard",
    usage: "ghfind leaderboard [--view trending|score|heat|progress] [--window all|24h|7d|30d] [-o json|pretty]",
    summary: "Call /api/leaderboard and return ranked public profile entries.",
    api: ["GET /api/leaderboard"],
    output: ["json", "pretty"],
    response_semantics:
      "/api/leaderboard returns cached ranking/discovery entries. Ranking views are presentation/discovery surfaces, not fresh per-user scoring facts.",
    agent_guidance:
      "Use leaderboard to discover candidates or compare public ranking context. For factual scoring of a specific user, call scan or score.",
    auth: "Does not require authentication.",
    args: [],
    options: ["--host", "--view", "--window", "-o, --output"],
  },
  {
    name: "developers",
    usage: "ghfind developers --type language|org|repo [--value <facet>] [-o json|pretty]",
    summary: "Call /api/developers and return developer discovery facets or one facet bucket.",
    api: ["GET /api/developers"],
    output: ["json", "pretty"],
    response_semantics:
      "/api/developers returns cached discovery categories or entries for a facet. It is a directory/discovery surface, not a direct score calculation endpoint.",
    agent_guidance:
      "Use developers to find candidates by language, organization, or contributed repo. Use scan or score before making claims about a specific account.",
    auth: "Does not require authentication.",
    args: [],
    options: ["--host", "--type", "--value", "-o, --output"],
  },
  {
    name: "commands",
    usage: "ghfind commands [--json]",
    summary: "List agent-callable CLI commands.",
    api: [],
    output: ["json", "pretty"],
    auth: "Does not contact the server.",
    args: [],
    options: ["--json"],
  },
  {
    name: "commands show",
    usage: "ghfind commands show <command> [--json]",
    summary: "Show one command's arguments, auth requirements, output formats, and website API calls.",
    api: [],
    output: ["json", "pretty"],
    auth: "Does not contact the server.",
    args: [{ name: "command", required: true }],
    options: ["--json"],
  },
];

export function findCommand(name) {
  return commandCatalog.find((cmd) => cmd.name === name || cmd.name.replace(/\s+/g, "-") === name);
}
