package backend

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// These fixtures mirror src/lib/__tests__/project-analysis-contract.test.ts.
func validProjectAnalysisMap() map[string]any {
	return map[string]any{
		"schema_version": ProjectAnalysisSchemaVersion,
		"analysis_id":    "analysis-1",
		"repository": map[string]any{
			"repo_key":            "owner/useful-tool",
			"canonical_url":       "https://github.com/owner/useful-tool",
			"requested_ref":       nil,
			"resolved_commit_sha": strings.Repeat("a", 40),
		},
		"rubric_version": "project-value-v1",
		"agent_version":  ProjectAgentVersion,
		"skill_version":  ProjectSkillVersion,
		"project": map[string]any{
			"name":           "useful-tool",
			"summary":        "Converts one format into another.",
			"target_users":   []string{"developers"},
			"pain_statement": "Manual conversion is repetitive.",
			"project_type":   "micro_tool",
			"lifecycle":      "feature_complete",
			"product_tags": []map[string]any{
				{
					"namespace":    "use_case",
					"slug":         "one-command-conversion",
					"labels":       map[string]any{"zh": "一键转换", "en": "One-command conversion"},
					"evidence_ids": []string{"readme-contract"},
				},
				{
					"namespace":    "artifact",
					"slug":         "developer-cli",
					"labels":       map[string]any{"zh": "开发者 CLI", "en": "Developer CLI"},
					"evidence_ids": []string{"readme-contract"},
				},
				{
					"namespace":    "audience",
					"slug":         "automation-friendly",
					"labels":       map[string]any{"zh": "自动化友好", "en": "Automation-friendly"},
					"evidence_ids": []string{"readme-contract"},
				},
			},
		},
		"scores": map[string]any{
			"pain": map[string]any{
				"score": 21, "max_score": 25,
				"rationale": "The problem is frequent and concrete.", "evidence_ids": []string{"readme-contract"},
			},
			"effectiveness": map[string]any{
				"score": 27, "max_score": 30,
				"rationale": "The command produces the promised result.", "evidence_ids": []string{"readme-contract"},
			},
			"experience": map[string]any{
				"score": 25, "max_score": 30,
				"rationale": "The primary command is documented.", "evidence_ids": []string{"readme-contract"},
			},
			"value_density": map[string]any{
				"score": 14, "max_score": 15,
				"rationale": "Small surface with clear value.", "evidence_ids": []string{"readme-contract"},
			},
			"product_score": 87,
		},
		"confidence":         74,
		"verification_level": "source_inspected",
		"unknowns":           []string{"Runtime execution was not allowed."},
		"risks":              []any{},
		"community_strength": map[string]any{
			"score":        38,
			"rationale":    "A small but credible contributor group supports the project.",
			"evidence_ids": []string{"readme-contract"},
		},
		"exposure": map[string]any{
			"band":         "low",
			"stars":        42,
			"dependents":   nil,
			"downloads":    nil,
			"rationale":    "Low stars for a complete tool.",
			"evidence_ids": []string{"readme-contract"},
		},
		"analyzed_at": "2026-07-15T00:00:00.000Z",
	}
}

func validRuntimeEvidenceMap() map[string]any {
	return map[string]any{
		"schema_version":      ProjectAnalysisSchemaVersion,
		"analysis_id":         "analysis-1",
		"repo_key":            "owner/useful-tool",
		"resolved_commit_sha": strings.Repeat("a", 40),
		"entries": []map[string]any{
			{
				"id":      "readme-contract",
				"kind":    "source",
				"summary": "README defines one-command conversion.",
				"outcome": "pass",
				"path":    "README.md",
			},
		},
	}
}

func mustMarshalJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func artifactsInput(t *testing.T, analysis, evidence map[string]any, report string) ProjectAnalysisArtifactsInput {
	t.Helper()
	return ProjectAnalysisArtifactsInput{
		AnalysisRaw:        mustMarshalJSON(t, analysis),
		EvidenceRaw:        mustMarshalJSON(t, evidence),
		ReportMarkdown:     report,
		ExpectedAnalysisID: "analysis-1",
		ExpectedRepoKey:    "owner/useful-tool",
	}
}

func expectArtifactInvalid(t *testing.T, err error, contains string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected an artifact error containing %q, got nil", contains)
	}
	if !errors.Is(err, ErrArtifactInvalid) {
		t.Fatalf("error %v does not wrap ErrArtifactInvalid", err)
	}
	if contains != "" && !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(contains)) {
		t.Fatalf("error %q does not contain %q", err.Error(), contains)
	}
}

func TestNormalizeGitHubRepository(t *testing.T) {
	valid := map[string]NormalizedGitHubRepository{
		"owner/Useful-Tool": {
			RepoKey:       "owner/useful-tool",
			NameWithOwner: "owner/Useful-Tool",
			CanonicalURL:  "https://github.com/owner/Useful-Tool",
		},
		"https://github.com/owner/Useful-Tool.git": {
			RepoKey:       "owner/useful-tool",
			NameWithOwner: "owner/Useful-Tool",
			CanonicalURL:  "https://github.com/owner/Useful-Tool",
		},
		"https://www.github.com/owner/repo": {
			RepoKey:       "owner/repo",
			NameWithOwner: "owner/repo",
			CanonicalURL:  "https://github.com/owner/repo",
		},
		"https://github.com/owner/repo/": {
			RepoKey:       "owner/repo",
			NameWithOwner: "owner/repo",
			CanonicalURL:  "https://github.com/owner/repo",
		},
		"owner/repo.name_with-dots": {
			RepoKey:       "owner/repo.name_with-dots",
			NameWithOwner: "owner/repo.name_with-dots",
			CanonicalURL:  "https://github.com/owner/repo.name_with-dots",
		},
	}
	for input, expected := range valid {
		normalized, err := NormalizeGitHubRepository(input)
		if err != nil {
			t.Fatalf("NormalizeGitHubRepository(%q) err=%v", input, err)
		}
		if normalized != expected {
			t.Fatalf("NormalizeGitHubRepository(%q) = %#v", input, normalized)
		}
	}

	invalid := []string{
		"",
		"   ",
		strings.Repeat("a", 501),
		"https://example.com/owner/repo",
		"http://github.com/owner/repo",
		"https://github.com/owner/repo/issues",
		"https://github.com/owner",
		"https://github.com/owner/repo?tab=readme",
		"https://github.com/owner/repo#readme",
		"https://github.com:8443/owner/repo",
		"https://user:pass@github.com/owner/repo",
		"owner/re po",
		"owner_name/repo",
		"-owner/repo",
		"owner//repo",
		strings.Repeat("a", 40) + "/" + strings.Repeat("b", 101),
	}
	for _, input := range invalid {
		if _, err := NormalizeGitHubRepository(input); !errors.Is(err, ErrInvalidRepository) {
			t.Fatalf("NormalizeGitHubRepository(%q) err=%v, want ErrInvalidRepository", input, err)
		}
	}
}

func TestNormalizeRequestedRef(t *testing.T) {
	for _, input := range []string{"", "   "} {
		ref, err := NormalizeRequestedRef(input)
		if err != nil || ref != nil {
			t.Fatalf("NormalizeRequestedRef(%q) = %v, %v", input, ref, err)
		}
	}
	ref, err := NormalizeRequestedRef("  feature/Add-Thing  ")
	if err != nil || ref == nil || *ref != "feature/Add-Thing" {
		t.Fatalf("NormalizeRequestedRef valid = %v, %v", ref, err)
	}
	invalid := []string{
		strings.Repeat("a", 201),
		"bad ref",
		"release..main",
		"-checkout-like",
		"refs/heads/@{1}",
		"tilde~1",
		"caret^1",
		"colon:ref",
		"glob*",
		"bracket[0]",
		`back\slash`,
	}
	for _, input := range invalid {
		if _, err := NormalizeRequestedRef(input); !errors.Is(err, ErrInvalidRef) {
			t.Fatalf("NormalizeRequestedRef(%q) err=%v, want ErrInvalidRef", input, err)
		}
	}
}

// TestProjectAnalysisKeyParity pins the hex digests to values computed with
// Node's crypto.sha256 over the same NUL-joined parts, so both runtimes derive
// identical fingerprints and active keys.
func TestProjectAnalysisKeyParity(t *testing.T) {
	fingerprint := ProjectAnalysisResultFingerprint(
		"owner/useful-tool", nil,
		ProjectAnalysisSchemaVersion, ProjectRubricVersion, ProjectAgentVersion, ProjectSkillVersion,
	)
	if fingerprint != "a04ffea7307058c5e054a019968896e1b9afd62c6629c88611757dd7c10bc569" {
		t.Fatalf("fingerprint = %q", fingerprint)
	}
	activeKey := ProjectAnalysisActiveKey("owner/useful-tool", nil, ProjectRubricVersion)
	if activeKey != "191f86264ad2b4c08afed33f7f7733ffd1d32626ea5761e56a7313bcb7c9fa53" {
		t.Fatalf("active key = %q", activeKey)
	}
	ref := "main"
	fingerprint = ProjectAnalysisResultFingerprint(
		"OWNER/Useful-Tool", &ref,
		ProjectAnalysisSchemaVersion, ProjectRubricVersion, ProjectAgentVersion, ProjectSkillVersion,
	)
	if fingerprint != "d19d587fd139a4015c30610ecc339bf9211d055ecf356ff9a50f62d47a3bdac0" {
		t.Fatalf("ref fingerprint = %q", fingerprint)
	}
	if key := ProjectAnalysisActiveKey("owner/useful-tool", &ref, ProjectRubricVersion); key != "124c6e4a3d4bcbfb39e271bdbb7ee31c0715c8ab0d83d2560b0a2530bd34e95d" {
		t.Fatalf("ref active key = %q", key)
	}
}

func TestParseProjectAnalysisArtifactsValid(t *testing.T) {
	parsed, err := ParseProjectAnalysisArtifacts(artifactsInput(t,
		validProjectAnalysisMap(), validRuntimeEvidenceMap(), "# Useful Tool\n\nA useful project."))
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Analysis.Scores.ProductScore != 87 || len(parsed.Evidence.Entries) != 1 {
		t.Fatalf("parsed = %#v", parsed.Analysis.Scores)
	}
	if parsed.Analysis.Project.ProductTags[0].Labels.Zh != "一键转换" {
		t.Fatalf("tag labels = %#v", parsed.Analysis.Project.ProductTags[0].Labels)
	}
}

func TestParseProjectAnalysisArtifactsKeepsLegacyReadable(t *testing.T) {
	analysis := validProjectAnalysisMap()
	project := analysis["project"].(map[string]any)
	delete(project, "product_tags")
	analysis["schema_version"] = LegacyProjectAnalysisSchemaVersion
	analysis["agent_version"] = "project-evaluator-v1"
	analysis["skill_version"] = "ghfind-project-evaluator-v1"
	evidence := validRuntimeEvidenceMap()
	evidence["schema_version"] = LegacyProjectAnalysisSchemaVersion

	parsed, err := ParseProjectAnalysisArtifacts(artifactsInput(t, analysis, evidence, "# Legacy report"))
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Analysis.Project.ProductTags) != 0 {
		t.Fatalf("legacy product tags = %#v", parsed.Analysis.Project.ProductTags)
	}
}

func TestParseProjectAnalysisArtifactsV2TagsRemainNamespaceInferred(t *testing.T) {
	analysis := validProjectAnalysisMap()
	analysis["schema_version"] = PreviousProjectAnalysisSchemaVersion
	analysis["agent_version"] = "project-evaluator-v2"
	analysis["skill_version"] = "ghfind-project-evaluator-v3"
	for _, tag := range analysis["project"].(map[string]any)["product_tags"].([]map[string]any) {
		delete(tag, "namespace")
	}
	evidence := validRuntimeEvidenceMap()
	evidence["schema_version"] = PreviousProjectAnalysisSchemaVersion
	parsed, err := ParseProjectAnalysisArtifacts(artifactsInput(t, analysis, evidence, "# V2 Report"))
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Analysis.Project.ProductTags) != 3 || parsed.Analysis.Project.ProductTags[0].Namespace != "use_case" || parsed.Analysis.Project.ProductTags[0].NamespaceExplicit {
		t.Fatalf("v2 product tags must remain inferred proposals: %#v", parsed.Analysis.Project.ProductTags)
	}
}

func TestParseProjectAnalysisArtifactsRejectsBadIdentities(t *testing.T) {
	cases := map[string]func(analysis, evidence map[string]any){
		"analysis identity mismatch": func(analysis, evidence map[string]any) {
			evidence["analysis_id"] = "analysis-2"
		},
		"repository identity mismatch": func(analysis, evidence map[string]any) {
			evidence["repo_key"] = "owner/other-tool"
		},
		"resolved commit mismatch": func(analysis, evidence map[string]any) {
			evidence["resolved_commit_sha"] = strings.Repeat("b", 40)
		},
		"artifact schema version mismatch": func(analysis, evidence map[string]any) {
			evidence["schema_version"] = LegacyProjectAnalysisSchemaVersion
		},
	}
	for expected, mutate := range cases {
		analysis, evidence := validProjectAnalysisMap(), validRuntimeEvidenceMap()
		mutate(analysis, evidence)
		_, err := ParseProjectAnalysisArtifacts(artifactsInput(t, analysis, evidence, "# Report"))
		expectArtifactInvalid(t, err, expected)
	}
}

func TestParseProjectAnalysisArtifactsRejectsScoreDriftAndMissingEvidence(t *testing.T) {
	analysis := validProjectAnalysisMap()
	scores := analysis["scores"].(map[string]any)
	scores["product_score"] = 88
	_, err := ParseProjectAnalysisArtifacts(artifactsInput(t, analysis, validRuntimeEvidenceMap(), "# Report"))
	expectArtifactInvalid(t, err, "sum")

	analysis = validProjectAnalysisMap()
	scores = analysis["scores"].(map[string]any)
	pain := scores["pain"].(map[string]any)
	pain["evidence_ids"] = []string{"missing"}
	_, err = ParseProjectAnalysisArtifacts(artifactsInput(t, analysis, validRuntimeEvidenceMap(), "# Report"))
	expectArtifactInvalid(t, err, "Missing evidence")
}

func TestParseProjectAnalysisArtifactsProductTagRules(t *testing.T) {
	withTags := func(tags []map[string]any) map[string]any {
		analysis := validProjectAnalysisMap()
		analysis["project"].(map[string]any)["product_tags"] = tags
		return analysis
	}
	validTags := validProjectAnalysisMap()["project"].(map[string]any)["product_tags"].([]map[string]any)

	// Internal classification slugs must never surface as public tags.
	internalTag := map[string]any{
		"namespace":    "use_case",
		"slug":         "micro-tool",
		"labels":       map[string]any{"zh": "格式转换", "en": "Format conversion"},
		"evidence_ids": []string{"readme-contract"},
	}
	_, err := ParseProjectAnalysisArtifacts(artifactsInput(t,
		withTags(append(validTags[:2:2], internalTag)), validRuntimeEvidenceMap(), "# Report"))
	expectArtifactInvalid(t, err, "internal classification")

	// Generic labels are rejected case-insensitively.
	genericTag := map[string]any{
		"namespace":    "use_case",
		"slug":         "handy-cli",
		"labels":       map[string]any{"zh": "工具", "en": "Handy CLI"},
		"evidence_ids": []string{"readme-contract"},
	}
	_, err = ParseProjectAnalysisArtifacts(artifactsInput(t,
		withTags(append(validTags[:2:2], genericTag)), validRuntimeEvidenceMap(), "# Report"))
	expectArtifactInvalid(t, err, "too generic")

	// Duplicate slugs and duplicate labels are rejected.
	duplicateSlug := map[string]any{
		"namespace":    "artifact",
		"slug":         "developer-cli",
		"labels":       map[string]any{"zh": "另一个 CLI", "en": "Another CLI"},
		"evidence_ids": []string{"readme-contract"},
	}
	_, err = ParseProjectAnalysisArtifacts(artifactsInput(t,
		withTags(append(validTags, duplicateSlug)), validRuntimeEvidenceMap(), "# Report"))
	expectArtifactInvalid(t, err, "Duplicate product tag slug")

	duplicateLabel := map[string]any{
		"namespace":    "use_case",
		"slug":         "cli-for-devs",
		"labels":       map[string]any{"zh": "开发者 cli", "en": "CLI for devs"},
		"evidence_ids": []string{"readme-contract"},
	}
	_, err = ParseProjectAnalysisArtifacts(artifactsInput(t,
		withTags(append(validTags[:2:2], duplicateLabel)), validRuntimeEvidenceMap(), "# Report"))
	expectArtifactInvalid(t, err, "Duplicate product tag label")

	// The current schema requires at least three product tags.
	_, err = ParseProjectAnalysisArtifacts(artifactsInput(t,
		withTags(validTags[:2]), validRuntimeEvidenceMap(), "# Report"))
	expectArtifactInvalid(t, err, "at least three product tags")

	// More than five tags are rejected by the schema itself.
	sixth := map[string]any{
		"namespace":    "domain",
		"slug":         "extra-tag",
		"labels":       map[string]any{"zh": "额外标签", "en": "Extra tag"},
		"evidence_ids": []string{"readme-contract"},
	}
	_, err = ParseProjectAnalysisArtifacts(artifactsInput(t,
		withTags(append(validTags, duplicateSlug, sixth, map[string]any{
			"namespace": "domain", "slug": "yet-another", "labels": map[string]any{"zh": "又一标签", "en": "Yet another"},
			"evidence_ids": []string{"readme-contract"},
		})), validRuntimeEvidenceMap(), "# Report"))
	expectArtifactInvalid(t, err, "at most 5")
}

func TestParseProjectAnalysisArtifactsNormalizesNamingDrift(t *testing.T) {
	analysis := validProjectAnalysisMap()
	analysis["project"].(map[string]any)["project_type"] = "micro-tool"
	analysis["risks"] = []map[string]any{
		{
			"severity":     "medium",
			"category":     "compatibility",
			"title":        "Platform support is narrow",
			"description":  "Only one operating system is documented.",
			"evidence_ids": []string{"readme-contract"},
		},
	}
	parsed, err := ParseProjectAnalysisArtifacts(artifactsInput(t, analysis, validRuntimeEvidenceMap(), "# Report"))
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Analysis.Project.ProjectType != "micro_tool" {
		t.Fatalf("project type = %q", parsed.Analysis.Project.ProjectType)
	}
	if parsed.Analysis.Risks[0].Summary != "Only one operating system is documented." {
		t.Fatalf("risk summary = %q", parsed.Analysis.Risks[0].Summary)
	}
}

func TestParseProjectAnalysisArtifactsRejectsUnknownTypesAndEmptyRisks(t *testing.T) {
	analysis := validProjectAnalysisMap()
	analysis["project"].(map[string]any)["project_type"] = "tiny_project"
	_, err := ParseProjectAnalysisArtifacts(artifactsInput(t, analysis, validRuntimeEvidenceMap(), "# Report"))
	expectArtifactInvalid(t, err, "project_type")

	analysis = validProjectAnalysisMap()
	analysis["risks"] = []map[string]any{
		{"severity": "low", "category": "other", "evidence_ids": []string{"readme-contract"}},
	}
	_, err = ParseProjectAnalysisArtifacts(artifactsInput(t, analysis, validRuntimeEvidenceMap(), "# Report"))
	expectArtifactInvalid(t, err, "summary")
}

func TestParseProjectAnalysisArtifactsSizeLimits(t *testing.T) {
	input := artifactsInput(t, validProjectAnalysisMap(), validRuntimeEvidenceMap(), "# Report")
	input.AnalysisRaw = strings.Repeat(" ", projectAnalysisArtifactMaxLength+1)
	_, err := ParseProjectAnalysisArtifacts(input)
	expectArtifactInvalid(t, err, "analysis artifact is too large")

	input = artifactsInput(t, validProjectAnalysisMap(), validRuntimeEvidenceMap(), "# Report")
	input.EvidenceRaw = strings.Repeat(" ", projectEvidenceArtifactMaxLength+1)
	_, err = ParseProjectAnalysisArtifacts(input)
	expectArtifactInvalid(t, err, "evidence artifact is too large")

	input = artifactsInput(t, validProjectAnalysisMap(), validRuntimeEvidenceMap(), "   ")
	_, err = ParseProjectAnalysisArtifacts(input)
	expectArtifactInvalid(t, err, "report artifact is empty or too large")

	input = artifactsInput(t, validProjectAnalysisMap(), validRuntimeEvidenceMap(), strings.Repeat("#", projectReportMaxLength+1))
	_, err = ParseProjectAnalysisArtifacts(input)
	expectArtifactInvalid(t, err, "report artifact is empty or too large")
}

func TestParseProjectAnalysisArtifactsChecksRunIdentity(t *testing.T) {
	input := artifactsInput(t, validProjectAnalysisMap(), validRuntimeEvidenceMap(), "# Report")
	input.ExpectedRun = &ProjectAnalysisRunIdentity{
		RubricVersion: "project-value-v0",
		AgentVersion:  ProjectAgentVersion,
		SkillVersion:  ProjectSkillVersion,
	}
	_, err := ParseProjectAnalysisArtifacts(input)
	expectArtifactInvalid(t, err, "does not match the analysis run")

	ref := "main"
	input.ExpectedRun = &ProjectAnalysisRunIdentity{
		RubricVersion: "project-value-v1",
		AgentVersion:  ProjectAgentVersion,
		SkillVersion:  ProjectSkillVersion,
		RequestedRef:  &ref,
	}
	_, err = ParseProjectAnalysisArtifacts(input)
	expectArtifactInvalid(t, err, "does not match the analysis run")

	input.ExpectedRun = &ProjectAnalysisRunIdentity{
		RubricVersion: "project-value-v1",
		AgentVersion:  ProjectAgentVersion,
		SkillVersion:  ProjectSkillVersion,
	}
	if _, err := ParseProjectAnalysisArtifacts(input); err != nil {
		t.Fatal(err)
	}
}

func parseArtifactForRanking(t *testing.T, mutate func(analysis map[string]any)) *ProjectAnalysisArtifact {
	t.Helper()
	analysis := validProjectAnalysisMap()
	if mutate != nil {
		mutate(analysis)
	}
	parsed, err := parseProjectAnalysisArtifact(mustMarshalJSON(t, analysis))
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func setProductScore(analysis map[string]any, painScore, productScore int) {
	scores := analysis["scores"].(map[string]any)
	scores["pain"].(map[string]any)["score"] = painScore
	scores["product_score"] = productScore
}

// TestDeriveProjectBoardEligibility ports the matrix from
// src/lib/__tests__/project-ranking.test.ts.
func TestDeriveProjectBoardEligibility(t *testing.T) {
	base := DeriveProjectBoardEligibility(parseArtifactForRanking(t, nil))
	if !base.TreasureEligible || base.ClassicEligible || len(base.BlockingReasons) != 0 {
		t.Fatalf("base eligibility = %#v", base)
	}

	atThreshold := DeriveProjectBoardEligibility(parseArtifactForRanking(t, func(analysis map[string]any) {
		setProductScore(analysis, 5, 60)
	}))
	if !atThreshold.TreasureEligible {
		t.Fatalf("threshold eligibility = %#v", atThreshold)
	}
	for _, reason := range atThreshold.BlockingReasons {
		if reason == BlockingProductScoreBelowTreasureThreshold {
			t.Fatalf("threshold reasons = %#v", atThreshold.BlockingReasons)
		}
	}

	belowThreshold := DeriveProjectBoardEligibility(parseArtifactForRanking(t, func(analysis map[string]any) {
		setProductScore(analysis, 5, 59)
	}))
	if belowThreshold.TreasureEligible ||
		!containsBlockingReason(belowThreshold.BlockingReasons, BlockingProductScoreBelowTreasureThreshold) {
		t.Fatalf("below-threshold eligibility = %#v", belowThreshold)
	}

	established := DeriveProjectBoardEligibility(parseArtifactForRanking(t, func(analysis map[string]any) {
		analysis["confidence"] = 82
		setProductScore(analysis, 21, 60)
		analysis["exposure"].(map[string]any)["band"] = "established"
		analysis["project"].(map[string]any)["lifecycle"] = "stable_maintenance"
	}))
	if established.TreasureEligible || !established.ClassicEligible {
		t.Fatalf("established eligibility = %#v", established)
	}

	establishedBelow := DeriveProjectBoardEligibility(parseArtifactForRanking(t, func(analysis map[string]any) {
		analysis["confidence"] = 82
		setProductScore(analysis, 21, 59)
		analysis["exposure"].(map[string]any)["band"] = "established"
		analysis["project"].(map[string]any)["lifecycle"] = "stable_maintenance"
	}))
	if establishedBelow.TreasureEligible || establishedBelow.ClassicEligible {
		t.Fatalf("established-below eligibility = %#v", establishedBelow)
	}

	critical := DeriveProjectBoardEligibility(parseArtifactForRanking(t, func(analysis map[string]any) {
		analysis["risks"] = []map[string]any{
			{
				"severity":     "critical",
				"category":     "security",
				"summary":      "The core authentication flow is bypassable.",
				"evidence_ids": []string{"readme-contract"},
			},
		}
	}))
	if critical.TreasureEligible || critical.ClassicEligible ||
		!containsBlockingReason(critical.BlockingReasons, BlockingCriticalAdoptionRisk) {
		t.Fatalf("critical-risk eligibility = %#v", critical)
	}

	// Metadata-only verification never enters the treasure board.
	metadataOnly := DeriveProjectBoardEligibility(parseArtifactForRanking(t, func(analysis map[string]any) {
		analysis["verification_level"] = "metadata_only"
	}))
	if metadataOnly.TreasureEligible ||
		!containsBlockingReason(metadataOnly.BlockingReasons, BlockingVerificationBelowTreasureThreshold) {
		t.Fatalf("metadata-only eligibility = %#v", metadataOnly)
	}

	// Low confidence and unknown exposure block treasure in the TS order:
	// confidence, verification, exposure (no critical risk, score is 87).
	blocked := DeriveProjectBoardEligibility(parseArtifactForRanking(t, func(analysis map[string]any) {
		analysis["confidence"] = 40
		analysis["exposure"].(map[string]any)["band"] = "unknown"
	}))
	expectedOrder := []string{
		BlockingConfidenceBelowTreasureThreshold,
		BlockingExposureNotTreasureEligible,
	}
	if len(blocked.BlockingReasons) != len(expectedOrder) {
		t.Fatalf("blocked reasons = %#v", blocked.BlockingReasons)
	}
	for index, reason := range expectedOrder {
		if blocked.BlockingReasons[index] != reason {
			t.Fatalf("blocked reasons = %#v, want order %#v", blocked.BlockingReasons, expectedOrder)
		}
	}
}

func containsBlockingReason(reasons []BoardBlockingReason, expected BoardBlockingReason) bool {
	for _, reason := range reasons {
		if reason == expected {
			return true
		}
	}
	return false
}

func TestUpstashProjectAnalysisResultCacheContract(t *testing.T) {
	fingerprint := "e149861b2e6bc0bb4b5bc2a3dbec9938ec8de5da9062c1fa9234237f267f10ba"
	expectedKey := "project-analysis:completed:v1:" + fingerprint
	var commands [][]json.RawMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		var command []json.RawMessage
		if err := json.NewDecoder(request.Body).Decode(&command); err != nil {
			t.Fatal(err)
		}
		commands = append(commands, command)
		var operation string
		if err := json.Unmarshal(command[0], &operation); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch operation {
		case "GET":
			_, _ = w.Write([]byte(`{"result":"analysis-1"}`))
		default:
			_, _ = w.Write([]byte(`{"result":"OK"}`))
		}
	}))
	defer server.Close()
	store := &UpstashStatusStore{baseURL: server.URL, token: "token", client: server.Client()}
	ctx := context.Background()

	if err := store.SetCachedProjectAnalysisID(ctx, fingerprint, "analysis-1"); err != nil {
		t.Fatal(err)
	}
	analysisID, err := store.GetCachedProjectAnalysisID(ctx, fingerprint)
	if err != nil || analysisID != "analysis-1" {
		t.Fatalf("cached analysis id = %q, err=%v", analysisID, err)
	}
	if err := store.ClearCachedProjectAnalysisID(ctx, fingerprint); err != nil {
		t.Fatal(err)
	}

	if len(commands) != 3 {
		t.Fatalf("commands = %d", len(commands))
	}
	var setKey, setValue, setExpiry string
	var expirySeconds int
	if err := json.Unmarshal(commands[0][1], &setKey); err != nil || setKey != expectedKey {
		t.Fatalf("SET key = %q err=%v", setKey, err)
	}
	if err := json.Unmarshal(commands[0][2], &setValue); err != nil || setValue != "analysis-1" {
		t.Fatalf("SET value = %q err=%v", setValue, err)
	}
	if err := json.Unmarshal(commands[0][3], &setExpiry); err != nil || setExpiry != "EX" {
		t.Fatalf("SET expiry flag = %q err=%v", setExpiry, err)
	}
	if err := json.Unmarshal(commands[0][4], &expirySeconds); err != nil || expirySeconds != 30*24*60*60 {
		t.Fatalf("SET expiry = %d err=%v", expirySeconds, err)
	}
	var getKey, delOperation, delKey string
	if err := json.Unmarshal(commands[1][1], &getKey); err != nil || getKey != expectedKey {
		t.Fatalf("GET key = %q err=%v", getKey, err)
	}
	if err := json.Unmarshal(commands[2][0], &delOperation); err != nil || delOperation != "DEL" {
		t.Fatalf("DEL operation = %q err=%v", delOperation, err)
	}
	if err := json.Unmarshal(commands[2][1], &delKey); err != nil || delKey != expectedKey {
		t.Fatalf("DEL key = %q err=%v", delKey, err)
	}
}

func TestProjectAnalysisRateLimitUsesLegacyBudget(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		var command []json.RawMessage
		if err := json.NewDecoder(request.Body).Decode(&command); err != nil {
			t.Fatal(err)
		}
		var operation, current string
		var keyCount, budget, window int64
		if err := json.Unmarshal(command[0], &operation); err != nil || operation != "EVAL" {
			t.Fatalf("operation=%q err=%v", operation, err)
		}
		if err := json.Unmarshal(command[2], &keyCount); err != nil || keyCount != 3 {
			t.Fatalf("keyCount=%d err=%v", keyCount, err)
		}
		if err := json.Unmarshal(command[3], &current); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(command[6], &budget); err != nil || budget != 5 {
			t.Fatalf("budget=%d err=%v", budget, err)
		}
		if err := json.Unmarshal(command[8], &window); err != nil || window != time.Hour.Milliseconds() {
			t.Fatalf("window=%d err=%v", window, err)
		}
		if !strings.HasPrefix(current, "rl:project-analysis:198.51.100.10:") {
			t.Fatalf("current=%q", current)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":[4,5]}`))
	}))
	defer server.Close()
	store := &UpstashStatusStore{baseURL: server.URL, token: "token", client: server.Client()}
	result, err := store.LimitProjectAnalysis(context.Background(), "198.51.100.10", now)
	if err != nil || !result.Success || result.Limit != 5 || result.Remaining != 4 {
		t.Fatalf("result=%#v err=%v", result, err)
	}
}
