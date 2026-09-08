package backend

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

// taxonomy.propose creates a proposed tag and command receipt atomically; it
// never resolves aliases or promotes canonical status on behalf of a user.
type FeedTagProposalInput struct {
	ID        string   `json:"id"`
	RepoKey   string   `json:"repoKey"`
	Namespace string   `json:"namespace"`
	Slug      string   `json:"slug"`
	LabelZH   string   `json:"labelZh"`
	LabelEN   string   `json:"labelEn"`
	Evidence  []string `json:"evidence"`
}
type FeedTagProposalRequest struct {
	FeedMutationFence
	GitHubID int64 `json:"githubId"`
	FeedTagProposalInput
}
type FeedTagProposalResult struct {
	ProposalID string `json:"proposalId"`
	Status     string `json:"status"`
}
type FeedTagProposalStore interface {
	ProposeFeedTag(context.Context, int64, FeedTagProposalInput) (FeedTagProposalResult, error)
}

var proposalSlugPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
var ErrFeedProposalConflict = errors.New("feed proposal command conflict")

func validateFeedTagProposal(input *FeedTagProposalInput) error {
	input.RepoKey = strings.ToLower(strings.TrimSpace(input.RepoKey))
	if !feedEventIDPattern.MatchString(input.ID) || !isFeedTagNamespace(input.Namespace) || len(input.Slug) > 80 || !proposalSlugPattern.MatchString(input.Slug) || len(input.LabelZH) > 160 || len(input.LabelEN) > 160 || (strings.TrimSpace(input.LabelZH) == "" && strings.TrimSpace(input.LabelEN) == "") || len(input.Evidence) < 1 || len(input.Evidence) > 16 {
		return errors.New("invalid tag proposal")
	}
	if _, err := NormalizeGitHubRepository(input.RepoKey); err != nil {
		return err
	}
	for _, evidence := range input.Evidence {
		if strings.TrimSpace(evidence) == "" || len(evidence) > 256 {
			return errors.New("invalid proposal evidence")
		}
	}
	return nil
}
func (s *APIServer) proposeFeedTag(w http.ResponseWriter, r *http.Request) {
	identity, ok := s.feedPrincipal(w, r)
	if !ok {
		return
	}
	store, ok := s.feed.(FeedTagProposalStore)
	if !ok {
		writeJSON(w, 503, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	var input FeedTagProposalInput
	if decodeFeedJSON(r, &input) != nil || validateFeedTagProposal(&input) != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid_proposal"}, noStoreHeaders())
		return
	}
	user, err := s.feed.EnsureFeedUser(r.Context(), *identity)
	if err != nil || user == nil {
		writeJSON(w, 503, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	result, err := store.ProposeFeedTag(withFeedProfileVersion(r.Context(), user.ProfileVersion), identity.GitHubID, input)
	if err != nil {
		if writeFeedMutationError(w, err) {
			return
		}
		if errors.Is(err, ErrFeedProjectNotFound) {
			writeJSON(w, 404, map[string]string{"error": "project_not_found"}, noStoreHeaders())
			return
		}
		if errors.Is(err, ErrFeedProposalConflict) {
			writeJSON(w, 409, map[string]string{"error": "proposal_id_conflict"}, noStoreHeaders())
			return
		}
		writeJSON(w, 503, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	writeJSON(w, 202, result, noStoreHeaders())
}
func (s *CFFeedStore) ProposeFeedTag(ctx context.Context, id int64, input FeedTagProposalInput) (FeedTagProposalResult, error) {
	var out FeedTagProposalResult
	if err := validateFeedTagProposal(&input); err != nil {
		return out, err
	}
	err := s.call(ctx, "taxonomy.propose", FeedTagProposalRequest{FeedMutationFence: s.fence(ctx, 0), GitHubID: id, FeedTagProposalInput: input}, &out)
	return out, err
}
func (s *PostgresFeedStore) ProposeFeedTag(ctx context.Context, id int64, input FeedTagProposalInput) (FeedTagProposalResult, error) {
	var out FeedTagProposalResult
	if err := validateFeedTagProposal(&input); err != nil {
		return out, err
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return out, err
	}
	digest := sha256.Sum256(encoded)
	hash := fmt.Sprintf("%x", digest)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	if err := s.guardFeedWrite(ctx, tx, id, 0); err != nil {
		return out, err
	}
	var storedHash string
	err = tx.QueryRowContext(ctx, `SELECT r.payload_hash,p.id,p.status FROM feed.tag_proposal_commands r JOIN feed.tag_proposals p ON p.id=r.proposal_id WHERE r.github_id=$1 AND r.command_id=$2`, id, input.ID).Scan(&storedHash, &out.ProposalID, &out.Status)
	if err == nil {
		if storedHash != hash {
			return out, ErrFeedProposalConflict
		}
		return out, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return out, err
	}
	var analysisID string
	err = tx.QueryRowContext(ctx, `SELECT analysis_id FROM feed.projects WHERE repo_key=$1 FOR SHARE`, input.RepoKey).Scan(&analysisID)
	if errors.Is(err, sql.ErrNoRows) {
		return out, ErrFeedProjectNotFound
	}
	if err != nil {
		return out, err
	}
	evidence, _ := json.Marshal(input.Evidence)
	proposalID, err := NewFeedID("proposal")
	if err != nil {
		return out, err
	}
	err = tx.QueryRowContext(ctx, `INSERT INTO feed.tag_proposals(id,namespace,slug,label_zh,label_en,source,source_ref,evidence_ids,status,taxonomy_version,analysis_id,namespace_inferred)
 VALUES($1,$2,$3,$4,$5,'user',$6,$7::jsonb,'proposed',(SELECT version FROM feed.taxonomy_versions WHERE state='active'),$8,false)
 ON CONFLICT(namespace,slug,source,source_ref,analysis_id) DO UPDATE SET id=feed.tag_proposals.id RETURNING id,status`, proposalID, input.Namespace, input.Slug, input.LabelZH, input.LabelEN, input.RepoKey, string(evidence), analysisID).Scan(&out.ProposalID, &out.Status)
	if err != nil {
		return out, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO feed.tag_proposal_commands(github_id,command_id,proposal_id,payload_hash) VALUES($1,$2,$3,$4)`, id, input.ID, out.ProposalID, hash); err != nil {
		return out, err
	}
	return out, tx.Commit()
}
