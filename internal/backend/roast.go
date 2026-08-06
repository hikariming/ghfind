package backend

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const (
	roastFrame            = "\x1f"
	roastFreshness        = 24 * time.Hour
	roastWait             = 120 * time.Second
	roastLLMDeadline      = 220 * time.Second
	roastAttemptBudget    = 95 * time.Second
	roastLineMaximumRunes = 180
)

type roastByoKey struct {
	BaseURL string `json:"baseURL"`
	APIKey  string `json:"apiKey"`
	Model   string `json:"model"`
}

type roastRequest struct {
	Scan     *ScanResult   `json:"scan"`
	Username unknownString `json:"username"`
	ByoKey   *roastByoKey  `json:"byoKey"`
	Lang     string        `json:"lang"`
	Refresh  bool          `json:"refresh"`
}

type RoastMeta struct {
	FinalScore float64          `json:"final_score"`
	Tier       string           `json:"tier"`
	TierLabel  string           `json:"tier_label"`
	Delta      float64          `json:"delta"`
	Percentile *RoastPercentile `json:"percentile"`
	Tags       Tags             `json:"tags"`
	RoastLine  RoastLine        `json:"roast_line"`
}

type RoastPercentile struct {
	Beat  *float64 `json:"beat"`
	Total int      `json:"total"`
	Rank  *int     `json:"rank"`
}

func parseRoastLanguage(value string) roastLanguage {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "zh":
		return roastLanguageZH
	case "en", "ja", "ko", "es", "pt", "id", "vi", "ar":
		return roastLanguageEN
	default:
		return roastLanguageZH
	}
}

func (s *APIServer) roast(w http.ResponseWriter, request *http.Request) {
	startedAt := s.clock().UTC()
	var input roastRequest
	decoder := json.NewDecoder(io.LimitReader(request.Body, 2<<20))
	if err := decoder.Decode(&input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_body"}, nil)
		return
	}
	username := input.Username.String()
	if input.Scan != nil {
		username = input.Scan.Metrics.Username
	}
	username = strictGitHubUsername(username)
	if username == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing_scan"}, nil)
		return
	}
	validMachine, absentMachine := s.machineAuthenticated(request)
	if !validMachine && !absentMachine {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"}, nil)
		return
	}
	ip := s.clientIP(request)
	principal := ip
	if absentMachine {
		if session := s.anonymousSessionPrincipal(request, startedAt); session != "" {
			principal = session
		}
	}
	if s.roastLimiter == nil {
		s.writeRoastRateError(w, RateLimitResult{Unavailable: true})
		return
	}
	requestLimit, err := s.roastLimiter.LimitRoastRequest(request.Context(), principal, startedAt)
	if err != nil {
		requestLimit.Unavailable = true
	}
	if !requestLimit.Success || requestLimit.Unavailable {
		s.writeRoastRateError(w, requestLimit)
		return
	}
	networkLimit, err := s.roastLimiter.LimitRoastRequestNetwork(request.Context(), ip, startedAt)
	if err != nil {
		networkLimit.Unavailable = true
	}
	if !networkLimit.Success || networkLimit.Unavailable {
		s.writeRoastRateError(w, networkLimit)
		return
	}
	language := parseRoastLanguage(input.Lang)
	if s.roasts == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "score_materialization_pending"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	if !input.Refresh && input.Scan == nil {
		legacy, err := s.roasts.GetLegacyRoast(request.Context(), username, language)
		if err == nil && legacy != nil && roastReportMatchesLanguage(legacy.Report, language) {
			s.writeRoastReplay(w, legacy.Report, s.storedRoastMeta(request.Context(), *legacy, language))
			return
		}
	}
	configs, defaultModel := s.roastLLMConfigs(input.ByoKey)
	if len(configs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "no_llm_configured", "useByoKey": true}, nil)
		return
	}
	canonical, err := s.roasts.GetCanonicalRoastScan(request.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "missing_scan"}, nil)
		return
	}
	var scan ScanResult
	snapshotHash := ""
	switch {
	case canonical != nil:
		scan, snapshotHash = canonical.Scan, canonical.SnapshotHash
	case s.scanCache != nil:
		cached, cacheErr := s.scanCache.GetCachedScan(request.Context(), username)
		if cacheErr == nil && cached != nil {
			scan = *cached
		}
	case input.Scan != nil:
		scan = boundedRoastScan(*input.Scan)
	}
	if scan.Metrics.Username == "" || scan.Scoring.Tier == "" {
		if input.Scan == nil || canonical != nil || s.scanCache == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing_scan"}, nil)
			return
		}
		scan = boundedRoastScan(*input.Scan)
	}
	if snapshotHash == "" {
		encoded, marshalErr := json.Marshal(scan)
		if marshalErr != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing_scan"}, nil)
			return
		}
		digest := sha256.Sum256(encoded)
		snapshotHash = hex.EncodeToString(digest[:])
	}
	var identity *RoastScoreIdentity
	refreshHonored := false
	if defaultModel {
		identity, err = s.roasts.GetRoastScoreIdentity(request.Context(), username, snapshotHash)
		if err != nil || identity == nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "score_materialization_pending"}, map[string]string{"Cache-Control": "no-store"})
			return
		}
		if input.Refresh {
			if scannedAt, readErr := s.roasts.GetRoastScannedAt(request.Context(), username); readErr == nil {
				refreshHonored = scannedAt == nil || startedAt.Sub(time.UnixMilli(*scannedAt)) > roastFreshness
			}
		}
		if !refreshHonored && s.roastCache != nil {
			if cached, cacheErr := s.roastCache.GetCachedRoast(request.Context(), username, language); cacheErr == nil && cached != nil {
				if cached.SnapshotHash == snapshotHash && roastReportMatchesLanguage(cached.Report, language) {
					s.writeRoastReplay(w, cached.Report, s.cachedRoastMeta(request.Context(), *cached, scan, language))
					return
				}
				_ = s.roastCache.ClearCachedRoast(request.Context(), username, language)
			}
		}
		if !refreshHonored {
			if archived, archiveErr := s.roasts.GetArchivedRoast(request.Context(), username, language); archiveErr == nil && archived != nil && roastReportMatchesLanguage(archived.Report, language) {
				if s.roastCache != nil {
					_ = s.roastCache.SetCachedRoast(request.Context(), username, language, cachedRoastFromStored(*archived, snapshotHash))
				}
				s.writeRoastReplay(w, archived.Report, s.storedRoastMeta(request.Context(), *archived, language))
				return
			}
		}
		generationLimit, limitErr := s.roastLimiter.LimitRoastGeneration(request.Context(), principal, startedAt)
		if limitErr != nil {
			generationLimit.Unavailable = true
		}
		if !generationLimit.Success || generationLimit.Unavailable {
			s.writeRoastRateError(w, generationLimit)
			return
		}
		networkGenerationLimit, limitErr := s.roastLimiter.LimitRoastNetworkGeneration(request.Context(), ip, startedAt)
		if limitErr != nil {
			networkGenerationLimit.Unavailable = true
		}
		if !networkGenerationLimit.Success || networkGenerationLimit.Unavailable {
			s.writeRoastRateError(w, networkGenerationLimit)
			return
		}
	}
	leader := false
	if defaultModel && s.roastCache != nil {
		leader, _ = s.roastCache.TryAcquireRoastLock(request.Context(), username, language)
		if !leader {
			if shared := s.waitForRoast(request.Context(), username, language); shared != nil && shared.SnapshotHash == snapshotHash && roastReportMatchesLanguage(shared.Report, language) {
				s.writeRoastReplay(w, shared.Report, s.cachedRoastMeta(request.Context(), *shared, scan, language))
				return
			}
		}
		if leader && refreshHonored {
			_ = s.roastCache.ClearCachedRoast(request.Context(), username, language)
		}
	}
	if leader && s.roastCache != nil {
		defer func() { _ = s.roastCache.ReleaseRoastLock(context.Background(), username, language) }()
	}
	s.writeGeneratedRoast(w, request, scan, language, configs, defaultModel, identity, snapshotHash, username, startedAt)
}

func (s *APIServer) roastLLMConfigs(byo *roastByoKey) ([]LLMConfig, bool) {
	if byo != nil && strings.TrimSpace(byo.APIKey) != "" && strings.TrimSpace(byo.BaseURL) != "" && strings.TrimSpace(byo.Model) != "" {
		config := LLMConfig{BaseURL: strings.TrimSpace(byo.BaseURL), APIKey: strings.TrimSpace(byo.APIKey), Model: strings.TrimSpace(byo.Model)}
		if validLLMConfig(config) {
			return []LLMConfig{config}, false
		}
		return nil, false
	}
	return s.config.DefaultLLMConfigs(), true
}

func (s *APIServer) writeRoastRateError(w http.ResponseWriter, result RateLimitResult) {
	headers := rateLimitHeaders(result, s.clock().UTC())
	headers["Cache-Control"] = "no-store"
	status, code := http.StatusTooManyRequests, "rate_limited"
	if result.Unavailable {
		status, code = http.StatusServiceUnavailable, "rate_limit_unavailable"
	}
	writeJSON(w, status, map[string]any{"error": code, "useByoKey": true}, headers)
}

func (s *APIServer) waitForRoast(ctx context.Context, username string, language roastLanguage) *CachedRoast {
	if s.roastCache == nil {
		return nil
	}
	deadline := time.Now().Add(roastWait)
	for time.Now().Before(deadline) {
		timer := time.NewTimer(500 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		if cached, err := s.roastCache.GetCachedRoast(ctx, username, language); err == nil && cached != nil {
			return cached
		}
		locked, err := s.roastCache.HasRoastLock(ctx, username, language)
		if err == nil && !locked {
			cached, _ := s.roastCache.GetCachedRoast(ctx, username, language)
			return cached
		}
	}
	return nil
}

func (s *APIServer) writeRoastReplay(w http.ResponseWriter, report string, meta RoastMeta) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-Roast-Meta", encodeRoastMeta(meta))
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, report)
}

func (s *APIServer) writeGeneratedRoast(w http.ResponseWriter, request *http.Request, scan ScanResult, language roastLanguage, configs []LLMConfig, defaultModel bool, identity *RoastScoreIdentity, snapshotHash, username string, startedAt time.Time) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-Roast-Meta", encodeRoastMeta(s.deterministicRoastMeta(scan, language)))
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	writeFrame := func(kind, payload string) {
		_, _ = io.WriteString(w, roastFrame+kind+payload+"\n")
		if flusher != nil {
			flusher.Flush()
		}
	}
	label := "正在撰写锐评…"
	if language == roastLanguageEN {
		label = "Writing roast…"
	}
	writeFrame("T", label+" (0s)")
	var head, report string
	var rawReport, pendingReport, emittedClean string
	metaWritten := false
	var tags Tags
	var roastLine RoastLine
	flushReport := func(force bool) error {
		if pendingReport == "" {
			return nil
		}
		raw, remainder := splitRoastPending(pendingReport, 600, force)
		if raw == "" {
			return nil
		}
		pendingReport = remainder
		rawReport += raw
		clean := sanitizeRoastText(scan, rawReport)
		// A 600-rune tail stays private until the next chunk. That is longer
		// than every post-generation pattern, so a replacement never needs to
		// retract bytes that were already streamed to the browser.
		if !strings.HasPrefix(clean, emittedClean) {
			return errors.New("roast sanitizer attempted to rewrite emitted output")
		}
		delta := clean[len(emittedClean):]
		if delta == "" {
			return nil
		}
		emittedClean = clean
		_, err := io.WriteString(w, delta)
		if flusher != nil {
			flusher.Flush()
		}
		return err
	}
	writeMeta := func(force bool) error {
		if metaWritten || (!force && !roastHeadingPattern.MatchString(head) && len(head) < 2000) {
			return nil
		}
		tags, roastLine = parseGeneratedRoastArtifacts(head)
		tags, roastLine, _ = sanitizeRoastArtifacts(scan, tags, roastLine, "")
		pendingReport = extractGeneratedRoastReport(head)
		meta := s.roastMeta(request.Context(), scan, language, tags, roastLine)
		writeFrame("M", encodeRoastMeta(meta))
		metaWritten = true
		return flushReport(false)
	}
	err := StreamLLM(request.Context(), s.llmHTTPClient, configs, buildRoastPrompt(scan, language), 0.55, startedAt.Add(roastLLMDeadline), roastAttemptBudget, func(event LLMStreamEvent) error {
		if event.Content == "" {
			return nil
		}
		if !metaWritten {
			head += event.Content
			return writeMeta(false)
		}
		pendingReport += event.Content
		return flushReport(false)
	})
	if err != nil {
		payload := map[string]any{"error": "roast_failed"}
		var quota *LLMQuotaError
		if errors.As(err, &quota) {
			payload = map[string]any{"error": "llm_quota", "useByoKey": true, "status": quota.Status}
		}
		writeFrame("E", encodeFrameJSON(payload))
		return
	}
	if err := writeMeta(true); err != nil {
		writeFrame("E", encodeFrameJSON(map[string]string{"error": "roast_failed"}))
		return
	}
	if err := flushReport(true); err != nil {
		writeFrame("E", encodeFrameJSON(map[string]string{"error": "roast_failed"}))
		return
	}
	report = sanitizeRoastText(scan, rawReport)
	if appendix := signatureWorkAppendix(scan, language, report); appendix != "" {
		report += appendix
		_, _ = io.WriteString(w, appendix)
		if flusher != nil {
			flusher.Flush()
		}
	}
	if defaultModel && identity != nil && report != "" && roastReportMatchesLanguage(report, language) {
		if persisted, persistErr := s.roasts.PersistRoast(request.Context(), username, report, language, *identity, tags, roastLine, s.clock().UTC()); persistErr == nil && persisted && s.roastCache != nil {
			meta := s.roastMeta(request.Context(), scan, language, tags, roastLine)
			_ = s.roastCache.SetCachedRoast(request.Context(), username, language, CachedRoast{Report: report, SnapshotHash: snapshotHash, Delta: 0, Tags: tags, RoastLine: roastLine, FinalScore: &meta.FinalScore, Tier: &meta.Tier})
		}
	}
}

func (s *APIServer) deterministicRoastMeta(scan ScanResult, language roastLanguage) RoastMeta {
	tier, label := tierFor(scan.Scoring.FinalScore)
	if language == roastLanguageEN {
		label = englishTierLabel(tier)
	}
	return RoastMeta{FinalScore: scan.Scoring.FinalScore, Tier: tier, TierLabel: label, Delta: 0, Tags: emptyRoastTags(), RoastLine: RoastLine{}}
}

func (s *APIServer) roastMeta(ctx context.Context, scan ScanResult, language roastLanguage, tags Tags, line RoastLine) RoastMeta {
	meta := s.deterministicRoastMeta(scan, language)
	meta.Tags, meta.RoastLine = ensureRoastTags(tags), line
	if s.roasts != nil {
		if rank, err := s.roasts.GetRoastRank(ctx, scan.Scoring.FinalScore); err == nil && rank != nil {
			beat := math.Round(math.Max(0, math.Min(100, float64(rank.Below)/float64(rank.Total)*100))*10) / 10
			value := rank.Rank
			meta.Percentile = &RoastPercentile{Beat: &beat, Total: rank.Total, Rank: &value}
		}
	}
	return meta
}

func (s *APIServer) storedRoastMeta(ctx context.Context, stored StoredRoast, language roastLanguage) RoastMeta {
	scan := ScanResult{Scoring: Scoring{FinalScore: stored.FinalScore, Tier: stored.Tier}}
	return s.roastMeta(ctx, scan, language, stored.Tags, stored.RoastLine)
}

func (s *APIServer) cachedRoastMeta(ctx context.Context, cached CachedRoast, scan ScanResult, language roastLanguage) RoastMeta {
	if cached.FinalScore != nil && cached.Tier != nil {
		return s.storedRoastMeta(ctx, StoredRoast{FinalScore: *cached.FinalScore, Tier: *cached.Tier, Tags: cached.Tags, RoastLine: cached.RoastLine}, language)
	}
	return s.roastMeta(ctx, scan, language, cached.Tags, cached.RoastLine)
}

func cachedRoastFromStored(stored StoredRoast, snapshotHash string) CachedRoast {
	score, tier := stored.FinalScore, stored.Tier
	return CachedRoast{Report: stored.Report, SnapshotHash: snapshotHash, Delta: 0, Tags: ensureRoastTags(stored.Tags), RoastLine: stored.RoastLine, FinalScore: &score, Tier: &tier}
}

func englishTierLabel(tier string) string {
	switch tier {
	case "夯":
		return "Legendary · Hall of Fame"
	case "顶级":
		return "Elite · Top-tier dev"
	case "人上人":
		return "Solid · Trustworthy"
	case "NPC":
		return "Average · Unremarkable"
	default:
		return "Low-value · Likely farmed"
	}
}

func encodeRoastMeta(meta RoastMeta) string {
	encoded, _ := json.Marshal(meta)
	return base64.StdEncoding.EncodeToString(encoded)
}

func encodeFrameJSON(value any) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

var (
	roastTagsPattern    = regexp.MustCompile(`(?s)@@TAGS\s*([^@]*?)@@`)
	roastLinePattern    = regexp.MustCompile(`(?s)@@ROAST\s*(.*?)@@`)
	roastHeadingPattern = regexp.MustCompile(`(?m)^\s*##\s`)
	cjkRunePattern      = regexp.MustCompile(`[㐀-鿿]`)
	englishMarker       = regexp.MustCompile(`(?:\*\*(?:一句话结论|风险标记|人工修正|建议)\*\*|毒舌点评|账号成熟度|原创项目质量|贡献质量|社区影响力|活跃真实性)`)
	internalTerms       = regexp.MustCompile(`(?i)\b(judge_result|delta|red_flags|metrics|impact_quality_cap|verified_impact_pr|self_closed_external_pr|top_starred_original_repo_quality_score|doc_like|core_impact_pr_count)\b`)
)

func parseGeneratedRoastArtifacts(head string) (Tags, RoastLine) {
	tags := emptyRoastTags()
	if match := roastTagsPattern.FindStringSubmatch(head); len(match) == 2 {
		for _, field := range []struct {
			key  string
			into *[]string
			max  int
		}{{"zh", &tags.ZH, 10}, {"en", &tags.EN, 24}} {
			value := generatedField(match[1], field.key)
			parts := strings.FieldsFunc(value, func(r rune) bool { return r == ',' || r == '，' || r == '、' })
			*field.into = cleanGeneratedTags(parts, field.max)
		}
	}
	line := RoastLine{}
	if match := roastLinePattern.FindStringSubmatch(head); len(match) == 2 {
		line.ZH = clampGeneratedRoastLine(generatedField(match[1], "zh"), false)
		line.EN = clampGeneratedRoastLine(generatedField(match[1], "en"), true)
	}
	return tags, line
}

func generatedField(value, key string) string {
	marker := key + "="
	index := strings.Index(value, marker)
	if index < 0 {
		return ""
	}
	value = value[index+len(marker):]
	if end := strings.Index(value, "|"); end >= 0 {
		value = value[:end]
	}
	return strings.TrimSpace(value)
}

func cleanGeneratedTags(values []string, maximum int) []string {
	seen, clean := map[string]bool{}, []string{}
	for _, value := range values {
		value = strings.TrimSpace(strings.NewReplacer("#", "", "@", "").Replace(value))
		value = truncateRunes(value, maximum)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		clean = append(clean, value)
		if len(clean) == 5 {
			break
		}
	}
	return clean
}

func clampGeneratedRoastLine(value string, english bool) string {
	value = strings.NewReplacer("#", "", "@", "").Replace(value)
	if english {
		value = cjkRunePattern.ReplaceAllString(value, "maintainers")
	}
	value = normalizeRoastText(value)
	if len([]rune(value)) <= roastLineMaximumRunes {
		return value
	}
	return strings.TrimSpace(string([]rune(value)[:roastLineMaximumRunes-1])) + "…"
}

func extractGeneratedRoastReport(head string) string {
	if location := roastHeadingPattern.FindStringIndex(head); location != nil {
		return head[location[0]:]
	}
	lines := strings.Split(head, "\n")
	result := []string{}
	for _, line := range lines {
		if strings.Contains(line, "@@ADJUST") || strings.Contains(line, "@@TAGS") || strings.Contains(line, "@@ROAST") {
			continue
		}
		result = append(result, line)
	}
	return strings.TrimLeft(strings.Join(result, "\n"), "\n")
}

func sanitizeGeneratedRoast(value string) string {
	return internalTerms.ReplaceAllString(value, "public evidence")
}

func roastReportMatchesLanguage(report string, language roastLanguage) bool {
	if language == roastLanguageZH {
		return true
	}
	if englishMarker.MatchString(report) {
		return false
	}
	return len(cjkRunePattern.FindAllString(report, -1)) <= 12
}

func emptyRoastTags() Tags { return Tags{ZH: []string{}, EN: []string{}} }
func ensureRoastTags(tags Tags) Tags {
	if tags.ZH == nil {
		tags.ZH = []string{}
	}
	if tags.EN == nil {
		tags.EN = []string{}
	}
	return tags
}
