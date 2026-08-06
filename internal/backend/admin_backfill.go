package backend

import (
	"context"
	"net/http"
	"strings"
)

// AdminBackfillStore contains only bounded, rerunnable maintenance operations.
// It uses the existing profile snapshot and graph tables; it never changes a
// schema and every HTTP entrypoint is protected by ADMIN_SECRET.
type AdminBackfillStore interface {
	ListSnapshotUsernames(context.Context, int, int) ([]string, error)
	RebuildProfileIndexes(context.Context, string) (facets int, repos int, links int, found bool, err error)
}

func (s *TursoStore) ListSnapshotUsernames(ctx context.Context, limit, offset int) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT username FROM profile_snapshots ORDER BY username LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var username string
		if err := rows.Scan(&username); err != nil {
			return nil, err
		}
		result = append(result, username)
	}
	return result, rows.Err()
}

func (s *TursoStore) RebuildProfileIndexes(ctx context.Context, username string) (int, int, int, bool, error) {
	snapshot, err := s.GetProfileSnapshot(ctx, username)
	if err != nil {
		return 0, 0, 0, false, err
	}
	if snapshot == nil {
		return 0, 0, 0, false, nil
	}
	scan := ScanResult{Metrics: RawMetrics{Username: strings.ToLower(username), Followers: snapshot.Metrics.Followers, TotalStars: snapshot.Metrics.TotalStars}, TopRepos: snapshot.TopRepos, ImpactRepos: snapshot.ImpactRepos, Organizations: snapshot.Organizations}
	if err := s.materializeProfileIndexes(ctx, strings.ToLower(username), scan, snapshot.ScannedAt); err != nil {
		return 0, 0, 0, true, err
	}
	graph := ExtractRepoGraph(scan)
	return len(ExtractDeveloperFacets(scan)), len(graph.Nodes), len(graph.Links), true, nil
}

func adminBackfillOptions(request *http.Request) (limit, offset int, dry bool) {
	limit = boundedQueryInt(request, "limit", 500, 1, 2000)
	offset = boundedQueryInt(request, "offset", 0, 0, int(^uint(0)>>1))
	dry = request.URL.Query().Get("dry") == "1"
	return
}

func (s *APIServer) adminBackfillIndexes(w http.ResponseWriter, request *http.Request) {
	if !s.authorized(request) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	store, ok := s.scores.(AdminBackfillStore)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "storage_unavailable"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	limit, offset, dry := adminBackfillOptions(request)
	usernames, err := store.ListSnapshotUsernames(request.Context(), limit, offset)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "storage_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	written, empty, failed, repos, links := 0, 0, 0, 0, 0
	errors := []map[string]string{}
	for _, username := range usernames {
		if dry {
			written++
			continue
		}
		facets, repoCount, linkCount, found, err := store.RebuildProfileIndexes(request.Context(), username)
		_ = facets
		if err != nil {
			failed++
			if len(errors) < 20 {
				errors = append(errors, map[string]string{"username": username, "error": err.Error()})
			}
			continue
		}
		if !found {
			empty++
			continue
		}
		written++
		repos += repoCount
		links += linkCount
	}
	response := map[string]any{"dryRun": dry, "processed": len(usernames), "written": written, "empty": empty, "failed": failed, "offset": offset, "nextOffset": nil, "errors": errors}
	if strings.HasSuffix(request.URL.Path, "/backfill-repos") {
		response["repoCount"], response["linkCount"] = repos, links
	}
	if len(usernames) == limit {
		response["nextOffset"] = offset + limit
	}
	writeJSON(w, http.StatusOK, response, map[string]string{"Cache-Control": "no-store"})
}

// adminBackfillScores deliberately requires an explicit future durable-scan
// migration. Serving a successful-looking partial recomputation would violate
// canonical provenance; operators must use the Go scan worker until that
// bounded cursor job is added.
func (s *APIServer) adminBackfillScores(w http.ResponseWriter, request *http.Request) {
	if !s.authorized(request) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	writeJSON(w, http.StatusConflict, map[string]any{"error": "backfill_paused", "paused": true}, map[string]string{"Cache-Control": "no-store"})
}

func (s *APIServer) adminBackfillProfiles(w http.ResponseWriter, request *http.Request) {
	if !s.authorized(request) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	if s.leaderboards == nil || s.scanPublisher == nil || s.statuses == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "storage_unavailable"}, map[string]string{"Cache-Control": "no-store"})
		return
	}
	topN := boundedQueryInt(request, "topN", 200, 1, 500)
	offset := boundedQueryInt(request, "offset", 0, 0, int(^uint(0)>>1))
	dry, refresh := request.URL.Query().Get("dry") == "1", request.URL.Query().Get("refresh") == "1"
	byScore, errScore := s.leaderboards.GetLeaderboard(request.Context(), "score", "all")
	byHeat, errHeat := s.leaderboards.GetLeaderboard(request.Context(), "heat", "all")
	if errScore != nil || errHeat != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "storage_unavailable"}, map[string]string{"Cache-Control": "no-store", "Retry-After": "15"})
		return
	}
	seen, candidates := map[string]bool{}, []string{}
	for _, entry := range append(byScore[:minInt(topN, len(byScore))], byHeat[:minInt(topN, len(byHeat))]...) {
		if !seen[entry.Username] {
			seen[entry.Username] = true
			candidates = append(candidates, entry.Username)
		}
	}
	if offset > len(candidates) {
		offset = len(candidates)
	}
	batch := candidates[offset:]
	profileStore, _ := s.scores.(ProfileStore)
	queued, skipped, failed := 0, 0, 0
	for _, username := range batch {
		if !refresh && profileStore != nil {
			snapshot, err := profileStore.GetProfileSnapshot(request.Context(), username)
			if err != nil {
				failed++
				continue
			}
			if snapshot != nil {
				skipped++
				continue
			}
		}
		if dry {
			queued++
			continue
		}
		id, err := NewJobID()
		if err != nil {
			failed++
			continue
		}
		now := s.clock().UTC()
		if err := s.statuses.Put(request.Context(), JobStatus{ID: id, Kind: ScanJobKind, Username: strings.ToLower(username), State: JobQueued, CreatedAt: now, UpdatedAt: now}); err != nil {
			failed++
			continue
		}
		if err := s.scanPublisher.PublishScan(request.Context(), ScanJob{ID: id, Username: strings.ToLower(username), RequestedAt: now.UnixMilli()}); err != nil {
			failed++
			continue
		}
		queued++
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"dryRun": dry, "refresh": refresh, "candidates": len(candidates), "processed": len(batch), "queued": queued, "skipped": skipped, "failed": failed, "offset": offset}, map[string]string{"Cache-Control": "no-store"})
}

var _ AdminBackfillStore = (*TursoStore)(nil)
