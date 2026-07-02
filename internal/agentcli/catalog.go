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
		Summary: "Call /api/scan and print only the scoring summary.",
		API:     []string{"POST /api/scan"},
		Output:  []string{"json", "pretty"},
		ResponseSemantics: "score is a compact view derived from /api/scan.scoring. " +
			"It is factual structured scoring data and does not include writer-layer roast copy.",
		AgentGuidance: "Use score when an agent only needs the numeric result, tier, sub_scores, and red_flags. Prefer this over roast for automated decisions.",
		Auth:          "Production /api/scan checks machine auth or Turnstile before reading scan cache or using the server GitHub token. When Turnstile is enabled, CLI calls need --api-key/GHFIND_API_KEY backed by server-side GITHUB_ROAST_CLI_API_KEY, or a Turnstile token. GITHUB_ROAST_API_KEY remains a compatibility alias.",
		Args:          []Arg{{Name: "username", Required: true}},
		Options:       []string{"--host", "--api-key", "--turnstile-token", "-o, --output"},
	},
	{
		Name:    "roast",
		Usage:   "ghfind roast <username> [--lang zh|en] [-o json|markdown|pretty]",
		Summary: "Call /api/scan, then pass the returned scan to the website /api/roast endpoint.",
		API:     []string{"POST /api/scan", "POST /api/roast"},
		Output:  []string{"json", "markdown", "pretty"},
		ResponseSemantics: "/api/roast returns the website presentation report. It includes writer-layer style: roast tags, roast_line, jokes, sarcasm, and markdown commentary. " +
			"It also returns meta with final_score, tier, tier_label, delta, and percentile.",
		AgentGuidance: "Use roast only when you need the same web-facing report a human sees. Do not treat roast prose as independent factual evidence; for factual scoring use scan or score.",
		Auth:          "Production /api/scan checks machine auth or Turnstile before reading scan cache or using the server GitHub token. When Turnstile is enabled, CLI calls need --api-key/GHFIND_API_KEY backed by server-side GITHUB_ROAST_CLI_API_KEY, or a Turnstile token. GITHUB_ROAST_API_KEY remains a compatibility alias.",
		Args:          []Arg{{Name: "username", Required: true}},
		Options:       []string{"--host", "--api-key", "--turnstile-token", "--lang", "-o, --output"},
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
