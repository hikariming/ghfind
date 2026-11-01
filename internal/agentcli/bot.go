package agentcli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// `ghfind bot` manages the ghfind Review GitHub App on repositories the caller
// administers, through the bot's JSON API (https://bot.ghfind.com/api/v1).
// It authenticates with a personal API token (GHFIND_API_KEY) with the bot
// permission explicitly selected when creating the token;
// the bot checks the caller's current GitHub repository permission on every
// request. Cleanup is two-step: a preview returns a confirm token, and only
// `bot cleanup confirm` executes it.

const DefaultBotHost = "https://bot.ghfind.com"
const botTokenMessage = `bot commands need a personal API token with the bot permission: create a new token with "Manage the ghfind Review bot" at https://ghfind.com/integrations and set GHFIND_API_KEY`

var (
	repoPattern    = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	cleanupPattern = regexp.MustCompile(`^[0-9a-f-]{36}$`)
	confirmPattern = regexp.MustCompile(`^([0-9a-f-]{36})\.`)
	botPoll        = 2 * time.Second
)

const (
	botPlanWait = 2 * time.Minute
	botRunWait  = 10 * time.Minute
)

type botArgs struct {
	rest []string
	opts map[string]string
}

// parseBotArgs reads bot-specific options from the positionals the global
// parser left behind.
func parseBotArgs(args []string) (botArgs, error) {
	values := map[string]bool{
		"--bot-host": true, "--issues": true, "--prs": true, "--comments-enabled": true,
		"--triage": true, "--prompt": true, "--allowed-labels": true, "--labels": true,
		"-n": true, "--limit": true,
	}
	booleans := map[string]bool{"--comments": true, "--delete-label-definitions": true, "--no-wait": true, "--wait": true}
	out := botArgs{opts: map[string]string{}}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case values[arg]:
			i++
			if i >= len(args) {
				return out, fmt.Errorf("%s requires a value", arg)
			}
			if arg == "-n" {
				arg = "--limit"
			}
			out.opts[arg] = args[i]
		case booleans[arg]:
			out.opts[arg] = "true"
		case strings.HasPrefix(arg, "-"):
			return out, fmt.Errorf("unknown bot option: %s", arg)
		default:
			out.rest = append(out.rest, arg)
		}
	}
	return out, nil
}

type botClient struct {
	host   string
	apiKey string
	http   HTTPDoer
}

func (b botClient) request(ctx context.Context, method string, path string, body any) (map[string]any, error) {
	if !strings.HasPrefix(b.apiKey, "ghf_") {
		return nil, APIError{Code: "personal_token_required", Body: botTokenMessage}
	}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, b.host+"/api/v1"+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+b.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := b.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, readAPIError(res)
	}
	out := map[string]any{}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil && err != io.EOF {
		return nil, err
	}
	return out, nil
}

// waitCleanup polls until the cleanup leaves one of states or limit passes.
func (b botClient) waitCleanup(ctx context.Context, repo, id string, states []string, limit time.Duration) (map[string]any, error) {
	started := time.Now()
	var last map[string]any
	for {
		view, err := b.request(ctx, http.MethodGet, "/repos/"+repo+"/cleanups/"+id, nil)
		if err != nil {
			// The cleanup keeps running on the server; a busy GitHub quota or
			// our own rate limit only means "ask again later".
			apiErr, ok := err.(APIError)
			if !ok || (apiErr.Status != 503 && apiErr.Status != 429) {
				return nil, err
			}
			if time.Since(started) >= limit {
				if last != nil {
					return last, nil
				}
				return nil, err
			}
			time.Sleep(botPoll * 5)
			continue
		}
		last = view
		cleanup, _ := view["cleanup"].(map[string]any)
		state, _ := cleanup["state"].(string)
		waiting := false
		for _, s := range states {
			waiting = waiting || s == state
		}
		if !waiting || time.Since(started) >= limit {
			return view, nil
		}
		time.Sleep(botPoll)
	}
}

// botHost refuses to send the token anywhere but HTTPS, or plain HTTP on localhost.
func botHost(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("invalid bot host: %s", raw)
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return "", fmt.Errorf("bot host must use https (plain http only for localhost)")
	}
	return strings.TrimRight(u.Scheme+"://"+u.Host+u.Path, "/"), nil
}

func repoArg(args []string, at int) (string, error) {
	if at >= len(args) || !repoPattern.MatchString(args[at]) {
		return "", fmt.Errorf("expected a repository as owner/name")
	}
	return args[at], nil
}

func toggle(value string, name string) (bool, error) {
	switch value {
	case "on", "true":
		return true, nil
	case "off", "false":
		return false, nil
	}
	return false, fmt.Errorf("%s expects on or off", name)
}

func printCleanup(stdout io.Writer, payload map[string]any) {
	c, ok := payload["cleanup"].(map[string]any)
	if !ok {
		c = payload
	}
	s, _ := c["summary"].(map[string]any)
	num := func(key string) any {
		if v, ok := s[key]; ok {
			return v
		}
		return 0
	}
	fmt.Fprintf(stdout, "cleanup %v: %v\n", c["id"], c["state"])
	truncated := ""
	if s["truncated"] == true {
		truncated = " (truncated: run again afterwards)"
	}
	fmt.Fprintf(stdout, "  review: labels %v, intent labels %v, comments %v, label definitions %v%s\n",
		num("review_labels"), num("triage_labels"), num("comments"), num("label_definitions"), truncated)
	if c["state"] == "running" || c["state"] == "done" {
		fmt.Fprintf(stdout, "  progress: %v removed, %v skipped (preserved or already absent), of %v\n", c["done"], c["skipped"], c["total"])
	}
	if s["bot_active"] == true {
		fmt.Fprintln(stdout, "  warning: score labels are still on; run `ghfind bot pause` first or new items get labelled again")
	}
	if result, ok := c["result"].(string); ok && result != "" {
		fmt.Fprintf(stdout, "  result: %s\n", result)
	}
}

func runBot(args []string, opts globalOptions, stdout io.Writer, stderr io.Writer) int {
	parsed, err := parseBotArgs(args)
	if err != nil {
		return exitError(stderr, err)
	}
	host := opts.BotHost
	if value, ok := parsed.opts["--bot-host"]; ok {
		host = value
	}
	host, err = botHost(host)
	if err != nil {
		return exitError(stderr, err)
	}
	client := NewClient(opts)
	bot := botClient{host: host, apiKey: opts.APIKey, http: client.http()}
	ctx := context.Background()
	rest := parsed.rest
	jsonOut := opts.Output == "json"
	emit := func(v map[string]any, err error) int {
		if err != nil {
			return botError(stderr, err)
		}
		return writeJSON(stdout, v)
	}
	if len(rest) == 0 {
		return exitError(stderr, fmt.Errorf("usage: ghfind bot <status|settings|pause|resume|backfill|retry|cleanup|whoami> ..."))
	}
	switch rest[0] {
	case "whoami":
		return emit(bot.request(ctx, http.MethodGet, "/whoami", nil))
	case "status":
		repo, err := repoArg(rest, 1)
		if err != nil {
			return exitError(stderr, err)
		}
		status, err := bot.request(ctx, http.MethodGet, "/repos/"+repo, nil)
		if err != nil || jsonOut {
			return emit(status, err)
		}
		s, _ := status["settings"].(map[string]any)
		jobs, _ := status["jobs"].(map[string]any)
		viewer, _ := status["viewer"].(map[string]any)
		role := "read only"
		if viewer["admin"] == true {
			role = "admin"
		}
		onOff := func(v any) string {
			if v == true {
				return "on"
			}
			return "off"
		}
		llm := ""
		if status["llm_configured"] != true {
			llm = " (LLM not configured)"
		}
		fmt.Fprintf(stdout, "%s (you: %v, %s)\n", repo, viewer["login"], role)
		fmt.Fprintf(stdout, "  issues %s, PRs %s, comments %s, intent labels %s%s\n",
			onOff(s["issues_enabled"]), onOff(s["prs_enabled"]), onOff(s["comments_enabled"]), onOff(s["triage_enabled"]), llm)
		fmt.Fprintf(stdout, "  failed jobs: %v\n", jobs["failed"])
		if cleanup, ok := status["cleanup"].(map[string]any); ok {
			printCleanup(stdout, cleanup)
		}
		return 0
	case "settings":
		if len(rest) < 2 || (rest[1] != "get" && rest[1] != "set") {
			return exitError(stderr, fmt.Errorf("usage: ghfind bot settings get|set <owner/repo>"))
		}
		repo, err := repoArg(rest, 2)
		if err != nil {
			return exitError(stderr, err)
		}
		if rest[1] == "get" {
			return emit(bot.request(ctx, http.MethodGet, "/repos/"+repo+"/settings", nil))
		}
		patch := map[string]any{}
		for _, pair := range [][2]string{{"--issues", "issues_enabled"}, {"--prs", "prs_enabled"}, {"--comments-enabled", "comments_enabled"}, {"--triage", "triage_enabled"}} {
			if value, ok := parsed.opts[pair[0]]; ok {
				on, err := toggle(value, pair[0])
				if err != nil {
					return exitError(stderr, err)
				}
				patch[pair[1]] = on
			}
		}
		if value, ok := parsed.opts["--prompt"]; ok {
			patch["comment_prompt"] = value
		}
		if value, ok := parsed.opts["--allowed-labels"]; ok {
			labels := []string{}
			for _, name := range strings.Split(value, ",") {
				if name = strings.TrimSpace(name); name != "" {
					labels = append(labels, name)
				}
			}
			patch["allowed_labels"] = labels
		}
		if len(patch) == 0 {
			return exitError(stderr, fmt.Errorf("nothing to set; see: ghfind commands show bot settings set"))
		}
		return emit(bot.request(ctx, http.MethodPatch, "/repos/"+repo+"/settings", patch))
	case "pause", "resume":
		repo, err := repoArg(rest, 1)
		if err != nil {
			return exitError(stderr, err)
		}
		return emit(bot.request(ctx, http.MethodPost, "/repos/"+repo+"/"+rest[0], nil))
	case "backfill":
		repo, err := repoArg(rest, 1)
		if err != nil {
			return exitError(stderr, err)
		}
		limit := 25
		if value, ok := parsed.opts["--limit"]; ok {
			limit, err = strconv.Atoi(value)
			if err != nil || limit < 1 || limit > 100 {
				return exitError(stderr, fmt.Errorf("--limit must be 1-100"))
			}
		}
		return emit(bot.request(ctx, http.MethodPost, "/repos/"+repo+"/backfill", map[string]any{"limit": limit}))
	case "retry":
		repo, err := repoArg(rest, 1)
		if err != nil {
			return exitError(stderr, err)
		}
		body := map[string]any{}
		if len(rest) > 2 {
			body["job_id"] = rest[2]
		}
		return emit(bot.request(ctx, http.MethodPost, "/repos/"+repo+"/retry", body))
	case "cleanup":
		return runBotCleanup(ctx, bot, rest[1:], parsed.opts, jsonOut, stdout, stderr)
	}
	return exitError(stderr, fmt.Errorf("unknown bot command: %s", rest[0]))
}

func runBotCleanup(ctx context.Context, bot botClient, rest []string, opts map[string]string, jsonOut bool, stdout io.Writer, stderr io.Writer) int {
	show := func(view map[string]any, err error) int {
		if err != nil {
			return botError(stderr, err)
		}
		if jsonOut {
			return writeJSON(stdout, view)
		}
		printCleanup(stdout, view)
		return 0
	}
	if len(rest) > 0 && rest[0] == "confirm" {
		repo, err := repoArg(rest, 1)
		if err != nil {
			return exitError(stderr, err)
		}
		var id string
		if len(rest) > 2 {
			if m := confirmPattern.FindStringSubmatch(rest[2]); m != nil {
				id = m[1]
			}
		}
		if id == "" {
			return exitError(stderr, fmt.Errorf("usage: ghfind bot cleanup confirm <owner/repo> <confirm-token>"))
		}
		view, err := bot.request(ctx, http.MethodPost, "/repos/"+repo+"/cleanups/"+id+"/confirm", map[string]any{"token": rest[2]})
		if err == nil && opts["--wait"] == "true" {
			view, err = bot.waitCleanup(ctx, repo, id, []string{"running"}, botRunWait)
		}
		return show(view, err)
	}
	if len(rest) > 0 && (rest[0] == "status" || rest[0] == "cancel") {
		repo, err := repoArg(rest, 1)
		if err != nil {
			return exitError(stderr, err)
		}
		if len(rest) < 3 || !cleanupPattern.MatchString(rest[2]) {
			return exitError(stderr, fmt.Errorf("usage: ghfind bot cleanup %s <owner/repo> <cleanup-id>", rest[0]))
		}
		path := "/repos/" + repo + "/cleanups/" + rest[2]
		if rest[0] == "status" {
			return show(bot.request(ctx, http.MethodGet, path, nil))
		}
		return show(bot.request(ctx, http.MethodPost, path+"/cancel", nil))
	}
	repo, err := repoArg(rest, 0)
	if err != nil {
		return exitError(stderr, err)
	}
	labels := opts["--labels"]
	if labels == "" {
		labels = "none"
	}
	created, err := bot.request(ctx, http.MethodPost, "/repos/"+repo+"/cleanups", map[string]any{
		"labels":                   labels,
		"comments":                 opts["--comments"] == "true",
		"delete_label_definitions": opts["--delete-label-definitions"] == "true",
	})
	if err != nil {
		return botError(stderr, err)
	}
	token, _ := created["confirm_token"].(string)
	cleanup, _ := created["cleanup"].(map[string]any)
	id, _ := cleanup["id"].(string)
	view := created
	if opts["--no-wait"] != "true" {
		if view, err = bot.waitCleanup(ctx, repo, id, []string{"planning"}, botPlanWait); err != nil {
			return botError(stderr, err)
		}
	}
	next := "ghfind bot cleanup confirm " + repo + " " + token
	view["confirm_token"] = token
	view["next"] = next
	if jsonOut {
		return writeJSON(stdout, view)
	}
	printCleanup(stdout, view)
	c, _ := view["cleanup"].(map[string]any)
	switch c["state"] {
	case "planned":
		fmt.Fprintln(stdout, "Nothing has been changed. To execute this plan within 10 minutes, run:")
		fmt.Fprintf(stdout, "  %s\n", next)
	case "planning":
		fmt.Fprintf(stdout, "Still previewing. Check with: ghfind bot cleanup status %s %s\n", repo, id)
	default:
		fmt.Fprintln(stdout, "Nothing has been changed.")
	}
	return 0
}

func botError(stderr io.Writer, err error) int {
	if apiErr, ok := err.(APIError); ok && (apiErr.Code == "personal_token_required" || apiErr.Code == "token_scope_required") {
		fmt.Fprintf(stderr, "%s (%s)\n", botTokenMessage, apiErr.Code)
		return 1
	}
	if apiErr, ok := err.(APIError); ok && apiErr.Status != 0 {
		fmt.Fprintf(stderr, "bot API request failed with HTTP %d (%s)\n", apiErr.Status, apiErr.Code)
		return 1
	}
	return exitError(stderr, err)
}
