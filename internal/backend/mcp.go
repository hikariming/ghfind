package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"
)

// The former mcp-handler dependency uses a stateless Streamable HTTP transport:
// every POST gets one SSE JSON-RPC message and no MCP session ID is issued.
// Keep that shape so existing clients can change only the backend origin.
const (
	mcpProtocolVersion = "2025-11-25"
	mcpServerName      = "ghfind"
	mcpServerVersion   = "1.0.0"
)

var mcpSupportedProtocolVersions = map[string]bool{
	"2025-11-25": true,
	"2025-06-18": true,
	"2025-03-26": true,
	"2024-11-05": true,
	"2024-10-07": true,
}

const mcpInstructions = "ghfind scores any GitHub account 0-100 for real contribution value and trustworthiness " +
	"with a deterministic engine — no LLM touches the number, same inputs always give the same score. " +
	"Use score_user for one account's score/tier, scan_user for the full evidence payload " +
	"(metrics, repos, PRs, red flags), compare_users for a head-to-head verdict, and " +
	"get_leaderboard / search_users for discovery only — they are ranked snapshots, not fresh " +
	"per-user evidence. All tools are read-only and rate limited per IP. Do not treat a low " +
	"score as a factual claim about a person: scores use public signals only, so private-org " +
	"work is invisible to them."

type mcpRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type mcpResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *mcpRPCError    `json:"error,omitempty"`
}

type mcpRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type mcpToolCall struct {
	Name      string                     `json:"name"`
	Arguments map[string]json.RawMessage `json:"arguments"`
}

type mcpToolError struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

func mcpJSONError(id json.RawMessage, code int, message string) mcpResponse {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	return mcpResponse{JSONRPC: "2.0", ID: id, Error: &mcpRPCError{Code: code, Message: message}}
}

func mcpJSONResult(id json.RawMessage, result any) mcpResponse {
	return mcpResponse{JSONRPC: "2.0", ID: id, Result: result}
}

func mcpHasID(request mcpRequest) bool { return len(request.ID) > 0 }

// mcp is a small, deliberately stateless Streamable HTTP implementation. The
// old Next adapter disabled its legacy GET/SSE endpoint, but its POST transport
// still emits response messages as SSE. Do the same rather than silently
// switching existing agent clients to a different wire format.
func (s *APIServer) mcp(w http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		mcpWriteJSON(w, http.StatusMethodNotAllowed, mcpJSONError(nil, -32000, "Method not allowed."))
		return
	}
	accept := request.Header.Get("Accept")
	if !strings.Contains(accept, "application/json") || !strings.Contains(accept, "text/event-stream") {
		mcpWriteJSON(w, http.StatusNotAcceptable, mcpJSONError(nil, -32000, "Not Acceptable: Client must accept both application/json and text/event-stream"))
		return
	}
	if version := request.Header.Get("Mcp-Protocol-Version"); version != "" && !mcpSupportedProtocolVersions[version] {
		mcpWriteJSON(w, http.StatusBadRequest, mcpJSONError(nil, -32000, "Bad Request: Unsupported protocol version: "+version))
		return
	}

	body, err := io.ReadAll(io.LimitReader(request.Body, 1<<20))
	if err != nil {
		mcpWriteJSON(w, http.StatusBadRequest, mcpJSONError(nil, -32700, "Parse error: Invalid JSON"))
		return
	}
	var raw json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil || len(raw) == 0 {
		mcpWriteJSON(w, http.StatusBadRequest, mcpJSONError(nil, -32700, "Parse error: Invalid JSON"))
		return
	}
	if len(raw) > 0 && raw[0] == '[' {
		var batch []json.RawMessage
		if err := json.Unmarshal(raw, &batch); err != nil || len(batch) == 0 {
			mcpWriteJSON(w, http.StatusBadRequest, mcpJSONError(nil, -32700, "Parse error: Invalid JSON-RPC message"))
			return
		}
		responses := make([]mcpResponse, 0, len(batch))
		for _, item := range batch {
			response, notification := s.mcpHandleMessage(request.Context(), request, item)
			if !notification {
				responses = append(responses, response)
			}
		}
		if len(responses) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		mcpWriteSSE(w, responses)
		return
	}
	response, notification := s.mcpHandleMessage(request.Context(), request, raw)
	if notification {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	mcpWriteSSE(w, response)
}

func (s *APIServer) mcpHandleMessage(ctx context.Context, request *http.Request, raw json.RawMessage) (mcpResponse, bool) {
	var message mcpRequest
	if err := json.Unmarshal(raw, &message); err != nil || message.JSONRPC != "2.0" || strings.TrimSpace(message.Method) == "" {
		return mcpJSONError(nil, -32600, "Invalid Request"), false
	}
	if !mcpHasID(message) {
		// This mirrors mcp-handler's stateless transport: notifications are
		// processed without a response. The server has no notification-side
		// effects, so a 202 is sufficient.
		return mcpResponse{}, true
	}
	switch message.Method {
	case "initialize":
		return mcpJSONResult(message.ID, s.mcpInitialize(message.Params)), false
	case "ping":
		return mcpJSONResult(message.ID, map[string]any{}), false
	case "tools/list":
		return mcpJSONResult(message.ID, map[string]any{"tools": mcpTools()}), false
	case "tools/call":
		result, rpcErr := s.mcpCallTool(ctx, request, message.Params)
		if rpcErr != nil {
			return mcpJSONError(message.ID, rpcErr.Code, rpcErr.Message), false
		}
		return mcpJSONResult(message.ID, result), false
	default:
		return mcpJSONError(message.ID, -32601, "Method not found"), false
	}
}

func (s *APIServer) mcpInitialize(raw json.RawMessage) map[string]any {
	var input struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal(raw, &input)
	version := mcpProtocolVersion
	if mcpSupportedProtocolVersions[input.ProtocolVersion] {
		version = input.ProtocolVersion
	}
	return map[string]any{
		"protocolVersion": version,
		"capabilities":    map[string]any{"tools": map[string]any{}},
		"serverInfo":      map[string]string{"name": mcpServerName, "version": mcpServerVersion},
		"instructions":    mcpInstructions,
	}
}

func mcpTools() []map[string]any {
	liveReadOnly := map[string]bool{"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true}
	cachedReadOnly := map[string]bool{"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
	stringInput := func(properties map[string]any, required ...string) map[string]any {
		return map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}
	}
	return []map[string]any{
		{
			"name": "score_user", "title": "Score a GitHub account",
			"description": "Deterministic 0-100 value & trust score, tier, and six-dimension breakdown for any GitHub login. No LLM, no auth. Unseen accounts are admitted to the Go quick-scan worker path.",
			"inputSchema": stringInput(map[string]any{"username": map[string]string{"type": "string", "description": "GitHub login (case-insensitive)"}}, "username"),
			"annotations": liveReadOnly,
		},
		{
			"name": "scan_user", "title": "Full scan payload",
			"description": "Crawl a GitHub account and return the full deterministic scan: raw metrics, top repos, recent PRs, red flags, and sub-scores.",
			"inputSchema": stringInput(map[string]any{"username": map[string]string{"type": "string", "description": "GitHub login"}}, "username"),
			"annotations": liveReadOnly,
		},
		{
			"name": "compare_users", "title": "Compare two developers",
			"description": "Head-to-head deterministic comparison of two GitHub accounts, with the winner and score gap. No LLM.",
			"inputSchema": stringInput(map[string]any{
				"a": map[string]string{"type": "string", "description": "First GitHub login"},
				"b": map[string]string{"type": "string", "description": "Second GitHub login"},
			}, "a", "b"),
			"annotations": liveReadOnly,
		},
		{
			"name": "get_leaderboard", "title": "Developer leaderboard",
			"description": "Ranked public developers. Use for discovery, not as fresh per-user scoring evidence.",
			"inputSchema": stringInput(map[string]any{
				"view":   map[string]any{"type": "string", "enum": []string{"trending", "score", "heat", "progress"}, "default": "trending", "description": "Ranking view"},
				"window": map[string]any{"type": "string", "enum": []string{"all", "24h", "7d", "30d"}, "default": "all", "description": "Time window"},
				"limit":  map[string]any{"type": "integer", "minimum": 1, "maximum": 100, "default": 50, "description": "Max entries to return (default 50)"},
			}),
			"annotations": cachedReadOnly,
		},
		{
			"name": "search_users", "title": "Search scored developers",
			"description": "Prefix search across already-scored GitHub accounts (up to 6 matches).",
			"inputSchema": stringInput(map[string]any{"q": map[string]string{"type": "string", "description": "Username prefix"}}, "q"),
			"annotations": cachedReadOnly,
		},
	}
}

func (s *APIServer) mcpCallTool(ctx context.Context, request *http.Request, raw json.RawMessage) (map[string]any, *mcpRPCError) {
	var call mcpToolCall
	if err := json.Unmarshal(raw, &call); err != nil || call.Name == "" {
		return nil, &mcpRPCError{Code: -32602, Message: "Invalid params"}
	}
	if !mcpKnownTool(call.Name) {
		return nil, &mcpRPCError{Code: -32602, Message: "Unknown tool: " + call.Name}
	}
	if err := mcpValidateArguments(call.Name, call.Arguments); err != nil {
		return nil, &mcpRPCError{Code: -32602, Message: "Invalid params"}
	}
	if s.mcpLimiter == nil {
		return mcpToolFailure("rate_limit_unavailable: request protection is temporarily unavailable; retry in 15 seconds"), nil
	}
	limit, err := s.mcpLimiter.LimitMCP(ctx, s.clientPrincipal(request), s.clock().UTC())
	if err != nil || limit.Unavailable {
		return mcpToolFailure("rate_limit_unavailable: request protection is temporarily unavailable; retry in 15 seconds"), nil
	}
	if !limit.Success {
		return mcpToolFailure("rate_limited: too many requests, slow down and retry in a minute"), nil
	}

	var data any
	switch call.Name {
	case "score_user":
		data = s.mcpScoreUser(ctx, mcpArgumentString(call.Arguments, "username"))
	case "scan_user":
		data = s.mcpScanUser(ctx, mcpArgumentString(call.Arguments, "username"))
	case "compare_users":
		data = s.mcpCompareUsers(ctx, mcpArgumentString(call.Arguments, "a"), mcpArgumentString(call.Arguments, "b"))
	case "get_leaderboard":
		data = s.mcpLeaderboard(ctx, mcpArgumentStringDefault(call.Arguments, "view", "trending"), mcpArgumentStringDefault(call.Arguments, "window", "all"), mcpArgumentIntDefault(call.Arguments, "limit", 50))
	case "search_users":
		data = s.mcpSearchUsers(ctx, mcpArgumentString(call.Arguments, "q"))
	}
	encoded, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return nil, &mcpRPCError{Code: -32603, Message: "Internal error"}
	}
	return map[string]any{"content": []map[string]string{{"type": "text", "text": string(encoded)}}}, nil
}

func mcpKnownTool(name string) bool {
	switch name {
	case "score_user", "scan_user", "compare_users", "get_leaderboard", "search_users":
		return true
	default:
		return false
	}
}

func mcpValidateArguments(name string, arguments map[string]json.RawMessage) error {
	stringArgument := func(key string) error {
		if arguments == nil {
			return errors.New("missing arguments")
		}
		var value string
		if raw, ok := arguments[key]; !ok || json.Unmarshal(raw, &value) != nil {
			return errors.New("invalid string")
		}
		return nil
	}
	switch name {
	case "score_user", "scan_user":
		return stringArgument("username")
	case "compare_users":
		if err := stringArgument("a"); err != nil {
			return err
		}
		return stringArgument("b")
	case "search_users":
		return stringArgument("q")
	case "get_leaderboard":
		if arguments == nil {
			return nil
		}
		if raw, ok := arguments["view"]; ok {
			var value string
			if json.Unmarshal(raw, &value) != nil || !validLeaderboardView(value) {
				return errors.New("invalid view")
			}
		}
		if raw, ok := arguments["window"]; ok {
			var value string
			if json.Unmarshal(raw, &value) != nil || !validLeaderboardWindow(value) {
				return errors.New("invalid window")
			}
		}
		if raw, ok := arguments["limit"]; ok {
			var value int
			if json.Unmarshal(raw, &value) != nil || value < 1 || value > 100 {
				return errors.New("invalid limit")
			}
		}
	}
	return nil
}

func mcpArgumentString(arguments map[string]json.RawMessage, key string) string {
	var value string
	_ = json.Unmarshal(arguments[key], &value)
	return value
}

func mcpArgumentStringDefault(arguments map[string]json.RawMessage, key, fallback string) string {
	if arguments == nil {
		return fallback
	}
	if raw, ok := arguments[key]; ok {
		var value string
		if json.Unmarshal(raw, &value) == nil {
			return value
		}
	}
	return fallback
}

func mcpArgumentIntDefault(arguments map[string]json.RawMessage, key string, fallback int) int {
	if arguments == nil {
		return fallback
	}
	if raw, ok := arguments[key]; ok {
		var value int
		if json.Unmarshal(raw, &value) == nil {
			return value
		}
	}
	return fallback
}

func mcpToolFailure(message string) map[string]any {
	return map[string]any{"content": []map[string]string{{"type": "text", "text": message}}, "isError": true}
}

func (s *APIServer) mcpScoreUser(ctx context.Context, rawUsername string) any {
	username := normalizeGitHubUsername(rawUsername)
	if username == "" {
		return mcpToolError{Error: "invalid_username", Message: "username must be a valid GitHub login"}
	}
	if s.scoreReads == nil {
		return mcpToolError{Error: "scan_failed", Message: "could not score " + username}
	}
	detail, err := s.scoreReads.GetStoredScore(ctx, username)
	if err != nil {
		return mcpToolError{Error: "scan_failed", Message: "could not score " + username}
	}
	if detail != nil && detail.ScoreVersion == canonicalScoreVersion && detail.CollectionVersion == goCanonicalCollectionVersion && canonicalSnapshotHashPattern.MatchString(detail.SnapshotHash) {
		return s.mcpStoredScorePayload(ctx, *detail, "indexed", true)
	}
	scan, err := s.mcpQuickScan(ctx, username)
	if err == nil {
		return s.mcpLiveScorePayload(ctx, *scan)
	}
	if detail != nil && detail.LegacyFallback {
		return s.mcpStoredScorePayload(ctx, *detail, "legacy_v5_v5_v3", false)
	}
	return mcpToolError{Error: mcpScanErrorCode(err), Message: "could not score " + username}
}

func (s *APIServer) mcpScanUser(ctx context.Context, rawUsername string) any {
	username := normalizeGitHubUsername(rawUsername)
	if username == "" {
		return mcpToolError{Error: "invalid_username", Message: "username must be a valid GitHub login"}
	}
	scan, err := s.mcpQuickScan(ctx, username)
	if err != nil {
		return mcpToolError{Error: mcpScanErrorCode(err), Message: "could not scan " + username}
	}
	return scan
}

func (s *APIServer) mcpCompareUsers(ctx context.Context, rawA, rawB string) any {
	a := s.mcpScoreUser(ctx, rawA)
	if result, failed := a.(mcpToolError); failed {
		return result
	}
	b := s.mcpScoreUser(ctx, rawB)
	if result, failed := b.(mcpToolError); failed {
		return result
	}
	aPayload, aOK := a.(map[string]any)
	bPayload, bOK := b.(map[string]any)
	if !aOK || !bOK {
		return mcpToolError{Error: "scan_failed", Message: "could not compare users"}
	}
	aScore, aOK := aPayload["final_score"].(float64)
	bScore, bOK := bPayload["final_score"].(float64)
	if !aOK || !bOK {
		return mcpToolError{Error: "scan_failed", Message: "could not compare users"}
	}
	gap := roundJS(math.Abs(aScore-bScore)*100) / 100
	var winner any
	if gap != 0 {
		if aScore > bScore {
			winner = aPayload["username"]
		} else {
			winner = bPayload["username"]
		}
	}
	return map[string]any{
		"a": aPayload, "b": bPayload, "winner": winner, "gap": gap,
		"note": "Deterministic comparison. For a savage bilingual verdict, POST /api/vs-verdict.",
	}
}

func (s *APIServer) mcpLeaderboard(ctx context.Context, view, window string, limit int) any {
	entries := []LeaderboardEntry{}
	cached := false
	if s.leaderboardCache != nil {
		if value, found, err := s.leaderboardCache.GetLeaderboard(ctx, view, window); err == nil && found {
			entries, cached = value, true
		}
	}
	if !cached && s.leaderboards != nil {
		if value, err := s.leaderboards.GetLeaderboard(ctx, view, window); err == nil {
			entries = value
			if len(entries) > 0 && s.leaderboardCache != nil {
				_ = s.leaderboardCache.SetLeaderboard(ctx, view, window, entries)
			}
		}
	}
	if entries == nil {
		entries = []LeaderboardEntry{}
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}
	total := len(entries)
	if len(entries) > limit {
		entries = entries[:limit]
	}
	return map[string]any{"view": view, "window": window, "cached": cached, "count": len(entries), "total": total, "entries": entries}
}

func (s *APIServer) mcpSearchUsers(ctx context.Context, rawQuery string) any {
	query := strings.TrimSpace(rawQuery)
	if query == "" {
		return map[string]any{"query": query, "users": []UserSuggestion{}}
	}
	if s.discovery == nil {
		return map[string]any{"query": query, "users": []UserSuggestion{}}
	}
	result, err := s.discovery.SearchDiscovery(ctx, query)
	if err != nil {
		return map[string]any{"query": query, "users": []UserSuggestion{}}
	}
	return map[string]any{"query": query, "users": result.Users}
}

func (s *APIServer) mcpStoredScorePayload(ctx context.Context, detail StoredScoreDetail, source string, current bool) map[string]any {
	return map[string]any{
		"source": source, "coverage": map[bool]string{true: "quick", false: "legacy"}[current], "stale": !current,
		"username": detail.Username, "display_name": detail.DisplayName, "final_score": detail.FinalScore,
		"tier": detail.Tier, "tier_key": tierKey(detail.Tier), "sub_scores": detail.SubScores,
		"percentile": s.scorePercentile(ctx, detail.FinalScore), "scanned_at": detail.ScannedAt,
		"profile": s.scoreProfileURL(detail.Username),
	}
}

func (s *APIServer) mcpLiveScorePayload(ctx context.Context, scan ScanResult) map[string]any {
	return map[string]any{
		"source": "quick", "coverage": "quick", "username": scan.Metrics.Username,
		"display_name": scan.Metrics.Name, "final_score": scan.Scoring.FinalScore,
		"tier": scan.Scoring.Tier, "tier_key": tierKey(scan.Scoring.Tier), "sub_scores": scan.Scoring.SubScores,
		"red_flags": scan.Scoring.RedFlags, "percentile": s.scorePercentile(ctx, scan.Scoring.FinalScore),
		"profile": s.scoreProfileURL(scan.Metrics.Username),
	}
}

func (s *APIServer) mcpQuickScan(ctx context.Context, username string) (*ScanResult, error) {
	now := s.clock().UTC()
	if s.scanCache != nil {
		if cached, err := s.scanCache.GetCachedScan(ctx, username); err == nil && cached != nil {
			if !s.persistScoreCache(ctx, username, *cached, now) {
				return nil, errors.New("score persistence unavailable")
			}
			return cached, nil
		}
	}
	if s.scanResults == nil || s.scanPublisher == nil || s.statuses == nil {
		return nil, ErrGitHubAuthRequired
	}
	flightLock := false
	if s.scanFlightGate != nil && s.scanCache != nil {
		if acquired, err := s.scanFlightGate.TryAcquireScanFlight(ctx, username); err == nil {
			flightLock = acquired
			if !acquired {
				if cached := s.waitForMCPScanCache(ctx, username); cached != nil {
					if !s.persistScoreCache(ctx, username, *cached, now) {
						return nil, errors.New("score persistence unavailable")
					}
					return cached, nil
				}
				flightLock, _ = s.scanFlightGate.TryAcquireScanFlight(ctx, username)
			}
		}
	}
	jobID, err := NewJobID()
	if err != nil {
		return nil, err
	}
	job := ScanJob{ID: jobID, Username: username, RequestedAt: now.UnixMilli(), FlightLock: flightLock}
	status := newScanJobStatus(job, JobQueued, "")
	if err := s.statuses.Put(ctx, status); err != nil {
		if flightLock && s.scanFlightGate != nil {
			_ = s.scanFlightGate.ReleaseScanFlight(context.Background(), username)
		}
		return nil, fmt.Errorf("job status unavailable: %w", err)
	}
	if err := s.scanPublisher.PublishScan(ctx, job); err != nil {
		if flightLock && s.scanFlightGate != nil {
			_ = s.scanFlightGate.ReleaseScanFlight(context.Background(), username)
		}
		return nil, fmt.Errorf("broker unavailable: %w", err)
	}
	return s.waitForMCPScanJob(ctx, status)
}

func (s *APIServer) waitForMCPScanCache(ctx context.Context, username string) *ScanResult {
	if s.scanCache == nil {
		return nil
	}
	return s.waitForMCPScanCacheFor(ctx, username, s.scanWait)
}

func (s *APIServer) waitForMCPScanCacheFor(ctx context.Context, username string, wait time.Duration) *ScanResult {
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	ticker := time.NewTicker(s.scanPoll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-deadline.C:
			return nil
		case <-ticker.C:
			scan, err := s.scanCache.GetCachedScan(ctx, username)
			if err == nil && scan != nil {
				return scan
			}
		}
	}
}

func (s *APIServer) waitForMCPScanJob(ctx context.Context, status JobStatus) (*ScanResult, error) {
	deadline := time.NewTimer(s.scanWait)
	defer deadline.Stop()
	ticker := time.NewTicker(s.scanPoll)
	defer ticker.Stop()
	for {
		if status.State == JobCompleted {
			scan, err := s.scanResults.GetCollectedScan(ctx, status.ID)
			if err != nil || scan == nil {
				return nil, errors.New("score persistence unavailable")
			}
			return scan, nil
		}
		if status.State == JobFailed {
			return nil, errors.New(status.Error)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-deadline.C:
			return nil, errors.New("scan timed out")
		case <-ticker.C:
			next, err := s.statuses.Get(ctx, status.ID)
			if err != nil {
				return nil, fmt.Errorf("job status unavailable: %w", err)
			}
			if next != nil {
				status = *next
			}
		}
	}
}

func mcpScanErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrGitHubAccountNotFound):
		return "account_not_found"
	case errors.Is(err, ErrGitHubRateLimited):
		return "github_rate_limited"
	case errors.Is(err, ErrGitHubUnavailable), errors.Is(err, ErrGitHubResourceLimit):
		return "github_unavailable"
	default:
		return "scan_failed"
	}
}

func mcpWriteSSE(w http.ResponseWriter, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		mcpWriteJSON(w, http.StatusInternalServerError, mcpJSONError(nil, -32603, "Internal error"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	_, _ = w.Write([]byte("data: "))
	_, _ = w.Write(encoded)
	_, _ = w.Write([]byte("\n\n"))
}

func mcpWriteJSON(w http.ResponseWriter, status int, payload mcpResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
