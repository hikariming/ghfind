package agentcli

const DefaultHost = "https://ghfind.com"

type CommandInfo struct {
	Name              string   `json:"name"`
	Usage             string   `json:"usage"`
	Summary           string   `json:"summary"`
	API               []string `json:"api"`
	Output            []string `json:"output"`
	ResponseSemantics string   `json:"response_semantics,omitempty"`
	AgentGuidance     string   `json:"agent_guidance,omitempty"`
	Auth              string   `json:"auth"`
	Args              []Arg    `json:"args"`
	Options           []string `json:"options"`
}

type Arg struct {
	Name     string `json:"name"`
	Required bool   `json:"required"`
}

var commandCatalog = []CommandInfo{
	{
		Name:    "scan",
		Usage:   "ghfind scan <username> [-o json|pretty]",
		Summary: "Call the website /api/scan endpoint and return the scan payload.",
		API:     []string{"POST /api/scan"},
		Output:  []string{"json", "pretty"},
		ResponseSemantics: "/api/scan returns factual structured scoring data: metrics, repository signals, PR signals, deterministic sub_scores, red_flags, and base final_score. " +
			"It does not include writer-layer roast copy.",
		AgentGuidance: "Use scan when you need objective account evidence or want to perform your own analysis. Treat this as the authoritative factual payload.",
		Auth:          "Production /api/scan checks machine auth or Turnstile before reading scan cache or using the server GitHub token. When Turnstile is enabled, CLI calls need --api-key/GHFIND_API_KEY backed by server-side GITHUB_ROAST_CLI_API_KEY, or a Turnstile token. GITHUB_ROAST_API_KEY remains a compatibility alias.",
		Args:          []Arg{{Name: "username", Required: true}},
		Options:       []string{"--host", "--api-key", "--turnstile-token", "-o, --output"},
	},
	{
		Name:    "score",
		Usage:   "ghfind score <username> [-o json|pretty]",
		Summary: "Fetch the deterministic score via the public GET /api/score endpoint.",
		API:     []string{"GET /api/score/{username}"},
		Output:  []string{"json", "pretty"},
		ResponseSemantics: "GET /api/score returns a factual score payload: final_score, tier, tier_key, sub_scores, percentile. Never calls an LLM. " +
			"Indexed accounts return stored data (source: indexed, with tags/roast_line); unseen accounts are scored live on demand (source: live, includes red_flags). 404 only if the GitHub login does not exist.",
		AgentGuidance: "Preferred first call: the cheapest, cacheable way to get a score — no auth, works even for never-seen accounts. Use scan when you also need the full metrics/repo/PR payload.",
		Auth:          "None. GET /api/score is public, unauthenticated, edge-cached and rate-limited on the server. The heavy POST /api/scan is what needs --api-key/Turnstile in production.",
		Args:          []Arg{{Name: "username", Required: true}},
		Options:       []string{"--host", "-o, --output"},
	},
	{
		Name:    "roast",
		Usage:   "ghfind roast <username> [--lang zh|en] [-o json|markdown|pretty]",
		Summary: "Call /api/scan, then pass the returned scan to the website /api/roast endpoint.",
		API:     []string{"POST /api/scan", "POST /api/roast"},
		Output:  []string{"json", "markdown", "pretty"},
		ResponseSemantics: "/api/roast returns the website presentation report. It includes writer-layer style: roast tags, roast_line, jokes, sarcasm, and markdown commentary. " +
			"It also returns meta with final_score, tier, tier_label, delta, and percentile.",
		AgentGuidance: "Use roast only when you need the same web-facing report a human sees. Do not treat roast prose as independent factual evidence; for factual scoring use scan or score. Pass --byo-* to run the LLM through your own OpenAI-compatible provider instead of ghfind's model.",
		Auth:          "Production /api/scan checks machine auth or Turnstile before reading scan cache or using the server GitHub token. When Turnstile is enabled, CLI calls need --api-key/GHFIND_API_KEY backed by server-side GITHUB_ROAST_CLI_API_KEY, or a Turnstile token. GITHUB_ROAST_API_KEY remains a compatibility alias.",
		Args:          []Arg{{Name: "username", Required: true}},
		Options:       []string{"--host", "--api-key", "--turnstile-token", "--lang", "--byo-base-url", "--byo-api-key", "--byo-model", "-o, --output"},
	},
	{
		Name:              "vs",
		Usage:             "ghfind vs <a> <b> [--lang zh|en] [-o json|pretty]",
		Summary:           "Call /api/vs-verdict for a head-to-head verdict between two scored accounts.",
		API:               []string{"POST /api/vs-verdict"},
		Output:            []string{"json", "pretty"},
		ResponseSemantics: "Winner and gap bucket are deterministic; verdict/advice prose is LLM and may be null when a side is below the floor or the pairing is cached. Both accounts must already be scored (404 need_both otherwise).",
		AgentGuidance:     "Score both accounts first (score/scan). The winner is reliable even when the verdict prose is null.",
		Auth:              "Does not require authentication.",
		Args:              []Arg{{Name: "a", Required: true}, {Name: "b", Required: true}},
		Options:           []string{"--host", "--lang", "-o, --output"},
	},
	{
		Name:              "exists",
		Usage:             "ghfind exists <username> [-o json|pretty]",
		Summary:           "Check whether a GitHub login exists, via GitHub's own public API.",
		API:               []string{"GET https://api.github.com/users/{username}"},
		Output:            []string{"json", "pretty"},
		ResponseSemantics: "Runs on the caller's IP/quota, NOT ghfind's. Returns exists=true/false; a rate-limit surfaces as github_rate_limited so a throttle is never mistaken for 'not found'.",
		AgentGuidance:     "Use to validate a handle before spending a scoring call. No token needed; pass --github-token/GITHUB_TOKEN to raise GitHub's ~60/h anon limit.",
		Auth:              "No ghfind auth. Optional --github-token for a higher GitHub rate limit.",
		Args:              []Arg{{Name: "username", Required: true}},
		Options:           []string{"--github-token", "-o, --output"},
	},
	{
		Name:              "search",
		Usage:             "ghfind search <query> [-o json|pretty]",
		Summary:           "Call /api/search-users for prefix autocomplete over scored accounts.",
		API:               []string{"GET /api/search-users"},
		Output:            []string{"json", "pretty"},
		ResponseSemantics: "Up to 6 matching scored users (username, final_score, tier). A discovery surface, not fresh per-user scoring.",
		AgentGuidance:     "Use to resolve a partial handle to indexed accounts, then score/scan a specific one.",
		Auth:              "Does not require authentication.",
		Args:              []Arg{{Name: "query", Required: true}},
		Options:           []string{"--host", "-o, --output"},
	},
	{
		Name:              "badge",
		Usage:             "ghfind badge <username> [--markdown] [--lang en] [-o json|pretty]",
		Summary:           "Print the score badge URL, or a README-ready markdown snippet with --markdown.",
		API:               []string{"GET /api/badge/{username}"},
		Output:            []string{"json", "pretty", "markdown"},
		ResponseSemantics: "Pure URL construction (no request). --markdown emits an image linked to the public profile page — paste it into a README to link back to ghfind.",
		AgentGuidance:     "Use --markdown to give a user a badge they can embed. The badge image itself is rendered server-side on demand.",
		Auth:              "Does not contact the server.",
		Args:              []Arg{{Name: "username", Required: true}},
		Options:           []string{"--host", "--markdown", "--lang", "-o, --output"},
	},
	{
		Name:              "card",
		Usage:             "ghfind card <username>",
		Summary:           "Print the OG share-card PNG URL for an account.",
		API:               []string{"GET /api/card/{username}"},
		Output:            []string{"pretty"},
		ResponseSemantics: "Pure URL construction (no request).",
		AgentGuidance:     "Use for a share preview image.",
		Auth:              "Does not contact the server.",
		Args:              []Arg{{Name: "username", Required: true}},
		Options:           []string{"--host"},
	},
	{
		Name:    "auth status",
		Usage:   "ghfind auth status [--host <url>]",
		Summary: "Show the CLI target host and whether local machine-call credentials are configured.",
		API:     []string{},
		Output:  []string{"json", "pretty"},
		Auth:    "Does not contact the server.",
		Args:    []Arg{},
		Options: []string{"--host", "--api-key", "--turnstile-token", "-o, --output"},
	},
	{
		Name:              "update check",
		Usage:             "ghfind update check [-o json|pretty]",
		Summary:           "Check whether this ghfind CLI binary is older than the latest GitHub release.",
		API:               []string{"GET https://api.github.com/repos/hikariming/ghfind/releases/latest"},
		Output:            []string{"json", "pretty"},
		ResponseSemantics: "Returns current_version, latest_version, update_available, release_url, and status. It only checks for updates; it does not self-modify the binary.",
		AgentGuidance:     "Use update check before long-running automation to detect stale CLI installs. If update_available is true, tell the user to install the latest ghfind binary/package before relying on new commands.",
		Auth:              "Does not require authentication.",
		Args:              []Arg{},
		Options:           []string{"--release-url", "-o, --output"},
	},
	{
		Name:              "update install",
		Usage:             "ghfind update install [--method binary|npm|pip|brew] [--dry-run] [-o json|pretty]",
		Summary:           "Install the latest ghfind CLI using a GitHub release binary or a package manager.",
		API:               []string{"GET https://api.github.com/repos/hikariming/ghfind/releases/latest", "GET release asset"},
		Output:            []string{"json", "pretty"},
		ResponseSemantics: "With --method binary, downloads the current platform release asset and atomically replaces the local ghfind binary. With --method npm|pip|brew, runs the matching package-manager upgrade command.",
		AgentGuidance:     "Use --dry-run first to show the exact target asset or package-manager command. Use this only when the user explicitly asks to upgrade the local CLI install.",
		Auth:              "Does not require authentication.",
		Args:              []Arg{},
		Options:           []string{"--method", "--release-url", "--asset-url", "--target", "--dry-run", "-o, --output"},
	},
	{
		Name:              "update npm",
		Usage:             "ghfind update npm [--dry-run] [-o json|pretty]",
		Summary:           "Upgrade the npm-installed ghfind CLI with npm install -g @hikariming/ghfind@latest.",
		API:               []string{},
		Output:            []string{"json", "pretty"},
		ResponseSemantics: "Runs npm install -g @hikariming/ghfind@latest unless --dry-run is set.",
		AgentGuidance:     "Use when ghfind was installed from npm. Prefer --dry-run before executing in automation.",
		Auth:              "Does not require authentication.",
		Args:              []Arg{},
		Options:           []string{"--dry-run", "-o, --output"},
	},
	{
		Name:              "update pip",
		Usage:             "ghfind update pip [--dry-run] [-o json|pretty]",
		Summary:           "Upgrade the PyPI ghfind package with python3 -m pip install --upgrade ghfind.",
		API:               []string{},
		Output:            []string{"json", "pretty"},
		ResponseSemantics: "Runs python3 -m pip install --upgrade ghfind unless --dry-run is set.",
		AgentGuidance:     "Use when ghfind was installed from PyPI. Prefer --dry-run before executing in automation.",
		Auth:              "Does not require authentication.",
		Args:              []Arg{},
		Options:           []string{"--dry-run", "-o, --output"},
	},
	{
		Name:              "update brew",
		Usage:             "ghfind update brew [--dry-run] [-o json|pretty]",
		Summary:           "Upgrade the Homebrew ghfind formula with brew upgrade ghfind.",
		API:               []string{},
		Output:            []string{"json", "pretty"},
		ResponseSemantics: "Runs brew upgrade ghfind unless --dry-run is set.",
		AgentGuidance:     "Use when ghfind was installed from Homebrew. Prefer --dry-run before executing in automation.",
		Auth:              "Does not require authentication.",
		Args:              []Arg{},
		Options:           []string{"--dry-run", "-o, --output"},
	},
	{
		Name:              "stats",
		Usage:             "ghfind stats [-o json|pretty]",
		Summary:           "Call /api/stats and return the platform's scored-account count.",
		API:               []string{"GET /api/stats"},
		Output:            []string{"json", "pretty"},
		ResponseSemantics: "/api/stats returns platform-level aggregate metadata, currently total scored accounts and cache status. It is not a per-user score source.",
		AgentGuidance:     "Use stats for platform overview only. Do not use it as evidence about an individual developer.",
		Auth:              "Does not require authentication.",
		Args:              []Arg{},
		Options:           []string{"--host", "-o, --output"},
	},
	{
		Name:              "leaderboard",
		Usage:             "ghfind leaderboard [--view trending|score|heat|progress] [--window all|24h|7d|30d] [-o json|pretty]",
		Summary:           "Call /api/leaderboard and return ranked public profile entries.",
		API:               []string{"GET /api/leaderboard"},
		Output:            []string{"json", "pretty"},
		ResponseSemantics: "/api/leaderboard returns cached ranking/discovery entries. Ranking views are presentation/discovery surfaces, not fresh per-user scoring facts.",
		AgentGuidance:     "Use leaderboard to discover candidates or compare public ranking context. For factual scoring of a specific user, call scan or score.",
		Auth:              "Does not require authentication.",
		Args:              []Arg{},
		Options:           []string{"--host", "--view", "--window", "-o, --output"},
	},
	{
		Name:              "developers",
		Usage:             "ghfind developers --type language|org|repo [--value <facet>] [-o json|pretty]",
		Summary:           "Call /api/developers and return developer discovery facets or one facet bucket.",
		API:               []string{"GET /api/developers"},
		Output:            []string{"json", "pretty"},
		ResponseSemantics: "/api/developers returns cached discovery categories or entries for a facet. It is a directory/discovery surface, not a direct score calculation endpoint.",
		AgentGuidance:     "Use developers to find candidates by language, organization, or contributed repo. Use scan or score before making claims about a specific account.",
		Auth:              "Does not require authentication.",
		Args:              []Arg{},
		Options:           []string{"--host", "--type", "--value", "-o, --output"},
	},
	{
		Name:    "commands",
		Usage:   "ghfind commands [--json]",
		Summary: "List agent-callable CLI commands.",
		API:     []string{},
		Output:  []string{"json", "pretty"},
		Auth:    "Does not contact the server.",
		Args:    []Arg{},
		Options: []string{"--json"},
	},
	{
		Name:    "commands show",
		Usage:   "ghfind commands show <command> [--json]",
		Summary: "Show one command's arguments, auth requirements, output formats, and website API calls.",
		API:     []string{},
		Output:  []string{"json", "pretty"},
		Auth:    "Does not contact the server.",
		Args:    []Arg{{Name: "command", Required: true}},
		Options: []string{"--json"},
	},
}

func findCommand(name string) (CommandInfo, bool) {
	for _, cmd := range commandCatalog {
		if cmd.Name == name {
			return cmd, true
		}
	}
	return CommandInfo{}, false
}
