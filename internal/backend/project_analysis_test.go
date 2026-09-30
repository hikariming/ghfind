package backend

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
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

func mustMarshalJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
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

func TestParseProjectAnalysisArtifactsKeepsLegacyReadable(t *testing.T) {
	analysis := validProjectAnalysisMap()
	project := analysis["project"].(map[string]any)
	delete(project, "product_tags")
	analysis["schema_version"] = LegacyProjectAnalysisSchemaVersion
	analysis["agent_version"] = "project-evaluator-v1"
	analysis["skill_version"] = "ghfind-project-evaluator-v1"
	parsed, err := parseProjectAnalysisArtifact(mustMarshalJSON(t, analysis))
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Project.ProductTags) != 0 {
		t.Fatalf("legacy product tags = %#v", parsed.Project.ProductTags)
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
	parsed, err := parseProjectAnalysisArtifact(mustMarshalJSON(t, analysis))
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Project.ProductTags) != 3 || parsed.Project.ProductTags[0].Namespace != "use_case" || parsed.Project.ProductTags[0].NamespaceExplicit {
		t.Fatalf("v2 product tags must remain inferred proposals: %#v", parsed.Project.ProductTags)
	}
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
	parsed, err := parseProjectAnalysisArtifact(mustMarshalJSON(t, analysis))
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Project.ProjectType != "micro_tool" {
		t.Fatalf("project type = %q", parsed.Project.ProjectType)
	}
	if parsed.Risks[0].Summary != "Only one operating system is documented." {
		t.Fatalf("risk summary = %q", parsed.Risks[0].Summary)
	}
}

func TestParseProjectAnalysisArtifactsRejectsUnknownTypesAndEmptyRisks(t *testing.T) {
	analysis := validProjectAnalysisMap()
	analysis["project"].(map[string]any)["project_type"] = "tiny_project"
	_, err := parseProjectAnalysisArtifact(mustMarshalJSON(t, analysis))
	expectArtifactInvalid(t, err, "project_type")

	analysis = validProjectAnalysisMap()
	analysis["risks"] = []map[string]any{
		{"severity": "low", "category": "other", "evidence_ids": []string{"readme-contract"}},
	}
	_, err = parseProjectAnalysisArtifact(mustMarshalJSON(t, analysis))
	expectArtifactInvalid(t, err, "summary")
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
