package backend

import (
	"context"
	"database/sql"
)

// FeedProjectIdentity is private snapshot provenance, never a public project field.
// Both fields are required: an assessment can be reprojected without changing its ID.
type FeedProjectIdentity struct {
	RepoKey    string `json:"repoKey"`
	AnalysisID string `json:"analysisId"`
	SourceHash string `json:"sourceHash"`
}

// FeedSnapshotCatalogStore deliberately does not fall back to legacy key-only
// availability. A portable runtime must pair with an identity-aware adapter.
type FeedSnapshotCatalogStore interface {
	AvailableFeedProjects(context.Context, int64, []FeedProjectIdentity) (map[string]bool, error)
}

func feedProjectIdentities(items []FeedRankedItem) []FeedProjectIdentity {
	out := make([]FeedProjectIdentity, 0, len(items))
	for _, item := range items {
		p := item.Project
		out = append(out, FeedProjectIdentity{p.RepoKey, p.AnalysisID, p.SourceHash})
	}
	return out
}
func validateFeedProjectIdentities(items []FeedProjectIdentity) (map[string]FeedProjectIdentity, error) {
	if len(items) > 240 {
		return nil, ErrFeedCatalogChanged
	}
	out := make(map[string]FeedProjectIdentity, len(items))
	for _, p := range items {
		if p.RepoKey == "" || p.AnalysisID == "" || p.SourceHash == "" || len(p.AnalysisID) > 160 || len(p.SourceHash) > 256 {
			return nil, ErrFeedCatalogChanged
		}
		if _, exists := out[p.RepoKey]; exists {
			return nil, ErrFeedCatalogChanged
		}
		out[p.RepoKey] = p
	}
	return out, nil
}
func (s *CFFeedStore) AvailableFeedProjects(ctx context.Context, id int64, identities []FeedProjectIdentity) (map[string]bool, error) {
	if _, err := validateFeedProjectIdentities(identities); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(identities))
	for _, p := range identities {
		keys = append(keys, p.RepoKey)
	}
	var out FeedBridgeAvailableResponse
	err := s.call(ctx, "projects.available", FeedBridgeAvailableRequest{GitHubID: id, RepoKeys: keys, Identities: identities}, &out)
	return out.Available, err
}
func (s *PostgresFeedStore) AvailableFeedProjects(ctx context.Context, id int64, identities []FeedProjectIdentity) (map[string]bool, error) {
	expected, err := validateFeedProjectIdentities(identities)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(identities))
	for _, p := range identities {
		keys = append(keys, p.RepoKey)
	}
	rows, err := s.db.QueryContext(ctx, feedSnapshotAvailableSQL(), keys, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]bool, len(keys))
	for rows.Next() {
		var p FeedProjectIdentity
		var analysis, hash sql.NullString
		if err := rows.Scan(&p.RepoKey, &analysis, &hash); err != nil {
			return nil, err
		}
		p.AnalysisID, p.SourceHash = analysis.String, hash.String
		if p == expected[p.RepoKey] {
			out[p.RepoKey] = true
		}
	}
	return out, rows.Err()
}

func guardFeedSnapshotTx(ctx context.Context, tx *sql.Tx, record FeedRequestRecord) error {
	identities := feedProjectIdentities(record.Items)
	expected, err := validateFeedProjectIdentities(identities)
	if err != nil {
		return err
	}
	keys := make([]string, 0, len(identities))
	for _, p := range identities {
		keys = append(keys, p.RepoKey)
	}
	// Stable row locks serialize projection updates against the final request and
	// served-item commit, including an idempotent request retry.
	rows, err := tx.QueryContext(ctx, `SELECT repo_key,analysis_id,source_hash FROM feed.projects WHERE repo_key=ANY($1) ORDER BY repo_key FOR SHARE`, keys)
	if err != nil {
		return err
	}
	matched := 0
	for rows.Next() {
		var p FeedProjectIdentity
		var analysis, hash sql.NullString
		if err := rows.Scan(&p.RepoKey, &analysis, &hash); err != nil {
			rows.Close()
			return err
		}
		p.AnalysisID, p.SourceHash = analysis.String, hash.String
		if p == expected[p.RepoKey] {
			matched++
		}
	}
	err = rows.Err()
	closeErr := rows.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if matched != len(keys) {
		return ErrFeedCatalogChanged
	}
	var eligible int
	if err := tx.QueryRowContext(ctx, feedSnapshotEligibleSQL(), keys, record.User.GitHubID).Scan(&eligible); err != nil {
		return err
	}
	if eligible != len(keys) {
		return ErrFeedCatalogChanged
	}
	return nil
}

var _ FeedSnapshotCatalogStore = (*CFFeedStore)(nil)
var _ FeedSnapshotCatalogStore = (*PostgresFeedStore)(nil)
