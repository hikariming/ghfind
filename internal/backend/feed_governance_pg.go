package backend

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

type govQuery interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func govSource(kind string) string {
	if kind == "assessment" {
		return "agent"
	}
	return "user"
}
func readGovProposal(ctx context.Context, q govQuery, input FeedGovernanceTarget, lock bool) (*FeedGovernanceProposal, []byte, error) {
	out := &FeedGovernanceProposal{FeedGovernanceTarget: input}
	var evidence []byte
	query := `SELECT q.source_ref,q.analysis_id,q.namespace,q.slug,q.label_zh,q.label_en,q.evidence_ids,q.status,q.resolved_by,q.resolution_reason,p.analysis_id,
 COALESCE(p.analysis_id=q.analysis_id AND NOT p.admin_removed AND EXISTS(SELECT 1 FROM feed.project_submission_evidence e WHERE e.repo_key=p.repo_key AND e.analysis_id=p.analysis_id AND e.revoked_at IS NULL),false),
 (SELECT version FROM feed.taxonomy_versions WHERE state='active')
 FROM feed.tag_proposals q LEFT JOIN feed.projects p ON p.repo_key=q.source_ref WHERE q.id=$1 AND q.source=$2`
	if lock {
		query += ` FOR UPDATE OF q`
	}
	err := q.QueryRowContext(ctx, query, input.ProposalID, govSource(input.ProposalKind)).Scan(&out.RepoKey, &out.AnalysisID, &out.Namespace, &out.Slug, &out.LabelZH, &out.LabelEN, &evidence, &out.Status, &out.ReviewedBy, &out.ReviewReason, &out.CurrentAnalysisID, &out.CurrentEvidence, &out.TaxonomyVersion)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	if err = json.Unmarshal(evidence, &out.Evidence); err != nil || out.Evidence == nil || len(out.Evidence) > 64 {
		return nil, nil, govConflict("governance_evidence_invalid")
	}
	for _, e := range out.Evidence {
		if !govText(e, 0, 256) {
			return nil, nil, govConflict("governance_evidence_invalid")
		}
	}
	return out, evidence, nil
}
func (s *PostgresFeedStore) InspectFeedGovernanceProposal(ctx context.Context, input FeedGovernanceTarget) (*FeedGovernanceProposal, error) {
	if !validateGovTarget(input) {
		return nil, govError(400, "invalid_request")
	}
	p, _, err := readGovProposal(ctx, s.db, input, false)
	return p, err
}
func readGovCommand(ctx context.Context, q govQuery, id, digest string) (*FeedGovernanceResult, error) {
	var hash string
	var encoded []byte
	err := q.QueryRowContext(ctx, `SELECT payload_hash,result_json FROM feed.governance_commands WHERE command_id=$1`, id).Scan(&hash, &encoded)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if digest != "" && hash != digest {
		return nil, govConflict("governance_command_conflict")
	}
	var out FeedGovernanceResult
	err = json.Unmarshal(encoded, &out)
	return &out, err
}
func (s *PostgresFeedStore) GetFeedGovernanceCommand(ctx context.Context, id string) (*FeedGovernanceResult, error) {
	if !feedEventIDPattern.MatchString(id) {
		return nil, govError(400, "invalid_request")
	}
	return readGovCommand(ctx, s.db, id, "")
}
func (s *PostgresFeedStore) ReviewFeedGovernanceProposal(ctx context.Context, input FeedGovernanceReview) (FeedGovernanceResult, error) {
	if err := validateGovReview(input); err != nil {
		return FeedGovernanceResult{}, err
	}
	digest, err := feedGovernanceDigest(input, "")
	if err != nil {
		return FeedGovernanceResult{}, err
	}
	return s.applyFeedGovernance(ctx, input, input.FeedGovernanceCommand, digest)
}
func (s *PostgresFeedStore) DeprecateFeedGovernanceTag(ctx context.Context, input FeedGovernanceDeprecate) (FeedGovernanceResult, error) {
	if err := validateGovDeprecate(input); err != nil {
		return FeedGovernanceResult{}, err
	}
	digest, err := feedGovernanceDigest(input, "deprecate")
	if err != nil {
		return FeedGovernanceResult{}, err
	}
	// The wire schema has no action; the normalized command has an implicit one.
	logical := FeedGovernanceReview{FeedGovernanceCommand: input.FeedGovernanceCommand, Action: "deprecate", CanonicalTagID: input.CanonicalTagID}
	return s.applyFeedGovernance(ctx, logical, input.FeedGovernanceCommand, digest)
}
func (s *PostgresFeedStore) applyFeedGovernance(ctx context.Context, input FeedGovernanceReview, command FeedGovernanceCommand, digest string) (FeedGovernanceResult, error) {
	var out FeedGovernanceResult
	if old, err := readGovCommand(ctx, s.db, command.CommandID, digest); err != nil {
		return out, err
	} else if old != nil {
		return *old, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	// All portable writes first hold this row FOR SHARE. This exclusive lock
	// makes taxonomy activation and its dependent facts a single visible change.
	var epoch int64
	var enabled bool
	if err = tx.QueryRowContext(ctx, `SELECT writer_epoch,writes_enabled FROM feed.runtime_control WHERE singleton FOR UPDATE`).Scan(&epoch, &enabled); err != nil {
		return out, err
	}
	// Recheck after waiting: an exact retry can become complete while we wait,
	// and its receipt remains valid after epoch/version advancement or deletion.
	if old, err := readGovCommand(ctx, tx, command.CommandID, digest); err != nil {
		return out, err
	} else if old != nil {
		return *old, tx.Commit()
	}
	if !enabled || epoch != command.WriterEpoch || epoch != s.writerEpoch {
		return out, ErrFeedWriterEpoch
	}
	active, err := activeFeedTaxonomyTx(ctx, tx)
	if err != nil {
		return out, err
	}
	if active != command.ExpectedTaxonomyVersion {
		return out, ErrFeedTaxonomyChanged
	}
	change := input.Action != "reject"
	next := active
	if change {
		next++
		if next > feedSafeInteger {
			return out, ErrFeedTaxonomyChanged
		}
	}
	var proposal *FeedGovernanceProposal
	var evidence []byte
	tagID := input.CanonicalTagID
	if input.Action != "deprecate" {
		proposal, evidence, err = readGovProposal(ctx, tx, input.FeedGovernanceTarget, true)
		if err != nil {
			return out, err
		}
		if proposal == nil {
			return out, govError(404, "governance_proposal_not_found")
		}
		if proposal.AnalysisID != input.ExpectedAnalysisID {
			return out, govConflict("governance_proposal_changed")
		}
		if proposal.Status != "proposed" {
			return out, govConflict("governance_not_pending")
		}
		if input.Action != "reject" {
			if !isFeedTagNamespace(proposal.Namespace) || len(proposal.Slug) > 80 || !proposalSlugPattern.MatchString(proposal.Slug) {
				return out, govConflict("governance_proposal_changed")
			}
			if !proposal.CurrentEvidence {
				return out, govConflict("governance_evidence_changed")
			}
			// Hold the single project identity even against older nonportable tools.
			var current string
			var removed bool
			err = tx.QueryRowContext(ctx, `SELECT analysis_id,admin_removed FROM feed.projects WHERE repo_key=$1 FOR UPDATE`, proposal.RepoKey).Scan(&current, &removed)
			if err != nil {
				return out, err
			}
			if current != proposal.AnalysisID || removed {
				return out, govConflict("governance_evidence_changed")
			}
		}
		if input.Action == "create" {
			tagID = proposal.Namespace + ":" + proposal.Slug
		}
	}
	if input.Action == "create" {
		var conflict bool
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM feed.tag_definitions WHERE id=$1 OR (namespace=$2 AND slug=$3)) OR EXISTS(SELECT 1 FROM feed.tag_aliases WHERE namespace=$2 AND alias_slug=$3)`, tagID, proposal.Namespace, proposal.Slug).Scan(&conflict)
		if err != nil {
			return out, err
		}
		if conflict {
			return out, govConflict("governance_tag_conflict")
		}
	} else if input.Action == "map" || input.Action == "deprecate" {
		var namespace, status string
		var definitionVersion int64
		err = tx.QueryRowContext(ctx, `SELECT namespace,status,taxonomy_version FROM feed.tag_definitions WHERE id=$1 FOR UPDATE`, tagID).Scan(&namespace, &status, &definitionVersion)
		if errors.Is(err, sql.ErrNoRows) {
			if input.Action == "deprecate" {
				return out, govConflict("governance_not_pending")
			}
			return out, govConflict("governance_tag_conflict")
		}
		if err != nil {
			return out, err
		}
		if status != "canonical" || definitionVersion > active {
			if input.Action == "deprecate" {
				return out, govConflict("governance_not_pending")
			}
			return out, govConflict("governance_tag_conflict")
		}
		if input.Action == "map" {
			if namespace != proposal.Namespace {
				return out, govConflict("governance_tag_conflict")
			}
			var conflict bool
			err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM feed.tag_aliases WHERE namespace=$1 AND alias_slug=$2 AND canonical_tag_id<>$3) OR EXISTS(SELECT 1 FROM feed.tag_definitions WHERE namespace=$1 AND slug=$2 AND (id<>$3 OR status<>'canonical'))`, namespace, proposal.Slug, tagID).Scan(&conflict)
			if err != nil {
				return out, err
			}
			if conflict {
				return out, govConflict("governance_tag_conflict")
			}
		}
	}
	if input.Action == "create" || input.Action == "map" {
		var count int
		var already bool
		err = tx.QueryRowContext(ctx, `SELECT COUNT(DISTINCT pt.tag_id),COALESCE(bool_or(pt.tag_id=$2),false)
	 FROM feed.project_tags pt JOIN feed.tag_definitions d ON d.id=pt.tag_id AND d.status='canonical' AND d.taxonomy_version<=(SELECT version FROM feed.taxonomy_versions WHERE state='active')
	 JOIN feed.projects p ON p.repo_key=pt.repo_key AND p.analysis_id=pt.analysis_id WHERE pt.repo_key=$1`, proposal.RepoKey, tagID).Scan(&count, &already)
		if err != nil {
			return out, err
		}
		if count >= 100 && !already {
			return out, govConflict("governance_tag_conflict")
		}
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if change {
		var exists bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM feed.taxonomy_versions WHERE version=$1)`, next).Scan(&exists); err != nil {
			return out, err
		}
		if exists {
			return out, ErrFeedTaxonomyChanged
		}
		if _, err = tx.ExecContext(ctx, `UPDATE feed.taxonomy_versions SET state='retired' WHERE state='active'`); err != nil {
			return out, err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO feed.taxonomy_versions(version,state,created_at,activated_at,note) VALUES($1,'active',$2,$2,$3)`, next, now, "governance command "+command.CommandID); err != nil {
			return out, err
		}
	}
	switch input.Action {
	case "create":
		_, err = tx.ExecContext(ctx, `INSERT INTO feed.tag_definitions(id,namespace,slug,label_zh,label_en,description,status,taxonomy_version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'canonical',$7,$8,$8)`, tagID, proposal.Namespace, proposal.Slug, input.Labels.LabelZH, input.Labels.LabelEN, input.Labels.Description, next, now)
	case "map":
		_, err = tx.ExecContext(ctx, `INSERT INTO feed.tag_aliases(namespace,alias_slug,canonical_tag_id,taxonomy_version,created_at) SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS(SELECT 1 FROM feed.tag_definitions WHERE namespace=$1 AND slug=$2) ON CONFLICT(namespace,alias_slug) DO NOTHING`, proposal.Namespace, proposal.Slug, tagID, next, now)
	case "deprecate":
		_, err = tx.ExecContext(ctx, `UPDATE feed.tag_definitions SET status='deprecated',taxonomy_version=$2,updated_at=$3 WHERE id=$1`, tagID, next, now)
	}
	if err != nil {
		return out, err
	}
	status := "deprecated"
	if proposal != nil {
		status = "rejected"
		if input.Action != "reject" {
			status = "mapped"
			// One effective reviewed assignment: the source-aware legacy PK must not
			// leave a parallel agent/system assignment influencing scoring twice.
			if _, err = tx.ExecContext(ctx, `DELETE FROM feed.project_tags WHERE repo_key=$1 AND tag_id=$2`, proposal.RepoKey, tagID); err != nil {
				return out, err
			}
			if _, err = tx.ExecContext(ctx, `INSERT INTO feed.project_tags(repo_key,tag_id,source,weight,confidence,evidence_ids,analysis_id,taxonomy_version,created_at,updated_at) VALUES($1,$2,'editor',$3,$4,$5::jsonb,$6,$7,$8,$8)`, proposal.RepoKey, tagID, input.Assignment.Weight, input.Assignment.Confidence, string(evidence), proposal.AnalysisID, next, now); err != nil {
				return out, err
			}
		}
		if _, err = tx.ExecContext(ctx, `UPDATE feed.tag_proposals SET status=$2,canonical_tag_id=NULLIF($3,''),resolved_by=$4,resolution_reason=$5,taxonomy_version=$6,resolved_at=$7 WHERE id=$1`, proposal.ProposalID, status, tagID, command.Operator, command.Reason, next, now); err != nil {
			return out, err
		}
	}
	out = FeedGovernanceResult{CommandID: command.CommandID, Action: input.Action, ProposalKind: input.ProposalKind, ProposalID: input.ProposalID, Status: status, TaxonomyVersion: next, AppliedAt: now.UnixMilli()}
	if tagID != "" {
		out.CanonicalTagID = &tagID
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return out, err
	}
	var repo, analysis, evidenceHash any
	var weight, confidence any
	if proposal != nil {
		repo = proposal.RepoKey
		analysis = proposal.AnalysisID
		evidenceHash = fmt.Sprintf("%x", sha256.Sum256(evidence))
	}
	if input.Assignment != nil {
		weight = input.Assignment.Weight
		confidence = input.Assignment.Confidence
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO feed.governance_commands(command_id,action,writer_epoch,expected_taxonomy_version,proposal_kind,proposal_id,repo_key,analysis_id,evidence_hash,canonical_tag_id,operator,reason,assignment_weight,assignment_confidence,payload_hash,result_json,taxonomy_version,created_at) VALUES($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),$7,$8,$9,NULLIF($10,''),$11,$12,$13,$14,$15,$16::jsonb,$17,$18)`, command.CommandID, input.Action, command.WriterEpoch, active, input.ProposalKind, input.ProposalID, repo, analysis, evidenceHash, tagID, command.Operator, command.Reason, weight, confidence, digest, string(encoded), next, now)
	if err != nil {
		return out, err
	}
	return out, tx.Commit()
}
