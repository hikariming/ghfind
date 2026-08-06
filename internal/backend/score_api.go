package backend

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var canonicalSnapshotHashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

const (
	scoreRatedCache = "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400"
	scoreLiveCache  = "public, max-age=0, s-maxage=600, stale-while-revalidate=3600"
	scoreMissCache  = "public, max-age=0, s-maxage=60, stale-while-revalidate=300"
)

type RoastLine struct {
	ZH string `json:"zh"`
	EN string `json:"en"`
}

type StoredScoreDetail struct {
	Username          string
	DisplayName       *string
	AvatarURL         *string
	ProfileURL        *string
	FinalScore        float64
	Tier              string
	Tags              Tags
	RoastLine         RoastLine
	SubScores         SubScores
	ScannedAt         int64
	ScoreVersion      string
	CollectionVersion string
	SnapshotHash      string
	LegacyFallback    bool
}

type ScorePercentile struct {
	Beat  *float64 `json:"beat"`
	Total int      `json:"total"`
	Rank  *int     `json:"rank"`
}

// ScoreReadStore is the read contract for /api/score. It only inspects the
// current scores table and never promotes a historical score into canonical.
type ScoreReadStore interface {
	GetStoredScore(context.Context, string) (*StoredScoreDetail, error)
	GetScorePercentile(context.Context, float64) (*ScorePercentile, error)
}

func nullableStringValue(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func parseRoastLine(raw string) RoastLine {
	line := RoastLine{}
	_ = json.Unmarshal([]byte(raw), &line)
	return line
}

func parseSubScores(raw string) SubScores {
	scores := SubScores{}
	_ = json.Unmarshal([]byte(raw), &scores)
	return scores
}

func (s *TursoStore) GetStoredScore(ctx context.Context, username string) (*StoredScoreDetail, error) {
	var detail StoredScoreDetail
	var display, avatar, profile, version, collection, snapshot, roast, roastEN, roastVersion, roastENVersion sql.NullString
	var tags, roastLine, subScores sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT username, display_name, avatar_url, profile_url, final_score, tier,
		tags, roast_line, sub_scores, score_version, score_source_collection_version,
		score_source_snapshot_hash, roast, roast_en, roast_version, roast_en_version, scanned_at
		FROM scores WHERE username = ? AND hidden = 0 LIMIT 1`, strings.ToLower(username)).Scan(
		&detail.Username, &display, &avatar, &profile, &detail.FinalScore, &detail.Tier,
		&tags, &roastLine, &subScores, &version, &collection, &snapshot, &roast, &roastEN, &roastVersion, &roastENVersion, &detail.ScannedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read stored score: %w", err)
	}
	detail.DisplayName = nullableStringValue(display)
	detail.AvatarURL = nullableStringValue(avatar)
	detail.ProfileURL = nullableStringValue(profile)
	detail.ScoreVersion, detail.CollectionVersion, detail.SnapshotHash = version.String, collection.String, snapshot.String
	detail.Tags = parseTags(tags.String)
	detail.RoastLine = parseRoastLine(roastLine.String)
	detail.SubScores = parseSubScores(subScores.String)
	detail.LegacyFallback = detail.ScoreVersion == "v5" && ((roastVersion.String == "v5" && roast.Valid && roast.String != "") || (roastENVersion.String == "v5" && roastEN.Valid && roastEN.String != ""))
	if detail.ScoreVersion != canonicalScoreVersion && !detail.LegacyFallback {
		return nil, nil
	}
	return &detail, nil
}

func (s *TursoStore) GetScorePercentile(ctx context.Context, score float64) (*ScorePercentile, error) {
	bucket := int(math.Floor(score*10 + 0.5))
	var total, below int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(CASE WHEN CAST(ROUND(final_score * 10) AS INTEGER) < ? THEN 1 ELSE 0 END), 0)
		FROM scores WHERE score_version = ?`, bucket, canonicalScoreVersion).Scan(&total, &below)
	if err != nil {
		return nil, fmt.Errorf("score percentile: %w", err)
	}
	if total == 0 {
		return nil, nil
	}
	result := &ScorePercentile{Total: total}
	if total > 1 {
		beat := math.Round(math.Max(0, math.Min(100, float64(below)/float64(total)*100))*10) / 10
		result.Beat = &beat
		var visibleTotal, above int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(CASE WHEN CAST(ROUND(final_score * 10) AS INTEGER) > ? THEN 1 ELSE 0 END), 0)
			FROM scores WHERE score_version = ? AND hidden = 0`, bucket, canonicalScoreVersion).Scan(&visibleTotal, &above); err != nil {
			return nil, fmt.Errorf("score rank: %w", err)
		}
		if visibleTotal > 1 {
			rank := above + 1
			result.Rank = &rank
		}
	}
	return result, nil
}

func tierKey(tier string) string {
	switch tier {
	case "夯":
		return "god"
	case "顶级":
		return "elite"
	case "人上人":
		return "solid"
	case "NPC":
		return "npc"
	default:
		return "trash"
	}
}

func (s *APIServer) scorePercentile(ctx context.Context, score float64) *ScorePercentile {
	if s.scoreReads == nil {
		return nil
	}
	percentile, err := s.scoreReads.GetScorePercentile(ctx, score)
	if err != nil {
		return nil
	}
	return percentile
}

func (s *APIServer) storedScorePayload(ctx context.Context, detail StoredScoreDetail, source string, current bool) map[string]any {
	profileURL := "https://github.com/" + detail.Username
	if detail.ProfileURL != nil && *detail.ProfileURL != "" {
		profileURL = *detail.ProfileURL
	}
	return map[string]any{
		"source":       source,
		"coverage":     map[bool]string{true: "quick", false: "legacy"}[current],
		"stale":        !current,
		"username":     detail.Username,
		"display_name": detail.DisplayName,
		"avatar_url":   detail.AvatarURL,
		"profile_url":  profileURL,
		"final_score":  detail.FinalScore,
		"tier":         detail.Tier,
		"tier_key":     tierKey(detail.Tier),
		"sub_scores":   detail.SubScores,
		"tags":         detail.Tags,
		"roast_line":   detail.RoastLine,
		"percentile":   s.scorePercentile(ctx, detail.FinalScore),
		"scanned_at":   detail.ScannedAt,
		"profile":      s.scoreProfileURL(detail.Username),
	}
}

func (s *APIServer) liveScorePayload(ctx context.Context, scan ScanResult, cached bool) map[string]any {
	profileURL := "https://github.com/" + scan.Metrics.Username
	if scan.Metrics.ProfileURL != nil && *scan.Metrics.ProfileURL != "" {
		profileURL = *scan.Metrics.ProfileURL
	}
	return map[string]any{
		"source":        "quick",
		"coverage":      "quick",
		"cached":        cached,
		"username":      scan.Metrics.Username,
		"display_name":  scan.Metrics.Name,
		"avatar_url":    scan.Metrics.AvatarURL,
		"profile_url":   profileURL,
		"final_score":   scan.Scoring.FinalScore,
		"tier":          scan.Scoring.Tier,
		"tier_key":      tierKey(scan.Scoring.Tier),
		"sub_scores":    scan.Scoring.SubScores,
		"base_score":    scan.Scoring.BaseScore,
		"total_penalty": scan.Scoring.TotalPenalty,
		"red_flags":     scan.Scoring.RedFlags,
		"tags":          nil,
		"roast_line":    nil,
		"percentile":    s.scorePercentile(ctx, scan.Scoring.FinalScore),
		"profile":       s.scoreProfileURL(scan.Metrics.Username),
	}
}

func (s *APIServer) scoreProfileURL(username string) string {
	if origin := s.publicOrigin(); origin != "" {
		return origin + "/u/" + username
	}
	return "https://ghfind.com/u/" + username
}

func scoreRateLimitError(w http.ResponseWriter, limit RateLimitResult, now time.Time) {
	headers := rateLimitHeaders(limit, now)
	headers["Cache-Control"] = "no-store"
	code, status, message := "rate_limited", http.StatusTooManyRequests, "too many requests"
	if limit.Unavailable {
		code, status, message = "rate_limit_unavailable", http.StatusServiceUnavailable, "request protection temporarily unavailable"
	}
	writeJSON(w, status, map[string]string{"error": code, "message": message, "hint": "retry after the Retry-After interval"}, headers)
}

func scoreResponseHeaders(cache string, rateHeaders map[string]string) map[string]string {
	headers := map[string]string{"Cache-Control": cache}
	for key, value := range rateHeaders {
		headers[key] = value
	}
	headers["Cache-Control"] = cache
	return headers
}

func (s *APIServer) score(w http.ResponseWriter, request *http.Request) {
	username := strictGitHubUsername(request.PathValue("username"))
	if username == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_username", "message": "username must be a valid GitHub login", "hint": "pass a login like /api/score/octocat"}, map[string]string{"Cache-Control": scoreMissCache})
		return
	}
	if s.scoreReads == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "scan_failed", "message": "score persistence is temporarily unavailable", "hint": "Retry later; no incomplete score was published."}, map[string]string{"Cache-Control": "no-store", "Retry-After": "5"})
		return
	}
	detail, err := s.scoreReads.GetStoredScore(request.Context(), username)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "scan_failed", "message": "score persistence is temporarily unavailable", "hint": "Retry later; no incomplete score was published."}, map[string]string{"Cache-Control": "no-store", "Retry-After": "5"})
		return
	}
	if detail != nil && detail.ScoreVersion == canonicalScoreVersion && detail.CollectionVersion == goCanonicalCollectionVersion && canonicalSnapshotHashPattern.MatchString(detail.SnapshotHash) {
		writeJSON(w, http.StatusOK, s.storedScorePayload(request.Context(), *detail, "indexed", true), map[string]string{"Cache-Control": scoreRatedCache})
		return
	}
	now := s.clock().UTC()
	if s.rateLimiter == nil {
		scoreRateLimitError(w, RateLimitResult{Unavailable: true}, now)
		return
	}
	limit, err := s.rateLimiter.LimitPublicRead(request.Context(), s.clientPrincipal(request), now)
	if err != nil {
		limit.Unavailable = true
	}
	if !limit.Success || limit.Unavailable {
		scoreRateLimitError(w, limit, now)
		return
	}
	headers := rateLimitHeaders(limit, now)
	if s.scanCache != nil {
		if cached, err := s.scanCache.GetCachedScan(request.Context(), username); err == nil && cached != nil {
			if !s.persistScoreCache(request.Context(), username, *cached, now) {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "scan_failed", "message": "score persistence is temporarily unavailable", "hint": "Retry later; no incomplete score was published."}, map[string]string{"Cache-Control": "no-store", "Retry-After": "5"})
				return
			}
			writeJSON(w, http.StatusOK, s.liveScorePayload(request.Context(), *cached, true), scoreResponseHeaders(scoreLiveCache, headers))
			return
		}
	}
	if s.scanResults == nil || s.scanPublisher == nil || s.statuses == nil {
		s.scoreFailure(w, detail, headers, ErrGitHubAuthRequired)
		return
	}
	scoreJobID, err := NewJobID()
	if err != nil {
		s.scoreFailure(w, detail, headers, err)
		return
	}
	flightLock := false
	if s.scanFlightGate != nil && s.scanCache != nil {
		if acquired, gateErr := s.scanFlightGate.TryAcquireScanFlight(request.Context(), username); gateErr == nil {
			flightLock = acquired
			if !acquired {
				if cached := s.waitForCachedScan(request, username); cached != nil {
					if s.persistScoreCache(request.Context(), username, *cached, now) {
						writeJSON(w, http.StatusOK, s.liveScorePayload(request.Context(), *cached, true), scoreResponseHeaders(scoreLiveCache, headers))
						return
					}
					writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "scan_failed"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "5"})
					return
				}
				flightLock, _ = s.scanFlightGate.TryAcquireScanFlight(request.Context(), username)
			}
		}
	}
	job := ScanJob{ID: scoreJobID, Username: username, RequestedAt: now.UnixMilli(), LookupHash: s.lookupIPHash(s.clientIP(request)), FlightLock: flightLock}
	status := newScanJobStatus(job, JobQueued, "")
	if err := s.statuses.Put(request.Context(), status); err != nil {
		if flightLock && s.scanFlightGate != nil {
			_ = s.scanFlightGate.ReleaseScanFlight(context.Background(), username)
		}
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "job_status_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	if err := s.scanPublisher.PublishScan(request.Context(), job); err != nil {
		s.metrics.recordAPIJobAdmission(ScanJobKind, "publish_failed")
		if flightLock && s.scanFlightGate != nil {
			_ = s.scanFlightGate.ReleaseScanFlight(context.Background(), username)
		}
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "broker_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	s.metrics.recordAPIJobAdmission(ScanJobKind, "queued")
	s.waitForScoreScan(w, request, status, headers, detail)
}

func (s *APIServer) persistScoreCache(ctx context.Context, username string, scan ScanResult, now time.Time) bool {
	if s.scanResults == nil {
		return false
	}
	id, err := NewJobID()
	if err != nil {
		return false
	}
	_, err = s.scanResults.PersistCollectedScan(ctx, ScanJob{ID: id, Username: username, RequestedAt: now.UnixMilli()}, scan)
	return err == nil
}

func (s *APIServer) waitForScoreScan(w http.ResponseWriter, request *http.Request, status JobStatus, headers map[string]string, legacy *StoredScoreDetail) {
	deadline := time.NewTimer(s.scanWait)
	defer deadline.Stop()
	ticker := time.NewTicker(s.scanPoll)
	defer ticker.Stop()
	for {
		if status.State == JobCompleted {
			scan, err := s.scanResults.GetCollectedScan(request.Context(), status.ID)
			if err != nil || scan == nil {
				s.scoreFailure(w, legacy, headers, errors.New("score persistence unavailable"))
				return
			}
			recordSuccessfulScanOutcome(request.Context(), s.scanOutcomes, s.lookupGate, s.campaignRevisions, scan.Metrics.Username, s.lookupIPHash(s.clientIP(request)), "", s.clock().UTC())
			writeJSON(w, http.StatusOK, s.liveScorePayload(request.Context(), *scan, false), scoreResponseHeaders(scoreLiveCache, headers))
			return
		}
		if status.State == JobFailed {
			s.scoreFailure(w, legacy, headers, errors.New(status.Error))
			return
		}
		select {
		case <-request.Context().Done():
			return
		case <-deadline.C:
			timeoutHeaders := scoreResponseHeaders("no-store", headers)
			timeoutHeaders["Retry-After"] = "5"
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "scan_failed", "message": "scan timed out; retry later"}, timeoutHeaders)
			return
		case <-ticker.C:
			next, err := s.statuses.Get(request.Context(), status.ID)
			if err != nil {
				statusHeaders := scoreResponseHeaders("no-store", headers)
				statusHeaders["Retry-After"] = "15"
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "job_status_unavailable"}, statusHeaders)
				return
			}
			if next != nil {
				status = *next
			}
		}
	}
}

func (s *APIServer) scoreFailure(w http.ResponseWriter, legacy *StoredScoreDetail, headers map[string]string, err error) {
	if legacy != nil && legacy.LegacyFallback {
		writeJSON(w, http.StatusOK, s.storedScorePayload(context.Background(), *legacy, "legacy_v5_v5_v3", false), scoreResponseHeaders(scoreLiveCache, headers))
		return
	}
	code, status, retry := "scan_failed", http.StatusInternalServerError, ""
	switch {
	case errors.Is(err, ErrGitHubAuthRequired):
		code, status = "github_token_required", http.StatusInternalServerError
	case errors.Is(err, ErrGitHubAccountNotFound):
		code, status = "account_not_found", http.StatusNotFound
	case errors.Is(err, ErrGitHubRateLimited):
		code, status = "github_rate_limited", http.StatusServiceUnavailable
	case errors.Is(err, ErrGitHubUnavailable), errors.Is(err, ErrGitHubResourceLimit):
		code, status, retry = "github_unavailable", http.StatusServiceUnavailable, "60"
	}
	response := map[string]any{"error": code, "message": strings.ReplaceAll(code, "_", " ")}
	if retry != "" {
		response["retry_after"] = 60
	}
	resultHeaders := map[string]string{"Cache-Control": scoreMissCache}
	for key, value := range headers {
		resultHeaders[key] = value
	}
	if retry != "" {
		resultHeaders["Retry-After"] = retry
	}
	writeJSON(w, status, response, resultHeaders)
}
