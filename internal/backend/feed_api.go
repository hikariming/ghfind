package backend

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type FeedGorseRecommender interface {
	Recommend(context.Context, string, int) ([]string, error)
}

const (
	feedDefaultPageSize = 20
	feedMaxPageSize     = 50
	feedMaxEvents       = 50
	feedMaxBodyBytes    = 128 << 10
)

var feedEventIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// UseFeed installs optional Feed dependencies after Config validation. A nil
// store is an intentional degraded state: OAuth/cohort semantics remain
// deterministic while Feed requests return 503 and unrelated routes stay up.
func (s *APIServer) UseFeed(store FeedDataStore, sessions FeedSessionStore) error {
	if !s.config.FeedMode.Enabled() {
		return nil
	}
	signer, err := NewFeedSigner(s.config.FeedSigningSecret)
	if err != nil {
		return err
	}
	s.feed, s.feedSessions, s.feedSigner = store, sessions, signer
	return nil
}

func (s *APIServer) feedReady(w http.ResponseWriter, request *http.Request) {
	if !s.config.FeedMode.Enabled() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "feed_disabled"}, noStoreHeaders())
		return
	}
	if s.feed == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 4*time.Second)
	defer cancel()
	if err := s.feed.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ready": true}, noStoreHeaders())
}

func (s *APIServer) UseFeedGorse(recommender FeedGorseRecommender) error {
	if s.config.FeedGorseLiveBPS == 0 {
		return nil
	}
	if s.config.FeedMode != FeedModeGorseCanary || recommender == nil {
		return fmt.Errorf("live Gorse candidate source requires gorse_canary mode and a recommender")
	}
	s.feedGorse = recommender
	return nil
}

func (s *APIServer) feedPrincipal(w http.ResponseWriter, request *http.Request) (*OAuthSession, bool) {
	if !s.config.FeedMode.Enabled() {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "feed_disabled"}, noStoreHeaders())
		return nil, false
	}
	session := s.sessionFromRequest(request, s.clock().UTC())
	if session == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication_required"}, noStoreHeaders())
		return nil, false
	}
	if !s.feedCohortEnabled(session.GitHubID) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "feed_not_enabled"}, noStoreHeaders())
		return nil, false
	}
	if s.feed == nil || s.feedSigner == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return nil, false
	}
	return session, true
}

func (s *APIServer) feedCohortEnabled(githubID int64) bool {
	for _, allowed := range s.config.FeedInternalAllowlist {
		if allowed == githubID {
			return true
		}
	}
	if len(s.config.FeedInternalAllowlist) == 0 && s.config.FeedCanaryBPS == 0 {
		return true
	}
	if s.config.FeedCanaryBPS <= 0 {
		return false
	}
	mac := hmac.New(sha256.New, []byte(s.config.FeedSigningSecret))
	_, _ = mac.Write([]byte("feed-cohort-v1\x00" + strconv.FormatInt(githubID, 10)))
	bucket := int(binary.BigEndian.Uint32(mac.Sum(nil)[:4]) % 10_000)
	return bucket < s.config.FeedCanaryBPS
}

func (s *APIServer) feedTags(w http.ResponseWriter, request *http.Request) {
	session, ok := s.feedPrincipal(w, request)
	if !ok {
		return
	}
	if !s.allowFeedRequest(w, request, session.GitHubID, "read") {
		return
	}
	tags, version, err := s.feed.ListFeedTags(request.Context())
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"taxonomyVersion": version, "tags": tags}, noStoreHeaders())
}

func (s *APIServer) feedPreferences(w http.ResponseWriter, request *http.Request) {
	session, ok := s.feedPrincipal(w, request)
	if !ok {
		return
	}
	limitKind := "read"
	if request.Method == http.MethodPut {
		limitKind = "write"
	}
	if !s.allowFeedRequest(w, request, session.GitHubID, limitKind) {
		return
	}
	user, err := s.ensureFeedUser(request.Context(), *session)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	if request.Method == http.MethodPut {
		var body struct {
			TaxonomyVersion int64            `json:"taxonomyVersion"`
			Preferences     []FeedPreference `json:"preferences"`
		}
		if err := decodeFeedJSON(request, &body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_body"}, noStoreHeaders())
			return
		}
		for index := range body.Preferences {
			body.Preferences[index].Source = "explicit"
			body.Preferences[index].Strength = 1
			body.Preferences[index].TaxonomyVersion = body.TaxonomyVersion
		}
		user, err = s.feed.ReplaceExplicitFeedPreferences(request.Context(), session.GitHubID, body.TaxonomyVersion, body.Preferences)
		if errors.Is(err, ErrFeedTaxonomyChanged) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "taxonomy_version_changed"}, noStoreHeaders())
			return
		}
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_preferences"}, noStoreHeaders())
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"taxonomyVersion": user.TaxonomyVersion,
		"profileVersion":  user.ProfileVersion,
		"preferences":     user.Preferences,
		"weakProfile":     feedWeakProfileSummary(user.Preferences),
	}, noStoreHeaders())
}

func feedWeakProfileSummary(preferences []FeedPreference) map[string]any {
	positive, negative, weak := 0, 0, 0
	for _, preference := range preferences {
		if preference.Source != "explicit" {
			weak++
		}
		if preference.Value > 0 {
			positive++
		} else {
			negative++
		}
	}
	return map[string]any{"positiveTags": positive, "negativeTags": negative, "weakSignals": weak}
}

func (s *APIServer) feedProjects(w http.ResponseWriter, request *http.Request) {
	oauth, ok := s.feedPrincipal(w, request)
	if !ok {
		return
	}
	if !s.allowFeedRequest(w, request, oauth.GitHubID, "read") {
		return
	}
	limit, ok := feedPageLimit(request.URL.Query().Get("limit"))
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_pagination"}, noStoreHeaders())
		return
	}
	now := s.clock().UTC()
	cursor := strings.TrimSpace(request.URL.Query().Get("cursor"))
	if cursor != "" {
		s.serveFeedCursor(w, request, *oauth, cursor, limit, now)
		return
	}
	user, err := s.ensureFeedUser(request.Context(), *oauth)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	started := time.Now()
	candidates, counts, err := s.feed.LoadFeedCandidates(request.Context(), *user, 240)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	degraded := []string{}
	if s.feedGorseLiveEnabled(user.GitHubID) {
		gorseCtx, cancel := context.WithTimeout(request.Context(), 200*time.Millisecond)
		itemIDs, recommendErr := s.feedGorse.Recommend(gorseCtx, FeedGorseUserID(user.GitHubID), 100)
		cancel()
		if recommendErr != nil {
			degraded = append(degraded, "gorse_unavailable")
		} else {
			gorseCandidates, hydrateErr := s.feed.LoadGorseFeedCandidates(request.Context(), *user, itemIDs, 60)
			if hydrateErr != nil {
				degraded = append(degraded, "gorse_hydration_unavailable")
			} else {
				candidates = mergeGorseFeedCandidates(candidates, gorseCandidates, now, 240)
				counts["gorse"] = len(gorseCandidates)
			}
		}
	}
	sessionID, err := NewFeedID("feed_session")
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	seed := s.feedSeed(user.GitHubID, sessionID)
	items := RankFeedCandidates(candidates, FeedRankOptions{Now: now, Limit: 240, Seed: seed, OwnerCap: 2, ExplorationPageSize: limit})
	feedSession := FeedSession{
		ID: sessionID, GitHubID: user.GitHubID, AlgorithmVersion: FeedAlgorithmVersion,
		TaxonomyVersion: user.TaxonomyVersion, ProfileVersion: user.ProfileVersion, PageSize: limit,
		Seed: seed, CandidateCounts: counts, Degraded: degraded, Items: items, CreatedAt: now, ExpiresAt: now.Add(FeedSessionTTL),
	}
	if s.feedSessions == nil || s.feedSessions.PutFeedSession(request.Context(), feedSession, FeedSessionTTL) != nil {
		feedSession.Degraded = append(feedSession.Degraded, "cursor_store_unavailable")
	}
	s.serveFeedPage(w, request, *user, feedSession, 0, limit, started)
}

func (s *APIServer) feedGorseLiveEnabled(githubID int64) bool {
	if s.config.FeedMode != FeedModeGorseCanary || s.config.FeedGorseLiveBPS <= 0 || s.feedGorse == nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(s.config.FeedSigningSecret))
	_, _ = mac.Write([]byte("feed-gorse-live-v1\x00" + strconv.FormatInt(githubID, 10)))
	bucket := int(binary.BigEndian.Uint32(mac.Sum(nil)[:4]) % 10_000)
	return bucket < s.config.FeedGorseLiveBPS
}

func mergeGorseFeedCandidates(baseline, gorse []FeedCandidate, now time.Time, limit int) []FeedCandidate {
	if limit < 1 {
		limit = 240
	}
	byKey := map[string]int{}
	for index := range baseline {
		byKey[baseline[index].Project.RepoKey] = index
	}
	exclusive := []FeedCandidate{}
	for _, candidate := range gorse {
		if index, exists := byKey[candidate.Project.RepoKey]; exists {
			baseline[index].Sources = uniqueStrings(append(baseline[index].Sources, "gorse"))
			continue
		}
		candidate.Sources = uniqueStrings(append(candidate.Sources, "gorse"))
		exclusive = append(exclusive, candidate)
		if len(exclusive) == limit/4 {
			break
		}
	}
	sort.SliceStable(baseline, func(i, j int) bool {
		left, _ := baselineFeedScore(baseline[i], now)
		right, _ := baselineFeedScore(baseline[j], now)
		if left != right {
			return left > right
		}
		return baseline[i].Project.RepoKey < baseline[j].Project.RepoKey
	})
	baselineLimit := minInt(len(baseline), limit-len(exclusive))
	result := make([]FeedCandidate, 0, baselineLimit+len(exclusive))
	result = append(result, baseline[:baselineLimit]...)
	return append(result, exclusive...)
}

func (s *APIServer) serveFeedCursor(w http.ResponseWriter, request *http.Request, oauth OAuthSession, token string, limit int, now time.Time) {
	claims, err := s.feedSigner.ParseCursor(token, oauth.GitHubID, now)
	if errors.Is(err, ErrExpiredFeedToken) {
		writeJSON(w, http.StatusGone, map[string]string{"error": "feed_cursor_expired"}, noStoreHeaders())
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_cursor"}, noStoreHeaders())
		return
	}
	if s.feedSessions == nil {
		writeJSON(w, http.StatusGone, map[string]string{"error": "feed_cursor_expired"}, noStoreHeaders())
		return
	}
	session, err := s.feedSessions.GetFeedSession(request.Context(), claims.SessionID)
	if err != nil || session.GitHubID != oauth.GitHubID || session.ExpiresAt.Before(now) {
		writeJSON(w, http.StatusGone, map[string]string{"error": "feed_cursor_expired"}, noStoreHeaders())
		return
	}
	if claims.Offset >= len(session.Items) {
		writeJSON(w, http.StatusOK, feedProjectsResponse{
			RequestID: "", AlgorithmVersion: session.AlgorithmVersion,
			TaxonomyVersion: session.TaxonomyVersion, Items: []FeedRankedItem{}, Degraded: session.Degraded,
		}, noStoreHeaders())
		return
	}
	user, err := s.feed.GetFeedUser(request.Context(), oauth.GitHubID)
	if err != nil || user == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	pageSize := session.PageSize
	if pageSize < 1 || pageSize > feedMaxPageSize {
		pageSize = limit
	}
	s.serveFeedPage(w, request, *user, *session, claims.Offset, pageSize, time.Now())
}

type feedProjectsResponse struct {
	RequestID        string           `json:"requestId"`
	AlgorithmVersion string           `json:"algorithmVersion"`
	TaxonomyVersion  int64            `json:"taxonomyVersion"`
	Items            []FeedRankedItem `json:"items"`
	NextCursor       *string          `json:"nextCursor"`
	Degraded         []string         `json:"degraded"`
}

func (s *APIServer) serveFeedPage(w http.ResponseWriter, request *http.Request, user FeedUser, session FeedSession, offset, limit int, started time.Time) {
	end := minInt(offset+limit, len(session.Items))
	items := append([]FeedRankedItem(nil), session.Items[offset:end]...)
	requestID, err := NewFeedID("feed_request")
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	now := s.clock().UTC()
	for index := range items {
		token, signErr := s.feedSigner.SignImpression(FeedImpressionClaims{
			GitHubID: user.GitHubID, RequestID: requestID, RepoKey: items[index].Project.RepoKey,
			Rank: items[index].Rank, AlgorithmVersion: session.AlgorithmVersion,
			ExpiresAt: now.Add(FeedImpressionTTL).UnixMilli(),
		})
		if signErr != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
			return
		}
		items[index].ImpressionToken = token
	}
	record := FeedRequestRecord{ID: requestID, User: user, Seed: session.Seed,
		CandidateCounts: session.CandidateCounts, Degraded: session.Degraded, Duration: time.Since(started), Items: items}
	if err := s.feed.SaveFeedRequest(request.Context(), record); err != nil {
		s.metrics.recordFeedRequest("error", time.Since(started))
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	if offset == 0 {
		s.metrics.recordFeedCandidates(session.CandidateCounts)
	}
	s.metrics.recordFeedServed(items)
	s.metrics.recordFeedRequest("ok", time.Since(started))
	var nextCursor *string
	if end < len(session.Items) && !containsString(session.Degraded, "cursor_store_unavailable") {
		token, signErr := s.feedSigner.SignCursor(FeedCursorClaims{
			SessionID: session.ID, GitHubID: user.GitHubID, Offset: end, ExpiresAt: session.ExpiresAt.UnixMilli(),
		})
		if signErr == nil {
			nextCursor = &token
		}
	}
	writeJSON(w, http.StatusOK, feedProjectsResponse{RequestID: requestID, AlgorithmVersion: session.AlgorithmVersion,
		TaxonomyVersion: session.TaxonomyVersion, Items: items, NextCursor: nextCursor,
		Degraded: uniqueStrings(session.Degraded)}, noStoreHeaders())
}

func (s *APIServer) feedProjectState(w http.ResponseWriter, request *http.Request) {
	oauth, ok := s.feedPrincipal(w, request)
	if !ok {
		return
	}
	if !s.allowFeedRequest(w, request, oauth.GitHubID, "write") {
		return
	}
	if _, err := s.feed.EnsureFeedUser(request.Context(), *oauth); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	owner, repo := request.PathValue("owner"), request.PathValue("repo")
	normalized, err := NormalizeGitHubRepository(owner + "/" + repo)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_repository"}, noStoreHeaders())
		return
	}
	var body struct {
		Saved           *bool  `json:"saved"`
		NotInterested   *bool  `json:"notInterested"`
		ImpressionToken string `json:"impressionToken"`
	}
	if err := decodeFeedJSON(request, &body); err != nil || (body.Saved == nil) == (body.NotInterested == nil) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_state_patch"}, noStoreHeaders())
		return
	}
	patch := FeedStatePatch{Saved: body.Saved, NotInterested: body.NotInterested}
	if body.ImpressionToken != "" {
		claims, parseErr := s.feedSigner.ParseImpression(body.ImpressionToken, oauth.GitHubID, normalized.RepoKey, s.clock().UTC())
		if parseErr != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_impression_token"}, noStoreHeaders())
			return
		}
		patch.RequestID = claims.RequestID
	}
	state, err := s.feed.SetFeedProjectState(request.Context(), oauth.GitHubID, normalized.RepoKey, patch, s.clock().UTC())
	if errors.Is(err, ErrFeedProjectNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "project_not_found"}, noStoreHeaders())
		return
	}
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	writeJSON(w, http.StatusOK, state, noStoreHeaders())
}

func (s *APIServer) feedEvents(w http.ResponseWriter, request *http.Request) {
	oauth, ok := s.feedPrincipal(w, request)
	if !ok {
		return
	}
	if !s.allowFeedRequest(w, request, oauth.GitHubID, "events") {
		return
	}
	if _, err := s.feed.EnsureFeedUser(request.Context(), *oauth); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	var body struct {
		Events []FeedEventInput `json:"events"`
	}
	if err := decodeFeedJSON(request, &body); err != nil || len(body.Events) == 0 || len(body.Events) > feedMaxEvents {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_events"}, noStoreHeaders())
		return
	}
	now := s.clock().UTC()
	accepted := make([]AcceptedFeedEvent, 0, len(body.Events))
	seenIDs := map[string]bool{}
	for _, input := range body.Events {
		input.RepoKey = strings.ToLower(strings.TrimSpace(input.RepoKey))
		if !feedEventIDPattern.MatchString(input.ID) || seenIDs[input.ID] || !input.Type.Telemetry() ||
			input.OccurredAt.IsZero() || input.OccurredAt.Before(now.Add(-24*time.Hour)) || input.OccurredAt.After(now.Add(5*time.Minute)) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_events"}, noStoreHeaders())
			return
		}
		seenIDs[input.ID] = true
		claims, err := s.feedSigner.ParseImpression(input.ImpressionToken, oauth.GitHubID, input.RepoKey, now)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_impression_token"}, noStoreHeaders())
			return
		}
		metadata := map[string]any{"rank": claims.Rank, "algorithmVersion": claims.AlgorithmVersion}
		if input.Type == FeedEventDwell {
			if input.DurationMS < 0 || input.DurationMS > int((30*time.Minute).Milliseconds()) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_events"}, noStoreHeaders())
				return
			}
			metadata["durationMs"] = input.DurationMS
			metadata["qualified"] = input.DurationMS >= 10_000
		}
		accepted = append(accepted, AcceptedFeedEvent{Input: input, RequestID: claims.RequestID, Metadata: metadata})
	}
	result, err := s.feed.AppendFeedEvents(request.Context(), oauth.GitHubID, accepted)
	if err != nil {
		for _, event := range accepted {
			s.metrics.recordFeedEvents(event.Input.Type, "error", 1)
		}
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_events_unavailable"}, feedUnavailableHeaders())
		return
	}
	for _, event := range accepted {
		s.metrics.recordFeedEvents(event.Input.Type, "accepted", 1)
	}
	writeJSON(w, http.StatusAccepted, result, noStoreHeaders())
}

func (s *APIServer) deleteFeedProfile(w http.ResponseWriter, request *http.Request) {
	if !s.config.FeedMode.Enabled() || s.feed == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	oauth := s.sessionFromRequest(request, s.clock().UTC())
	if oauth == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "authentication_required"}, noStoreHeaders())
		return
	}
	if !s.allowFeedRequest(w, request, oauth.GitHubID, "write") {
		return
	}
	deletionID, err := s.feed.DeleteFeedProfile(request.Context(), oauth.GitHubID, s.clock().UTC())
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"deletionId": deletionID, "status": "queued"}, noStoreHeaders())
}

func (s *APIServer) feedSeed(githubID int64, requestID string) string {
	mac := hmac.New(sha256.New, []byte(s.config.FeedSigningSecret))
	_, _ = mac.Write([]byte(strconv.FormatInt(githubID, 10) + "\x00" + requestID + "\x00" + FeedAlgorithmVersion))
	return fmt.Sprintf("%x", mac.Sum(nil))
}

func feedPageLimit(raw string) (int, bool) {
	if strings.TrimSpace(raw) == "" {
		return feedDefaultPageSize, true
	}
	limit, err := strconv.Atoi(raw)
	return limit, err == nil && limit >= 1 && limit <= feedMaxPageSize
}

func decodeFeedJSON(request *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(request.Body, feedMaxBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return fmt.Errorf("request body must contain one JSON value")
	}
	return nil
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if subtle.ConstantTimeCompare([]byte(value), []byte(wanted)) == 1 {
			return true
		}
	}
	return false
}

func feedUnavailableHeaders() map[string]string {
	return map[string]string{"Cache-Control": "no-store", "Retry-After": "5"}
}

func (s *APIServer) allowFeedRequest(w http.ResponseWriter, request *http.Request, githubID int64, kind string) bool {
	if s.feedLimiter == nil {
		return true
	}
	result, err := s.feedLimiter.LimitFeed(request.Context(), githubID, kind, s.clock().UTC())
	if err != nil || result.Unavailable {
		// Feed is the one protected surface whose Redis contract explicitly
		// requires a usable first page during an Upstash outage. PostgreSQL
		// remains the durable write boundary, while the missing session later
		// forces nextCursor=null. Keep this failure mode deliberate and local.
		if kind == "read" {
			s.metrics.IncCounter("ghfind_feed_requests_total", map[string]string{"algorithm": FeedAlgorithmVersion, "result": "rate_limit_degraded"})
			return true
		}
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "rate_limit_unavailable"},
			map[string]string{"Cache-Control": "no-store", "Retry-After": strconv.Itoa(rateLimitUnavailableRetry)})
		return false
	}
	if !result.Success {
		retry := int(time.Until(result.ResetAt).Seconds())
		if retry < 1 {
			retry = 1
		}
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "rate_limited"},
			map[string]string{"Cache-Control": "no-store", "Retry-After": strconv.Itoa(retry)})
		return false
	}
	return true
}
