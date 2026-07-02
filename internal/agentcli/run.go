package agentcli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
)

type globalOptions struct {
	Host           string
	APIKey         string
	TurnstileToken string
	GitHubToken    string
	Output         string
	Lang           string
	View           string
	Window         string
	FacetType      string
	FacetValue     string
	ReleaseURL     string
	ByoBaseURL     string
	ByoAPIKey      string
	ByoModel       string
	Markdown       bool
	UpdateMethod   string
	TargetPath     string
	AssetURL       string
	DryRun         bool
	JSON           bool
	Help           bool
	Version        bool
}

// subScoreOrder is the canonical dimension order for stable, diffable output —
// Go map iteration is randomized, so never range a sub_scores map directly.
var subScoreOrder = []string{
	"account_maturity",
	"original_project_quality",
	"contribution_quality",
	"ecosystem_impact",
	"community_influence",
	"activity_authenticity",
}

func (o globalOptions) byoKey() (map[string]string, error) {
	if o.ByoBaseURL == "" && o.ByoAPIKey == "" && o.ByoModel == "" {
		return nil, nil
	}
	if o.ByoBaseURL == "" || o.ByoAPIKey == "" || o.ByoModel == "" {
		return nil, fmt.Errorf("incomplete BYO key: need --byo-base-url, --byo-api-key and --byo-model together")
	}
	return map[string]string{"baseURL": o.ByoBaseURL, "apiKey": o.ByoAPIKey, "model": o.ByoModel}, nil
}

func profileLink(host, username string) string {
	return "\n→ " + strings.TrimRight(host, "/") + "/u/" + url.PathEscape(username)
}

func Execute(args []string, stdout io.Writer, stderr io.Writer) int {
	positional, opts, err := parseArgs(args)
	if err != nil {
		return exitError(stderr, err)
	}
	if opts.Version {
		fmt.Fprintln(stdout, VersionString())
		return 0
	}
	if len(positional) == 0 || opts.Help {
		printHelp(stdout)
		return 0
	}

	switch positional[0] {
	case "scan":
		return runScan(positional[1:], opts, stdout, stderr)
	case "score":
		return runScore(positional[1:], opts, stdout, stderr)
	case "roast":
		return runRoast(positional[1:], opts, stdout, stderr)
	case "vs":
		return runVs(positional[1:], opts, stdout, stderr)
	case "exists":
		return runExists(positional[1:], opts, stdout, stderr)
	case "search":
		return runSearch(positional[1:], opts, stdout, stderr)
	case "badge":
		return runBadge(positional[1:], opts, stdout, stderr)
	case "card":
		return runCard(positional[1:], opts, stdout, stderr)
	case "stats":
		return runStats(opts, stdout, stderr)
	case "leaderboard":
		return runLeaderboard(opts, stdout, stderr)
	case "developers":
		return runDevelopers(opts, stdout, stderr)
	case "update":
		if len(positional) > 1 && positional[1] == "check" {
			return runUpdateCheck(opts, stdout, stderr)
		}
		if len(positional) > 1 && positional[1] == "install" {
			return runUpdateInstall(opts, stdout, stderr)
		}
		if len(positional) > 1 && (positional[1] == "npm" || positional[1] == "pip" || positional[1] == "brew") {
			opts.UpdateMethod = positional[1]
			return runUpdateInstall(opts, stdout, stderr)
		}
		return exitError(stderr, fmt.Errorf("unknown update command"))
	case "commands":
		return runCommands(positional[1:], opts, stdout, stderr)
	case "auth":
		if len(positional) > 1 && positional[1] == "status" {
			return runAuthStatus(opts, stdout)
		}
		return exitError(stderr, fmt.Errorf("unknown auth command"))
	default:
		return exitError(stderr, fmt.Errorf("unknown command: %s", positional[0]))
	}
}

func runStats(opts globalOptions, stdout io.Writer, stderr io.Writer) int {
	result, err := NewClient(opts).Stats(context.Background())
	if err != nil {
		return exitError(stderr, err)
	}
	if opts.Output == "json" || opts.Output == "pretty" {
		return writeJSON(stdout, result)
	}
	return exitError(stderr, fmt.Errorf("invalid output format: %s", opts.Output))
}

func runLeaderboard(opts globalOptions, stdout io.Writer, stderr io.Writer) int {
	if !validLeaderboardView(opts.View) {
		return exitError(stderr, fmt.Errorf("invalid leaderboard view: %s", opts.View))
	}
	if !validLeaderboardWindow(opts.Window) {
		return exitError(stderr, fmt.Errorf("invalid leaderboard window: %s", opts.Window))
	}
	result, err := NewClient(opts).Leaderboard(context.Background(), opts.View, opts.Window)
	if err != nil {
		return exitError(stderr, err)
	}
	if opts.Output == "json" {
		return writeJSON(stdout, result)
	}
	if opts.Output != "pretty" {
		return exitError(stderr, fmt.Errorf("invalid output format: %s", opts.Output))
	}
	entries, _ := result["entries"].([]any)
	fmt.Fprintf(stdout, "leaderboard view=%v window=%v entries=%d cached=%v\n",
		result["view"], result["window"], len(entries), result["cached"])
	for i, raw := range entries {
		entry, _ := raw.(map[string]any)
		fmt.Fprintf(stdout, "%d. %v %v/100 %v\n", i+1, entry["username"], entry["final_score"], entry["tier"])
	}
	return 0
}

func runDevelopers(opts globalOptions, stdout io.Writer, stderr io.Writer) int {
	if !validFacetType(opts.FacetType) {
		return exitError(stderr, fmt.Errorf("invalid developers type: %s", opts.FacetType))
	}
	result, err := NewClient(opts).Developers(context.Background(), opts.FacetType, opts.FacetValue)
	if err != nil {
		return exitError(stderr, err)
	}
	if opts.Output == "json" || opts.Output == "pretty" {
		return writeJSON(stdout, result)
	}
	return exitError(stderr, fmt.Errorf("invalid output format: %s", opts.Output))
}

func runUpdateCheck(opts globalOptions, stdout io.Writer, stderr io.Writer) int {
	result, err := CheckUpdate(context.Background(), nil, opts.ReleaseURL)
	if err != nil {
		return exitError(stderr, err)
	}
	if opts.Output == "json" || opts.JSON {
		return writeJSON(stdout, result)
	}
	if opts.Output != "pretty" {
		return exitError(stderr, fmt.Errorf("invalid output format: %s", opts.Output))
	}
	fmt.Fprintln(stdout, formatUpdateInfo(result))
	return 0
}

func runUpdateInstall(opts globalOptions, stdout io.Writer, stderr io.Writer) int {
	result, err := InstallUpdate(context.Background(), nil, UpdateInstallOptions{
		ReleaseURL: opts.ReleaseURL,
		Method:     opts.UpdateMethod,
		TargetPath: opts.TargetPath,
		AssetURL:   opts.AssetURL,
		DryRun:     opts.DryRun,
	})
	if err != nil {
		return exitError(stderr, err)
	}
	if opts.Output == "json" || opts.JSON {
		return writeJSON(stdout, result)
	}
	if opts.Output != "pretty" {
		return exitError(stderr, fmt.Errorf("invalid output format: %s", opts.Output))
	}
	fmt.Fprintln(stdout, formatUpdateInstallResult(result))
	return 0
}

func runRoast(args []string, opts globalOptions, stdout io.Writer, stderr io.Writer) int {
	username, err := usernameArg(args)
	if err != nil {
		return exitError(stderr, err)
	}
	if opts.Lang != "zh" && opts.Lang != "en" {
		return exitError(stderr, fmt.Errorf("invalid language: %s", opts.Lang))
	}
	byoKey, err := opts.byoKey()
	if err != nil {
		return exitError(stderr, err)
	}
	client := NewClient(opts)
	scan, err := client.Scan(context.Background(), username)
	if err != nil {
		return exitError(stderr, err)
	}
	roast, err := client.Roast(context.Background(), scan, opts.Lang, byoKey)
	if err != nil {
		return exitError(stderr, err)
	}
	summary := roastSummary(scan, roast, opts.Lang)
	switch opts.Output {
	case "json":
		return writeJSON(stdout, summary)
	case "markdown":
		fmt.Fprintln(stdout, roast.Report)
		fmt.Fprintln(stdout, profileLink(opts.Host, username))
		return 0
	case "pretty":
		fmt.Fprintf(stdout, "%v: %v/100 %v (%v)\n",
			summary["username"], summary["final_score"], summary["tier"], summary["tier_label"])
		if line := roastLine(summary, opts.Lang); line != "" {
			fmt.Fprintln(stdout, line)
			fmt.Fprintln(stdout)
		}
		fmt.Fprintln(stdout, roast.Report)
		fmt.Fprintln(stdout, profileLink(opts.Host, username))
		return 0
	default:
		return exitError(stderr, fmt.Errorf("invalid output format: %s", opts.Output))
	}
}

func runVs(args []string, opts globalOptions, stdout io.Writer, stderr io.Writer) int {
	if len(args) < 2 || args[0] == "" || args[1] == "" {
		return exitError(stderr, fmt.Errorf("vs needs two usernames"))
	}
	a, b := args[0], args[1]
	result, err := NewClient(opts).Vs(context.Background(), a, b)
	if err != nil {
		return exitError(stderr, err)
	}
	if opts.Output == "json" {
		return writeJSON(stdout, result)
	}
	if opts.Output != "pretty" {
		return exitError(stderr, fmt.Errorf("invalid output format: %s", opts.Output))
	}
	if winner, ok := result["winner"].(string); ok && winner != "" {
		if bucket, ok := result["bucket"].(string); ok && bucket != "" {
			fmt.Fprintf(stdout, "winner: %s (%s)\n", winner, bucket)
		} else {
			fmt.Fprintf(stdout, "winner: %s\n", winner)
		}
	} else if reason, ok := result["reason"].(string); ok && reason != "" {
		fmt.Fprintf(stdout, "result: tie (%s)\n", reason)
	} else {
		fmt.Fprintln(stdout, "result: tie")
	}
	if verdict, ok := result["verdict"].(map[string]any); ok {
		key := "zh"
		if opts.Lang == "en" {
			key = "en"
		}
		if line, ok := verdict[key].(string); ok && line != "" {
			fmt.Fprintln(stdout, line)
		}
	}
	fmt.Fprintf(stdout, "\n→ %s/vs/%s/%s\n", strings.TrimRight(opts.Host, "/"), url.PathEscape(a), url.PathEscape(b))
	return 0
}

func runExists(args []string, opts globalOptions, stdout io.Writer, stderr io.Writer) int {
	username, err := usernameArg(args)
	if err != nil {
		return exitError(stderr, err)
	}
	user, exists, err := NewClient(opts).GitHubUser(context.Background(), username)
	if err != nil {
		return exitError(stderr, err)
	}
	if opts.Output == "json" {
		return writeJSON(stdout, map[string]any{"username": username, "exists": exists, "user": user})
	}
	if opts.Output != "pretty" {
		return exitError(stderr, fmt.Errorf("invalid output format: %s", opts.Output))
	}
	if exists {
		fmt.Fprintf(stdout, "%s: exists\n", username)
	} else {
		fmt.Fprintf(stdout, "%s: does not exist\n", username)
	}
	return 0
}

func runSearch(args []string, opts globalOptions, stdout io.Writer, stderr io.Writer) int {
	q, err := usernameArg(args)
	if err != nil {
		return exitError(stderr, err)
	}
	result, err := NewClient(opts).SearchUsers(context.Background(), q)
	if err != nil {
		return exitError(stderr, err)
	}
	if opts.Output == "json" {
		return writeJSON(stdout, result)
	}
	if opts.Output != "pretty" {
		return exitError(stderr, fmt.Errorf("invalid output format: %s", opts.Output))
	}
	if users, ok := result["users"].([]any); ok {
		for _, raw := range users {
			if u, ok := raw.(map[string]any); ok {
				fmt.Fprintf(stdout, "%v\t%v/100 %v\n", u["username"], u["final_score"], u["tier"])
			}
		}
	}
	return 0
}

func runBadge(args []string, opts globalOptions, stdout io.Writer, stderr io.Writer) int {
	username, err := usernameArg(args)
	if err != nil {
		return exitError(stderr, err)
	}
	host := strings.TrimRight(opts.Host, "/")
	badge := host + "/api/badge/" + url.PathEscape(username)
	if opts.Lang == "en" {
		badge += "?lang=en"
	}
	profile := host + "/u/" + url.PathEscape(username)
	if opts.Markdown {
		fmt.Fprintf(stdout, "[![ghfind score](%s)](%s)\n", badge, profile)
		return 0
	}
	if opts.Output == "json" {
		return writeJSON(stdout, map[string]any{
			"badge_url": badge,
			"card_url":  host + "/api/card/" + url.PathEscape(username),
			"profile":   profile,
		})
	}
	fmt.Fprintln(stdout, badge)
	return 0
}

func runCard(args []string, opts globalOptions, stdout io.Writer, stderr io.Writer) int {
	username, err := usernameArg(args)
	if err != nil {
		return exitError(stderr, err)
	}
	fmt.Fprintln(stdout, strings.TrimRight(opts.Host, "/")+"/api/card/"+url.PathEscape(username))
	return 0
}

func runScan(args []string, opts globalOptions, stdout io.Writer, stderr io.Writer) int {
	username, err := usernameArg(args)
	if err != nil {
		return exitError(stderr, err)
	}
	scan, err := NewClient(opts).Scan(context.Background(), username)
	if err != nil {
		return exitError(stderr, err)
	}
	if opts.Output == "json" || opts.Output == "pretty" {
		return writeJSON(stdout, scan)
	}
	return exitError(stderr, fmt.Errorf("invalid output format: %s", opts.Output))
}

// runScore uses the public GET /api/score endpoint: no auth, cached, rate-limited
// and single-flighted on the server, and it scores never-seen accounts live
// (deterministic, no LLM). This is the cheapest path for both the user and the
// ghfind server — the heavy POST /api/scan is reserved for the `scan` command.
func runScore(args []string, opts globalOptions, stdout io.Writer, stderr io.Writer) int {
	username, err := usernameArg(args)
	if err != nil {
		return exitError(stderr, err)
	}
	payload, err := NewClient(opts).Scored(context.Background(), username)
	if err != nil {
		return exitError(stderr, err)
	}
	if opts.Output == "json" {
		return writeJSON(stdout, payload)
	}
	if opts.Output != "pretty" {
		return exitError(stderr, fmt.Errorf("invalid output format: %s", opts.Output))
	}
	fmt.Fprintf(stdout, "%v: %v/100 %v (%v)\n",
		payload["username"], payload["final_score"], payload["tier"], payload["tier_key"])
	if subScores, ok := payload["sub_scores"].(map[string]any); ok {
		for _, key := range subScoreOrder {
			if value, ok := subScores[key]; ok {
				fmt.Fprintf(stdout, "- %s: %v\n", key, value)
			}
		}
	}
	if flags, ok := payload["red_flags"].([]any); ok {
		for _, raw := range flags {
			if f, ok := raw.(map[string]any); ok {
				fmt.Fprintf(stdout, "- %v: -%v %v\n", f["flag"], f["penalty"], f["detail"])
			}
		}
	}
	if pct, ok := payload["percentile"].(map[string]any); ok {
		if beat, ok := pct["beat"]; ok && beat != nil {
			fmt.Fprintf(stdout, "beats %v%% of %v scored accounts\n", beat, pct["total"])
		}
	}
	fmt.Fprintln(stdout, profileLink(opts.Host, fmt.Sprintf("%v", payload["username"])))
	return 0
}

func parseArgs(args []string) ([]string, globalOptions, error) {
	opts := globalOptions{
		Host:           envFirst([]string{"GHFIND_HOST", "GITHUB_ROAST_HOST"}, DefaultHost),
		APIKey:         envFirst([]string{"GHFIND_API_KEY", "GITHUB_ROAST_API_KEY"}, ""),
		TurnstileToken: envFirst([]string{"GHFIND_TURNSTILE_TOKEN", "GITHUB_ROAST_TURNSTILE_TOKEN"}, ""),
		GitHubToken:    envFirst([]string{"GITHUB_TOKEN"}, ""),
		ReleaseURL:     envFirst([]string{"GHFIND_RELEASE_URL"}, DefaultReleaseURL),
		ByoBaseURL:     envFirst([]string{"GHFIND_BYO_BASE_URL"}, ""),
		ByoAPIKey:      envFirst([]string{"GHFIND_BYO_API_KEY"}, ""),
		ByoModel:       envFirst([]string{"GHFIND_BYO_MODEL"}, ""),
		Output:         "pretty",
		Lang:           "zh",
	}
	var positional []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch arg {
		case "--version", "version":
			opts.Version = true
		case "--json":
			opts.JSON = true
			opts.Output = "json"
		case "--markdown", "--md":
			opts.Markdown = true
		case "-h", "--help":
			opts.Help = true
		case "-o", "--output":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.Output = args[i]
		case "--host":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.Host = args[i]
		case "--api-key":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.APIKey = args[i]
		case "--turnstile-token":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.TurnstileToken = args[i]
		case "--github-token":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.GitHubToken = args[i]
		case "--byo-base-url":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.ByoBaseURL = args[i]
		case "--byo-api-key":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.ByoAPIKey = args[i]
		case "--byo-model":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.ByoModel = args[i]
		case "--lang":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.Lang = args[i]
		case "--view":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.View = args[i]
		case "--window":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.Window = args[i]
		case "--type":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.FacetType = args[i]
		case "--value":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.FacetValue = args[i]
		case "--release-url":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.ReleaseURL = args[i]
		case "--method":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.UpdateMethod = args[i]
		case "--target":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.TargetPath = args[i]
		case "--asset-url":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.AssetURL = args[i]
		case "--dry-run":
			opts.DryRun = true
		default:
			positional = append(positional, arg)
		}
	}
	opts.Host = strings.TrimRight(opts.Host, "/")
	return positional, opts, nil
}

func runCommands(args []string, opts globalOptions, stdout io.Writer, stderr io.Writer) int {
	if len(args) > 0 && args[0] == "show" {
		if len(args) < 2 {
			return exitError(stderr, fmt.Errorf("missing command name"))
		}
		name := strings.ReplaceAll(strings.Join(args[1:], " "), "-", " ")
		cmd, ok := findCommand(name)
		if !ok {
			return exitError(stderr, fmt.Errorf("unknown command: %s", name))
		}
		if opts.JSON {
			return writeJSON(stdout, cmd)
		}
		fmt.Fprintf(stdout, "%s\nusage: %s\n%s\n", cmd.Name, cmd.Usage, cmd.Summary)
		return 0
	}

	payload := struct {
		DefaultHost string        `json:"default_host"`
		Commands    []CommandInfo `json:"commands"`
	}{DefaultHost: DefaultHost, Commands: commandCatalog}
	if opts.JSON {
		return writeJSON(stdout, payload)
	}
	for _, cmd := range commandCatalog {
		fmt.Fprintf(stdout, "%s\t%s\n", cmd.Name, cmd.Summary)
	}
	return 0
}

func runAuthStatus(opts globalOptions, stdout io.Writer) int {
	payload := map[string]any{
		"host":                opts.Host,
		"default_host":        DefaultHost,
		"has_api_key":         opts.APIKey != "",
		"has_turnstile_token": opts.TurnstileToken != "",
		"env": map[string]any{
			"primary":    []string{"GHFIND_HOST", "GHFIND_API_KEY", "GHFIND_TURNSTILE_TOKEN"},
			"compatible": []string{"GITHUB_ROAST_HOST", "GITHUB_ROAST_API_KEY", "GITHUB_ROAST_TURNSTILE_TOKEN"},
		},
	}
	if opts.Output == "json" {
		return writeJSON(stdout, payload)
	}
	fmt.Fprintf(stdout, "host: %s\n", payload["host"])
	fmt.Fprintf(stdout, "api key: %s\n", configured(payload["has_api_key"].(bool)))
	fmt.Fprintf(stdout, "turnstile token: %s\n", configured(payload["has_turnstile_token"].(bool)))
	return 0
}

func printHelp(stdout io.Writer) {
	fmt.Fprintln(stdout, "ghfind CLI")
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Remote CLI for the ghfind.com GitHub Roast website APIs.")
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Commands:")
	for _, cmd := range commandCatalog {
		fmt.Fprintf(stdout, "  %s\t%s\n", cmd.Name, cmd.Summary)
	}
}

func writeJSON(stdout io.Writer, v any) int {
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return 1
	}
	return 0
}

func exitError(stderr io.Writer, err error) int {
	fmt.Fprintln(stderr, err.Error())
	return 1
}

func usernameArg(args []string) (string, error) {
	if len(args) == 0 || args[0] == "" {
		return "", fmt.Errorf("missing username")
	}
	return args[0], nil
}

func roastSummary(scan map[string]any, roast RoastResult, lang string) map[string]any {
	metrics, _ := scan["metrics"].(map[string]any)
	return map[string]any{
		"username":    metrics["username"],
		"lang":        lang,
		"final_score": roast.Meta["final_score"],
		"tier":        roast.Meta["tier"],
		"tier_label":  roast.Meta["tier_label"],
		"delta":       roast.Meta["delta"],
		"percentile":  roast.Meta["percentile"],
		"tags":        roast.Meta["tags"],
		"roast_line":  roast.Meta["roast_line"],
		"report":      roast.Report,
		"scan":        scan,
	}
}

func roastLine(summary map[string]any, lang string) string {
	lines, ok := summary["roast_line"].(map[string]any)
	if !ok {
		return ""
	}
	if value, ok := lines[lang].(string); ok && value != "" {
		return value
	}
	if value, ok := lines["zh"].(string); ok && value != "" {
		return value
	}
	if value, ok := lines["en"].(string); ok && value != "" {
		return value
	}
	return ""
}

func envFirst(keys []string, fallback string) string {
	for _, key := range keys {
		if value := os.Getenv(key); value != "" {
			return value
		}
	}
	return fallback
}

func configured(ok bool) string {
	if ok {
		return "configured"
	}
	return "missing"
}

func validLeaderboardView(view string) bool {
	return view == "" || view == "trending" || view == "score" || view == "heat" || view == "progress"
}

func validLeaderboardWindow(window string) bool {
	return window == "" || window == "all" || window == "24h" || window == "7d" || window == "30d"
}

func validFacetType(facetType string) bool {
	return facetType == "language" || facetType == "org" || facetType == "repo"
}
