package backend

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// FeedProjectProjection is the rebuildable PostgreSQL representation of a
// completed Turso assessment. Turso remains authoritative for every field in
// this structure; Feed-specific moderation and taxonomy decisions live only in
// PostgreSQL.
type FeedProjectProjection struct {
	RepoKey              string
	ItemID               string
	OwnerLogin           string
	Name                 string
	CanonicalURL         string
	Summary              string
	PainStatement        string
	TargetUsers          []string
	Language             *string
	Topics               []string
	ProjectType          string
	Lifecycle            string
	ProductScore         float64
	Confidence           float64
	VerificationLevel    string
	ExposureBand         string
	TreasureEligible     bool
	ClassicEligible      bool
	Risks                []ProjectRisk
	AnalysisID           string
	ResolvedCommitSHA    string
	AnalyzedAt           time.Time
	Descriptor           string
	DescriptorHash       string
	SourceHash           string
	Publishable          bool
	BlockedReason        string
	RiskOverrideEligible bool
	ProductTags          []ProductTag
}

var feedHighRiskBlockingCategories = map[string]struct{}{
	"license": {}, "security": {}, "supply_chain": {}, "privacy": {},
}

// BuildFeedProjectProjection applies the Feed publication contract without
// reusing leaderboard eligibility. Low product scores remain recommendable;
// only artifact identity, inspection depth, visibility, and adoption risks are
// hard gates.
func BuildFeedProjectProjection(assessment ProjectAssessment, overview *ProjectOverview) (FeedProjectProjection, error) {
	if assessment.Analysis == nil {
		return FeedProjectProjection{}, fmt.Errorf("assessment %q has no analysis artifact", assessment.RepoKey)
	}
	analysis := assessment.Analysis
	normalized, err := NormalizeGitHubRepository(assessment.RepoKey)
	if err != nil {
		return FeedProjectProjection{}, fmt.Errorf("normalize assessment repository: %w", err)
	}
	repoKey := strings.ToLower(normalized.RepoKey)
	if !strings.EqualFold(repoKey, analysis.Repository.RepoKey) {
		return FeedProjectProjection{}, fmt.Errorf("analysis repository %q does not match assessment %q", analysis.Repository.RepoKey, repoKey)
	}
	if assessment.LatestAnalysisID == "" || analysis.AnalysisID != assessment.LatestAnalysisID {
		return FeedProjectProjection{}, fmt.Errorf("analysis id does not match latest assessment")
	}
	if !resolvedCommitSHAPattern.MatchString(assessment.ResolvedCommitSHA) ||
		!strings.EqualFold(assessment.ResolvedCommitSHA, analysis.Repository.ResolvedCommitSHA) {
		return FeedProjectProjection{}, fmt.Errorf("analysis commit does not match assessment")
	}

	owner, name, ok := strings.Cut(repoKey, "/")
	if !ok {
		return FeedProjectProjection{}, fmt.Errorf("invalid normalized repository key")
	}
	projectName := strings.TrimSpace(analysis.Project.Name)
	if projectName == "" {
		projectName = name
	}
	canonicalURL := strings.TrimSpace(analysis.Repository.CanonicalURL)
	if canonicalURL == "" {
		canonicalURL = normalized.CanonicalURL
	}

	var language *string
	topics := []string{}
	if overview != nil && strings.EqualFold(overview.Repo.RepoKey, repoKey) {
		language = overview.Repo.Language
		topics = normalizedFeedStrings(overview.Repo.Topics)
		if overview.Repo.OwnerLogin != "" {
			owner = strings.ToLower(overview.Repo.OwnerLogin)
		}
		if overview.Repo.Name != "" {
			name = overview.Repo.Name
		}
	}

	analyzedAt := time.UnixMilli(assessment.AnalyzedAt).UTC()
	if assessment.AnalyzedAt <= 0 {
		parsed, parseErr := time.Parse(time.RFC3339, analysis.AnalyzedAt)
		if parseErr != nil {
			return FeedProjectProjection{}, fmt.Errorf("parse analysis timestamp: %w", parseErr)
		}
		analyzedAt = parsed.UTC()
	}

	blocked := feedProjectBlockedReasons(analysis)
	riskOverrideEligible := len(blocked) > 0
	for _, reason := range blocked {
		if !strings.HasPrefix(reason, "high_risk:") {
			riskOverrideEligible = false
			break
		}
	}
	projection := FeedProjectProjection{
		RepoKey:              repoKey,
		ItemID:               strings.Replace(repoKey, "/", ":", 1),
		OwnerLogin:           strings.ToLower(owner),
		Name:                 projectName,
		CanonicalURL:         canonicalURL,
		Summary:              strings.TrimSpace(analysis.Project.Summary),
		PainStatement:        strings.TrimSpace(analysis.Project.PainStatement),
		TargetUsers:          normalizedFeedStrings(analysis.Project.TargetUsers),
		Language:             language,
		Topics:               topics,
		ProjectType:          analysis.Project.ProjectType,
		Lifecycle:            analysis.Project.Lifecycle,
		ProductScore:         assessment.ProductScore,
		Confidence:           assessment.Confidence,
		VerificationLevel:    analysis.VerificationLevel,
		ExposureBand:         analysis.Exposure.Band,
		TreasureEligible:     assessment.TreasureEligible,
		ClassicEligible:      assessment.ClassicEligible,
		Risks:                append([]ProjectRisk(nil), analysis.Risks...),
		AnalysisID:           analysis.AnalysisID,
		ResolvedCommitSHA:    strings.ToLower(analysis.Repository.ResolvedCommitSHA),
		AnalyzedAt:           analyzedAt,
		Publishable:          len(blocked) == 0,
		BlockedReason:        strings.Join(blocked, ","),
		RiskOverrideEligible: riskOverrideEligible,
		ProductTags:          append([]ProductTag(nil), analysis.Project.ProductTags...),
	}
	projection.Descriptor = BuildFeedProjectDescriptor(projection)
	projection.DescriptorHash = descriptorHash(projection.Descriptor)
	projection.SourceHash, err = feedProjectionHash(projection)
	if err != nil {
		return FeedProjectProjection{}, err
	}
	return projection, nil
}

func feedProjectBlockedReasons(analysis *ProjectAnalysisArtifact) []string {
	reasons := []string{}
	if verificationRank[analysis.VerificationLevel] < verificationRank["source_inspected"] {
		reasons = append(reasons, "verification_below_source_inspected")
	}
	for _, risk := range analysis.Risks {
		severity := strings.ToLower(strings.TrimSpace(risk.Severity))
		category := strings.ToLower(strings.TrimSpace(risk.Category))
		if severity == "critical" {
			reasons = append(reasons, "critical_risk:"+category)
			continue
		}
		if severity == "high" {
			if _, blocks := feedHighRiskBlockingCategories[category]; blocks {
				reasons = append(reasons, "high_risk:"+category)
			}
		}
	}
	sort.Strings(reasons)
	return reasons
}

// BuildFeedProjectDescriptor is deliberately stable: the same semantic input
// produces byte-for-byte identical text and therefore the same embedding hash.
func BuildFeedProjectDescriptor(project FeedProjectProjection) string {
	parts := []string{
		"name: " + strings.TrimSpace(project.Name),
		"summary: " + strings.TrimSpace(project.Summary),
		"pain: " + strings.TrimSpace(project.PainStatement),
		"target users: " + strings.Join(normalizedFeedStrings(project.TargetUsers), ", "),
		"project type: " + strings.TrimSpace(project.ProjectType),
		"lifecycle: " + strings.TrimSpace(project.Lifecycle),
	}
	if project.Language != nil {
		parts = append(parts, "language: "+strings.TrimSpace(*project.Language))
	}
	parts = append(parts, "github topics: "+strings.Join(normalizedFeedStrings(project.Topics), ", "))
	return strings.Join(parts, "\n")
}

func normalizedFeedStrings(values []string) []string {
	unique := map[string]string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			unique[strings.ToLower(value)] = value
		}
	}
	keys := make([]string, 0, len(unique))
	for key := range unique {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, unique[key])
	}
	return result
}

func feedProjectionHash(project FeedProjectProjection) (string, error) {
	stable := struct {
		AnalysisID        string
		ResolvedCommitSHA string
		Descriptor        string
		ProductScore      float64
		Confidence        float64
		VerificationLevel string
		ExposureBand      string
		Risks             []ProjectRisk
		ProductTags       []ProductTag
		Publishable       bool
	}{project.AnalysisID, project.ResolvedCommitSHA, project.Descriptor, project.ProductScore, project.Confidence,
		project.VerificationLevel, project.ExposureBand, project.Risks, project.ProductTags, project.Publishable}
	encoded, err := json.Marshal(stable)
	if err != nil {
		return "", fmt.Errorf("encode Feed project source hash: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

func (s *PostgresFeedStore) UpsertFeedProject(ctx context.Context, project FeedProjectProjection) error {
	targetUsers, _ := json.Marshal(project.TargetUsers)
	topics, _ := json.Marshal(project.Topics)
	risks, _ := json.Marshal(project.Risks)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	var appliedRepo string
	var projectionVersion int64
	err = tx.QueryRowContext(ctx, `INSERT INTO feed.projects
      (repo_key, item_id, owner_login, name, canonical_url, summary, pain_statement, target_users,
       language, topics, project_type, lifecycle, product_score, confidence, verification_level,
       exposure_band, treasure_eligible, classic_eligible, risks, analysis_id, resolved_commit_sha,
	       analyzed_at, base_descriptor, descriptor, descriptor_hash, source_hash, publishable, blocked_reason, risk_override_eligible, projected_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,
	              $19::jsonb,$20,$21,$22,$23,$23,$24,$25,$26,NULLIF($27,''),$28,now(),now())
      ON CONFLICT (repo_key) DO UPDATE SET
        item_id=excluded.item_id, owner_login=excluded.owner_login, name=excluded.name,
        canonical_url=excluded.canonical_url, summary=excluded.summary, pain_statement=excluded.pain_statement,
        target_users=excluded.target_users, language=excluded.language, topics=excluded.topics,
        project_type=excluded.project_type, lifecycle=excluded.lifecycle, product_score=excluded.product_score,
        confidence=excluded.confidence, verification_level=excluded.verification_level,
        exposure_band=excluded.exposure_band, treasure_eligible=excluded.treasure_eligible,
        classic_eligible=excluded.classic_eligible, risks=excluded.risks, analysis_id=excluded.analysis_id,
	        resolved_commit_sha=excluded.resolved_commit_sha, analyzed_at=excluded.analyzed_at,
	        base_descriptor=excluded.base_descriptor,descriptor=excluded.descriptor,
	        descriptor_hash=excluded.descriptor_hash, source_hash=excluded.source_hash,
	        risk_override_eligible=excluded.risk_override_eligible,
	        admin_override=CASE WHEN feed.projects.source_hash IS NOT DISTINCT FROM excluded.source_hash
	          THEN feed.projects.admin_override ELSE false END,
	        publishable=CASE
	          WHEN feed.projects.admin_removed THEN false
	          WHEN feed.projects.source_hash IS NOT DISTINCT FROM excluded.source_hash
	            AND feed.projects.admin_override AND excluded.risk_override_eligible THEN true
	          ELSE excluded.publishable END,
	        blocked_reason=excluded.blocked_reason, projection_version=feed.projects.projection_version+1,
	        projected_at=now(), updated_at=now()
	      WHERE feed.projects.analyzed_at <= excluded.analyzed_at AND (
	        feed.projects.source_hash IS DISTINCT FROM excluded.source_hash OR
	        feed.projects.blocked_reason IS DISTINCT FROM excluded.blocked_reason OR
	        feed.projects.risk_override_eligible IS DISTINCT FROM excluded.risk_override_eligible OR
	        feed.projects.publishable IS DISTINCT FROM CASE
	          WHEN feed.projects.admin_removed THEN false
	          WHEN feed.projects.source_hash IS NOT DISTINCT FROM excluded.source_hash
	            AND feed.projects.admin_override AND excluded.risk_override_eligible THEN true
	          ELSE excluded.publishable END)
	      RETURNING repo_key,projection_version`, project.RepoKey, project.ItemID, project.OwnerLogin, project.Name,
		project.CanonicalURL, project.Summary, project.PainStatement, string(targetUsers), project.Language,
		string(topics), project.ProjectType, project.Lifecycle, project.ProductScore, project.Confidence,
		project.VerificationLevel, project.ExposureBand, project.TreasureEligible, project.ClassicEligible,
		string(risks), project.AnalysisID, project.ResolvedCommitSHA, project.AnalyzedAt, project.Descriptor,
		project.DescriptorHash, project.SourceHash, project.Publishable, project.BlockedReason, project.RiskOverrideEligible).
		Scan(&appliedRepo, &projectionVersion)
	if errors.Is(err, sql.ErrNoRows) {
		return nil // a late, older projection must never replace the current artifact
	}
	if err != nil {
		return fmt.Errorf("upsert Feed project: %w", err)
	}

	var taxonomyVersion int64
	if err := tx.QueryRowContext(ctx, `SELECT version FROM feed.taxonomy_versions WHERE state='active' LIMIT 1`).Scan(&taxonomyVersion); err != nil {
		return fmt.Errorf("read Feed taxonomy for projection: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM feed.project_tags
      WHERE repo_key=$1 AND source IN ('agent','system','github_topic')`, project.RepoKey); err != nil {
		return fmt.Errorf("clear generated Feed tags: %w", err)
	}
	for _, id := range []string{
		"artifact:" + strings.ReplaceAll(project.ProjectType, "_", "-"),
		"stage:" + strings.ReplaceAll(project.Lifecycle, "_", "-"),
	} {
		if err := upsertProjectedFeedTag(ctx, tx, project, id, "system", 1, 1, nil, taxonomyVersion); err != nil {
			return err
		}
	}
	for _, tag := range project.ProductTags {
		canonicalID, found, err := resolveProjectedFeedTag(ctx, tx, "use_case", tag.Slug, taxonomyVersion)
		if err != nil {
			return err
		}
		if found {
			confidence := project.Confidence / 100
			if confidence < 0 {
				confidence = 0
			}
			if confidence > 1 {
				confidence = 1
			}
			if err := upsertProjectedFeedTag(ctx, tx, project, canonicalID, "agent", 1, confidence, tag.EvidenceIDs, taxonomyVersion); err != nil {
				return err
			}
			continue
		}
		if err := insertFeedTagProposal(ctx, tx, project, tag, taxonomyVersion); err != nil {
			return err
		}
	}
	if err := refreshFeedProjectDescriptorTx(ctx, tx, project.RepoKey); err != nil {
		return err
	}
	projectPayload, _ := json.Marshal(map[string]any{
		"repoKey": project.RepoKey, "itemId": project.ItemID, "analysisId": project.AnalysisID,
		"sourceHash": project.SourceHash, "publishable": project.Publishable, "projectionVersion": projectionVersion,
	})
	if _, err := tx.ExecContext(ctx, `INSERT INTO feed.event_outbox
      (aggregate_key,topic,payload,dedupe_key)
      VALUES ($1,'feed.project-sync.v1',$2::jsonb,$3)
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
		project.RepoKey, string(projectPayload), fmt.Sprintf("project-sync:%s:%d", project.RepoKey, projectionVersion)); err != nil {
		return fmt.Errorf("queue Feed project projection: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Feed project projection: %w", err)
	}
	return nil
}

// refreshFeedProjectDescriptorTx is the only path that adds taxonomy text to
// semantic input. Proposed/rejected labels never reach this query and thus can
// never leak into embedding recall.
func refreshFeedProjectDescriptorTx(ctx context.Context, tx *sql.Tx, repoKey string) error {
	var base string
	if err := tx.QueryRowContext(ctx, `SELECT base_descriptor FROM feed.projects WHERE repo_key=$1`, repoKey).Scan(&base); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT td.id,td.label_en,td.label_zh,td.description
	  FROM feed.project_tags pt JOIN feed.tag_definitions td ON td.id=pt.tag_id AND td.status='canonical'
	  WHERE pt.repo_key=$1 ORDER BY td.namespace,td.slug`, repoKey)
	if err != nil {
		return err
	}
	tags := []string{}
	for rows.Next() {
		var id, labelEN, labelZH, description string
		if err := rows.Scan(&id, &labelEN, &labelZH, &description); err != nil {
			_ = rows.Close()
			return err
		}
		tags = append(tags, strings.TrimSpace(id+": "+labelEN+" / "+labelZH+" — "+description))
	}
	if err := rows.Close(); err != nil {
		return err
	}
	descriptor := base
	if len(tags) > 0 {
		descriptor += "\ncanonical tags:\n" + strings.Join(tags, "\n")
	}
	_, err = tx.ExecContext(ctx, `UPDATE feed.projects SET descriptor=$2,descriptor_hash=$3 WHERE repo_key=$1`,
		repoKey, descriptor, descriptorHash(descriptor))
	if err != nil {
		return fmt.Errorf("refresh canonical Feed descriptor: %w", err)
	}
	return nil
}

func resolveProjectedFeedTag(ctx context.Context, tx *sql.Tx, namespace, slug string, version int64) (string, bool, error) {
	slug = strings.ToLower(strings.TrimSpace(slug))
	var id string
	err := tx.QueryRowContext(ctx, `SELECT id FROM feed.tag_definitions
      WHERE namespace=$1 AND slug=$2 AND status='canonical' AND taxonomy_version <= $3
      UNION ALL
      SELECT a.canonical_tag_id FROM feed.tag_aliases a
      JOIN feed.tag_definitions d ON d.id=a.canonical_tag_id AND d.status='canonical'
      WHERE a.namespace=$1 AND a.alias_slug=$2 AND a.taxonomy_version <= $3 LIMIT 1`, namespace, slug, version).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("resolve Feed tag %s:%s: %w", namespace, slug, err)
	}
	return id, true, nil
}

func upsertProjectedFeedTag(ctx context.Context, tx *sql.Tx, project FeedProjectProjection, tagID, source string, weight, confidence float64, evidence []string, version int64) error {
	encoded, _ := json.Marshal(evidence)
	result, err := tx.ExecContext(ctx, `INSERT INTO feed.project_tags
      (repo_key, tag_id, source, weight, confidence, evidence_ids, analysis_id, taxonomy_version)
      SELECT $1,$2,$3,$4,$5,$6::jsonb,$7,$8
      WHERE EXISTS (SELECT 1 FROM feed.tag_definitions WHERE id=$2 AND status='canonical' AND taxonomy_version <= $8)
      ON CONFLICT (repo_key,tag_id,source) DO UPDATE SET weight=excluded.weight,
        confidence=excluded.confidence, evidence_ids=excluded.evidence_ids,
        analysis_id=excluded.analysis_id, taxonomy_version=excluded.taxonomy_version, updated_at=now()`,
		project.RepoKey, tagID, source, weight, confidence, string(encoded), project.AnalysisID, version)
	if err != nil {
		return fmt.Errorf("upsert projected Feed tag %s: %w", tagID, err)
	}
	if rows, rowsErr := result.RowsAffected(); rowsErr != nil || rows != 1 {
		if rowsErr != nil {
			return rowsErr
		}
		return fmt.Errorf("required canonical Feed tag %q is missing", tagID)
	}
	return nil
}

func insertFeedTagProposal(ctx context.Context, tx *sql.Tx, project FeedProjectProjection, tag ProductTag, version int64) error {
	digest := sha256.Sum256([]byte("use_case\x00" + strings.ToLower(tag.Slug) + "\x00" + project.RepoKey))
	id := "proposal_" + hex.EncodeToString(digest[:12])
	evidence, _ := json.Marshal(tag.EvidenceIDs)
	_, err := tx.ExecContext(ctx, `INSERT INTO feed.tag_proposals
      (id,namespace,slug,label_zh,label_en,source,source_ref,evidence_ids,status,taxonomy_version)
      VALUES ($1,'use_case',$2,$3,$4,'agent',$5,$6::jsonb,'proposed',$7)
      ON CONFLICT (namespace,slug,source_ref) DO UPDATE SET
        label_zh=excluded.label_zh, label_en=excluded.label_en,
        evidence_ids=excluded.evidence_ids, taxonomy_version=excluded.taxonomy_version`,
		id, strings.ToLower(tag.Slug), tag.Labels.Zh, tag.Labels.En, project.RepoKey, string(evidence), version)
	if err != nil {
		return fmt.Errorf("insert Feed tag proposal %s: %w", tag.Slug, err)
	}
	return nil
}
