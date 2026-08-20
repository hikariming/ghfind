package backend

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type FeedTagReviewInput struct {
	ProposalID     string `json:"proposalId"`
	Action         string `json:"action"`
	CanonicalTagID string `json:"canonicalTagId,omitempty"`
	Operator       string `json:"operator"`
	Reason         string `json:"reason"`
}

type FeedTagReviewResult struct {
	ProposalID      string `json:"proposalId"`
	Status          string `json:"status"`
	CanonicalTagID  string `json:"canonicalTagId,omitempty"`
	TaxonomyVersion int64  `json:"taxonomyVersion"`
}

type FeedGorseRebuildInput struct {
	Operator string `json:"operator"`
	Reason   string `json:"reason"`
}

type FeedGorseRebuildResult struct {
	RebuildID string `json:"rebuildId"`
	Deletions int64  `json:"deletions"`
	Projects  int64  `json:"projects"`
	Users     int64  `json:"users"`
	Events    int64  `json:"events"`
}

type FeedProjectModerationInput struct {
	RepoKey  string `json:"repoKey"`
	Action   string `json:"action"`
	Enabled  *bool  `json:"enabled,omitempty"`
	Operator string `json:"operator"`
	Reason   string `json:"reason"`
}

type FeedProjectModerationResult struct {
	RepoKey           string `json:"repoKey"`
	Action            string `json:"action"`
	Changed           bool   `json:"changed"`
	Publishable       bool   `json:"publishable"`
	AdminRemoved      bool   `json:"adminRemoved"`
	RiskOverride      bool   `json:"riskOverride"`
	ProjectionVersion int64  `json:"projectionVersion"`
}

type FeedAdminStore interface {
	ReviewFeedTagProposal(context.Context, FeedTagReviewInput) (FeedTagReviewResult, error)
	QueueFullGorseRebuild(context.Context, FeedGorseRebuildInput) (FeedGorseRebuildResult, error)
	ModerateFeedProject(context.Context, FeedProjectModerationInput) (FeedProjectModerationResult, error)
}

func (s *PostgresFeedStore) ModerateFeedProject(ctx context.Context, input FeedProjectModerationInput) (FeedProjectModerationResult, error) {
	normalized, err := NormalizeGitHubRepository(input.RepoKey)
	if err != nil {
		return FeedProjectModerationResult{}, fmt.Errorf("invalid repository: %w", err)
	}
	input.RepoKey = strings.ToLower(normalized.RepoKey)
	input.Action = strings.ToLower(strings.TrimSpace(input.Action))
	input.Operator = strings.TrimSpace(input.Operator)
	input.Reason = strings.TrimSpace(input.Reason)
	if input.Operator == "" || input.Reason == "" || (input.Action != "risk_override" && input.Action != "remove" && input.Action != "restore") {
		return FeedProjectModerationResult{}, fmt.Errorf("valid action, operator, and reason are required")
	}
	if input.Action == "risk_override" && input.Enabled == nil {
		return FeedProjectModerationResult{}, fmt.Errorf("enabled is required for risk_override")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return FeedProjectModerationResult{}, err
	}
	defer tx.Rollback() //nolint:errcheck
	var blockedReason string
	var overrideEligible, currentOverride, currentRemoved, currentPublishable bool
	var currentVersion int64
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(blocked_reason,''),risk_override_eligible,admin_override,
	  admin_removed,publishable,projection_version FROM feed.projects WHERE repo_key=$1 FOR UPDATE`, input.RepoKey).
		Scan(&blockedReason, &overrideEligible, &currentOverride, &currentRemoved, &currentPublishable, &currentVersion)
	if errors.Is(err, sql.ErrNoRows) {
		return FeedProjectModerationResult{}, ErrFeedProjectNotFound
	}
	if err != nil {
		return FeedProjectModerationResult{}, err
	}
	nextOverride, nextRemoved := currentOverride, currentRemoved
	switch input.Action {
	case "risk_override":
		if *input.Enabled && !overrideEligible {
			return FeedProjectModerationResult{}, fmt.Errorf("only high-risk blocking categories are override eligible")
		}
		nextOverride = *input.Enabled
	case "remove":
		nextRemoved = true
	case "restore":
		nextRemoved = false
	}
	nextPublishable := !nextRemoved && (blockedReason == "" || (nextOverride && overrideEligible))
	changed := nextOverride != currentOverride || nextRemoved != currentRemoved || nextPublishable != currentPublishable
	result := FeedProjectModerationResult{RepoKey: input.RepoKey, Action: input.Action, Changed: changed,
		Publishable: nextPublishable, AdminRemoved: nextRemoved, RiskOverride: nextOverride, ProjectionVersion: currentVersion}
	if !changed {
		return result, nil
	}
	err = tx.QueryRowContext(ctx, `UPDATE feed.projects SET admin_override=$2,admin_removed=$3,publishable=$4,
	  projection_version=projection_version+1,projected_at=now(),updated_at=now() WHERE repo_key=$1
	  RETURNING projection_version`, input.RepoKey, nextOverride, nextRemoved, nextPublishable).Scan(&result.ProjectionVersion)
	if err != nil {
		return FeedProjectModerationResult{}, err
	}
	actionID, err := NewFeedID("moderation")
	if err != nil {
		return FeedProjectModerationResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO feed.project_moderation_actions
	  (id,repo_key,action,enabled,operator,reason,projection_version) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		actionID, input.RepoKey, input.Action, input.Enabled, input.Operator, input.Reason, result.ProjectionVersion); err != nil {
		return FeedProjectModerationResult{}, fmt.Errorf("audit Feed project moderation: %w", err)
	}
	payload, _ := json.Marshal(map[string]any{"repoKey": input.RepoKey, "publishable": nextPublishable, "projectionVersion": result.ProjectionVersion})
	if _, err := tx.ExecContext(ctx, `INSERT INTO feed.event_outbox(aggregate_key,topic,payload,dedupe_key)
	  VALUES ($1,'feed.project-sync.v1',$2::jsonb,$3) ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
		input.RepoKey, string(payload), fmt.Sprintf("project-sync:%s:%d", input.RepoKey, result.ProjectionVersion)); err != nil {
		return FeedProjectModerationResult{}, fmt.Errorf("queue Feed project moderation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return FeedProjectModerationResult{}, err
	}
	return result, nil
}

// QueueFullGorseRebuild creates a point-in-time, repeatable replay from Feed's
// business facts. Gorse may be wiped before invoking this method: project and
// user upserts are queued before feedback, and feedback uses overwrite
// semantics. A unique rebuild ID prevents this replay from colliding with the
// normal outbox dedupe keys.
func (s *PostgresFeedStore) QueueFullGorseRebuild(ctx context.Context, input FeedGorseRebuildInput) (FeedGorseRebuildResult, error) {
	input.Operator = strings.TrimSpace(input.Operator)
	input.Reason = strings.TrimSpace(input.Reason)
	if input.Operator == "" || input.Reason == "" {
		return FeedGorseRebuildResult{}, fmt.Errorf("operator and reason are required")
	}
	rebuildID, err := NewFeedID("gorse_rebuild")
	if err != nil {
		return FeedGorseRebuildResult{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return FeedGorseRebuildResult{}, err
	}
	defer tx.Rollback() //nolint:errcheck
	result := FeedGorseRebuildResult{RebuildID: rebuildID}
	deletionResult, err := tx.ExecContext(ctx, `INSERT INTO feed.event_outbox(aggregate_key,topic,payload,dedupe_key)
		SELECT gorse_user_id,'feed.user-delete.v1',jsonb_build_object(
		  'deletionId',deletion_id,'gorseUserId',gorse_user_id,'requestedAt',requested_at),$1 || ':delete:' || deletion_id
		FROM feed.user_deletion_tombstones ORDER BY requested_at,deletion_id`, rebuildID)
	if err != nil {
		return FeedGorseRebuildResult{}, fmt.Errorf("queue Gorse user deletions: %w", err)
	}
	result.Deletions, _ = deletionResult.RowsAffected()
	projectResult, err := tx.ExecContext(ctx, `INSERT INTO feed.event_outbox(aggregate_key,topic,payload,dedupe_key)
		SELECT repo_key,'feed.project-sync.v1',jsonb_build_object('repoKey',repo_key),$1 || ':project:' || repo_key
		FROM feed.projects ORDER BY repo_key`, rebuildID)
	if err != nil {
		return FeedGorseRebuildResult{}, fmt.Errorf("queue Gorse project rebuild: %w", err)
	}
	result.Projects, _ = projectResult.RowsAffected()
	userResult, err := tx.ExecContext(ctx, `INSERT INTO feed.event_outbox(aggregate_key,topic,payload,dedupe_key)
		SELECT 'gh:' || github_id,'feed.profile-rebuild.v1',jsonb_build_object('githubId',github_id),$1 || ':user:' || github_id
		FROM feed.users ORDER BY github_id`, rebuildID)
	if err != nil {
		return FeedGorseRebuildResult{}, fmt.Errorf("queue Gorse user rebuild: %w", err)
	}
	result.Users, _ = userResult.RowsAffected()
	eventResult, err := tx.ExecContext(ctx, `INSERT INTO feed.event_outbox(event_id,aggregate_key,topic,payload,dedupe_key)
		SELECT NULL,'gh:' || github_id,'feed.event-project.v1',jsonb_build_object(
		  'eventId',id,'githubId',github_id,'repoKey',repo_key,'type',event_type,
		  'occurredAt',occurred_at,'metadata',metadata),$1 || ':event:' || id
		FROM feed.events ORDER BY received_at,id`, rebuildID)
	if err != nil {
		return FeedGorseRebuildResult{}, fmt.Errorf("queue Gorse feedback rebuild: %w", err)
	}
	result.Events, _ = eventResult.RowsAffected()
	audit, _ := json.Marshal(map[string]any{
		"rebuildId": rebuildID, "operator": input.Operator, "reason": input.Reason,
		"deletions": result.Deletions, "projects": result.Projects, "users": result.Users, "events": result.Events,
	})
	if _, err := tx.ExecContext(ctx, `INSERT INTO feed.projection_cursors(projection,cursor_value,source_timestamp,consecutive_clean_runs)
		VALUES ('gorse-full-rebuild',$1,now(),0) ON CONFLICT(projection) DO UPDATE SET
		cursor_value=excluded.cursor_value,source_timestamp=excluded.source_timestamp,
		consecutive_clean_runs=0,updated_at=now()`, string(audit)); err != nil {
		return FeedGorseRebuildResult{}, fmt.Errorf("audit Gorse rebuild: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return FeedGorseRebuildResult{}, err
	}
	return result, nil
}

func (s *PostgresFeedStore) ReviewFeedTagProposal(ctx context.Context, input FeedTagReviewInput) (FeedTagReviewResult, error) {
	input.ProposalID = strings.TrimSpace(input.ProposalID)
	input.Action = strings.ToLower(strings.TrimSpace(input.Action))
	input.CanonicalTagID = strings.TrimSpace(input.CanonicalTagID)
	input.Operator = strings.TrimSpace(input.Operator)
	input.Reason = strings.TrimSpace(input.Reason)
	if input.ProposalID == "" || input.Operator == "" || input.Reason == "" ||
		(input.Action != "create" && input.Action != "map" && input.Action != "reject") {
		return FeedTagReviewResult{}, fmt.Errorf("proposal, action, operator, and reason are required")
	}
	if input.Action == "map" && input.CanonicalTagID == "" {
		return FeedTagReviewResult{}, fmt.Errorf("canonicalTagId is required for map")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return FeedTagReviewResult{}, err
	}
	defer tx.Rollback() //nolint:errcheck
	var namespace, slug, labelZH, labelEN, status, proposalSource, sourceRef string
	var evidence []byte
	err = tx.QueryRowContext(ctx, `SELECT namespace,slug,label_zh,label_en,status,source,source_ref,evidence_ids
	  FROM feed.tag_proposals WHERE id=$1 FOR UPDATE`, input.ProposalID).
		Scan(&namespace, &slug, &labelZH, &labelEN, &status, &proposalSource, &sourceRef, &evidence)
	if errors.Is(err, sql.ErrNoRows) {
		return FeedTagReviewResult{}, ErrFeedProjectNotFound
	}
	if err != nil {
		return FeedTagReviewResult{}, err
	}
	if status != "proposed" {
		return FeedTagReviewResult{}, fmt.Errorf("proposal has already been resolved")
	}
	var currentVersion int64
	if err := tx.QueryRowContext(ctx, `SELECT version FROM feed.taxonomy_versions WHERE state='active' FOR UPDATE`).Scan(&currentVersion); err != nil {
		return FeedTagReviewResult{}, err
	}
	newVersion := currentVersion + 1
	if _, err := tx.ExecContext(ctx, `UPDATE feed.taxonomy_versions SET state='retired' WHERE version=$1`, currentVersion); err != nil {
		return FeedTagReviewResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO feed.taxonomy_versions(version,state,activated_at,note)
      VALUES ($1,'active',now(),$2)`, newVersion, input.Action+" proposal "+input.ProposalID+": "+input.Reason); err != nil {
		return FeedTagReviewResult{}, err
	}

	canonicalID := input.CanonicalTagID
	resolvedStatus := "mapped"
	switch input.Action {
	case "create":
		canonicalID = namespace + ":" + slug
		if _, err := tx.ExecContext(ctx, `INSERT INTO feed.tag_definitions
          (id,namespace,slug,label_zh,label_en,description,status,taxonomy_version)
          VALUES ($1,$2,$3,$4,$5,'','canonical',$6)`, canonicalID, namespace, slug, labelZH, labelEN, newVersion); err != nil {
			return FeedTagReviewResult{}, fmt.Errorf("create canonical Feed tag: %w", err)
		}
	case "map":
		var canonicalNamespace string
		if err := tx.QueryRowContext(ctx, `SELECT namespace FROM feed.tag_definitions WHERE id=$1 AND status='canonical'`, canonicalID).Scan(&canonicalNamespace); err != nil {
			return FeedTagReviewResult{}, fmt.Errorf("canonical Feed tag does not exist: %w", err)
		}
		if canonicalNamespace != namespace {
			return FeedTagReviewResult{}, fmt.Errorf("proposal and canonical tag namespaces differ")
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO feed.tag_aliases(namespace,alias_slug,canonical_tag_id,taxonomy_version)
          VALUES ($1,$2,$3,$4) ON CONFLICT (namespace,alias_slug) DO UPDATE SET
          canonical_tag_id=excluded.canonical_tag_id,taxonomy_version=excluded.taxonomy_version`, namespace, slug, canonicalID, newVersion); err != nil {
			return FeedTagReviewResult{}, err
		}
	case "reject":
		resolvedStatus, canonicalID = "rejected", ""
	}
	var nullableCanonical any
	if canonicalID != "" {
		nullableCanonical = canonicalID
	}
	if _, err := tx.ExecContext(ctx, `UPDATE feed.tag_proposals SET status=$2,canonical_tag_id=$3,
      resolved_by=$4,resolution_reason=$5,taxonomy_version=$6,resolved_at=now() WHERE id=$1`,
		input.ProposalID, resolvedStatus, nullableCanonical, input.Operator, input.Reason, newVersion); err != nil {
		return FeedTagReviewResult{}, err
	}
	if canonicalID != "" {
		var analysisID string
		var confidence float64
		err := tx.QueryRowContext(ctx, `SELECT analysis_id,confidence FROM feed.projects WHERE repo_key=$1 FOR UPDATE`, sourceRef).
			Scan(&analysisID, &confidence)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return FeedTagReviewResult{}, err
		}
		if err == nil {
			tagSource := "editor"
			switch proposalSource {
			case "agent":
				tagSource = "agent"
			case "owner":
				tagSource = "owner"
			}
			confidence = clampRange(confidence/100, 0, 1)
			if _, err := tx.ExecContext(ctx, `INSERT INTO feed.project_tags
			  (repo_key,tag_id,source,weight,confidence,evidence_ids,analysis_id,taxonomy_version)
			  VALUES ($1,$2,$3,1,$4,$5::jsonb,$6,$7)
			  ON CONFLICT(repo_key,tag_id,source) DO UPDATE SET weight=1,confidence=excluded.confidence,
			    evidence_ids=excluded.evidence_ids,analysis_id=excluded.analysis_id,taxonomy_version=excluded.taxonomy_version,updated_at=now()`,
				sourceRef, canonicalID, tagSource, confidence, string(evidence), analysisID, newVersion); err != nil {
				return FeedTagReviewResult{}, fmt.Errorf("activate reviewed Feed tag: %w", err)
			}
			if err := refreshFeedProjectDescriptorTx(ctx, tx, sourceRef); err != nil {
				return FeedTagReviewResult{}, err
			}
			var projectionVersion int64
			if err := tx.QueryRowContext(ctx, `UPDATE feed.projects SET projection_version=projection_version+1,
			  projected_at=now(),updated_at=now() WHERE repo_key=$1 RETURNING projection_version`, sourceRef).Scan(&projectionVersion); err != nil {
				return FeedTagReviewResult{}, err
			}
			payload, _ := json.Marshal(map[string]any{"repoKey": sourceRef, "taxonomyVersion": newVersion, "projectionVersion": projectionVersion})
			if _, err := tx.ExecContext(ctx, `INSERT INTO feed.event_outbox(aggregate_key,topic,payload,dedupe_key)
			  VALUES ($1,'feed.project-sync.v1',$2::jsonb,$3) ON CONFLICT(dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
				sourceRef, string(payload), fmt.Sprintf("project-sync:%s:%d", sourceRef, projectionVersion)); err != nil {
				return FeedTagReviewResult{}, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return FeedTagReviewResult{}, err
	}
	return FeedTagReviewResult{ProposalID: input.ProposalID, Status: resolvedStatus, CanonicalTagID: canonicalID, TaxonomyVersion: newVersion}, nil
}

func (s *APIServer) reconcileFeedProjects(w http.ResponseWriter, request *http.Request) {
	if !s.authorized(request) && !s.reconcileAuthorized(request) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"}, noStoreHeaders())
		return
	}
	if !s.config.FeedMode.Enabled() || s.feed == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	source, ok := s.scores.(FeedProjectSource)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_source_unavailable"}, feedUnavailableHeaders())
		return
	}
	reconciler := NewFeedProjectReconciler(source, s.feed, nil)
	ctx, cancel := context.WithTimeout(request.Context(), 2*time.Minute)
	defer cancel()
	result, err := reconciler.Reconcile(ctx)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_reconcile_failed"}, feedUnavailableHeaders())
		return
	}
	writeJSON(w, http.StatusOK, result, noStoreHeaders())
}

func (s *APIServer) reviewFeedTagProposal(w http.ResponseWriter, request *http.Request) {
	if !s.authorized(request) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"}, noStoreHeaders())
		return
	}
	admin, ok := s.feed.(FeedAdminStore)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	var input FeedTagReviewInput
	if err := decodeFeedJSON(request, &input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_body"}, noStoreHeaders())
		return
	}
	result, err := admin.ReviewFeedTagProposal(request.Context(), input)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_tag_review", "message": err.Error()}, noStoreHeaders())
		return
	}
	writeJSON(w, http.StatusOK, result, noStoreHeaders())
}

func (s *APIServer) rebuildFeedGorse(w http.ResponseWriter, request *http.Request) {
	if !s.authorized(request) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"}, noStoreHeaders())
		return
	}
	if s.config.FeedMode != FeedModeGorseShadow && s.config.FeedMode != FeedModeGorseCanary {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "gorse_disabled"}, feedUnavailableHeaders())
		return
	}
	admin, ok := s.feed.(FeedAdminStore)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	var input FeedGorseRebuildInput
	if err := decodeFeedJSON(request, &input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_body"}, noStoreHeaders())
		return
	}
	result, err := admin.QueueFullGorseRebuild(request.Context(), input)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "gorse_rebuild_rejected", "message": err.Error()}, noStoreHeaders())
		return
	}
	writeJSON(w, http.StatusAccepted, result, noStoreHeaders())
}

func (s *APIServer) moderateFeedProject(w http.ResponseWriter, request *http.Request) {
	if !s.authorized(request) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"}, noStoreHeaders())
		return
	}
	admin, ok := s.feed.(FeedAdminStore)
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "feed_unavailable"}, feedUnavailableHeaders())
		return
	}
	var input FeedProjectModerationInput
	if err := decodeFeedJSON(request, &input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_body"}, noStoreHeaders())
		return
	}
	result, err := admin.ModerateFeedProject(request.Context(), input)
	if errors.Is(err, ErrFeedProjectNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "feed_project_not_found"}, noStoreHeaders())
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "project_moderation_rejected", "message": err.Error()}, noStoreHeaders())
		return
	}
	writeJSON(w, http.StatusOK, result, noStoreHeaders())
}

var _ FeedAdminStore = (*PostgresFeedStore)(nil)
