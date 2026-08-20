package backend

import (
	"strings"
	"testing"
	"time"
)

func validFeedAssessment() ProjectAssessment {
	analyzedAt := time.Date(2026, 8, 13, 1, 2, 3, 0, time.UTC)
	artifact := &ProjectAnalysisArtifact{
		SchemaVersion: ProjectAnalysisSchemaVersion,
		AnalysisID:    "analysis-feed-1",
		Repository: ProjectAnalysisRepository{
			RepoKey:           "owner/useful-tool",
			CanonicalURL:      "https://github.com/owner/useful-tool",
			ResolvedCommitSHA: strings.Repeat("a", 40),
		},
		Project: ProjectInfo{
			Name:          "Useful Tool",
			Summary:       "Solves a useful problem",
			TargetUsers:   []string{"Developers"},
			PainStatement: "The old workflow is slow",
			ProjectType:   "micro_tool",
			Lifecycle:     "active_evolution",
			ProductTags: []ProductTag{{Namespace: "use_case", NamespaceExplicit: true, Slug: "developer-productivity", Labels: ProductTagLabels{
				Zh: "开发者生产力", En: "Developer productivity",
			}, EvidenceIDs: []string{"source:readme"}}},
		},
		Scores:            ProjectAnalysisScores{ProductScore: 72},
		Confidence:        80,
		VerificationLevel: "source_inspected",
		Exposure:          ProjectExposure{Band: "low"},
		AnalyzedAt:        analyzedAt.Format(time.RFC3339),
	}
	return ProjectAssessment{
		RepoKey:           "owner/useful-tool",
		LatestAnalysisID:  artifact.AnalysisID,
		ProductScore:      72,
		Confidence:        80,
		VerificationLevel: artifact.VerificationLevel,
		ExposureBand:      "low",
		ResolvedCommitSHA: artifact.Repository.ResolvedCommitSHA,
		AnalyzedAt:        analyzedAt.UnixMilli(),
		Analysis:          artifact,
	}
}

func TestBuildFeedProjectProjectionAppliesFeedSpecificGate(t *testing.T) {
	assessment := validFeedAssessment()
	language := "Go"
	projection, err := BuildFeedProjectProjection(assessment, &ProjectOverview{Repo: ProjectRepo{
		RepoKey: "owner/useful-tool", OwnerLogin: "owner", Name: "useful-tool",
		Language: &language, Topics: []string{"CLI", "productivity", "cli"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if !projection.Publishable || projection.BlockedReason != "" {
		t.Fatalf("expected publishable projection: %#v", projection)
	}
	if projection.ItemID != "owner:useful-tool" || len(projection.Topics) != 2 {
		t.Fatalf("identity/normalization mismatch: %#v", projection)
	}
	if strings.Contains(projection.Descriptor, "Developer productivity") || len(projection.SourceHash) != 64 {
		t.Fatalf("unreviewed product tag leaked into base descriptor or hash is missing: %#v", projection)
	}

	// A low score is a ranking feature, not a Feed publication gate.
	assessment.ProductScore = 1
	assessment.Analysis.Scores.ProductScore = 1
	lowScore, err := BuildFeedProjectProjection(assessment, nil)
	if err != nil || !lowScore.Publishable {
		t.Fatalf("low-score project should remain publishable: projection=%#v err=%v", lowScore, err)
	}
}

func TestBuildFeedProjectProjectionBlocksOnlyContractRisks(t *testing.T) {
	assessment := validFeedAssessment()
	assessment.Analysis.Risks = []ProjectRisk{{Severity: "high", Category: "maintenance"}}
	projection, err := BuildFeedProjectProjection(assessment, nil)
	if err != nil || !projection.Publishable {
		t.Fatalf("high maintenance risk should be rankable: %#v err=%v", projection, err)
	}

	assessment.Analysis.Risks = append(assessment.Analysis.Risks, ProjectRisk{Severity: "high", Category: "security"})
	projection, err = BuildFeedProjectProjection(assessment, nil)
	if err != nil {
		t.Fatal(err)
	}
	if projection.Publishable || projection.BlockedReason != "high_risk:security" || !projection.RiskOverrideEligible {
		t.Fatalf("security gate not applied: %#v", projection)
	}

	assessment.Analysis.Risks = []ProjectRisk{{Severity: "critical", Category: "other"}}
	projection, err = BuildFeedProjectProjection(assessment, nil)
	if err != nil || projection.Publishable || projection.BlockedReason != "critical_risk:other" || projection.RiskOverrideEligible {
		t.Fatalf("critical gate not applied: %#v err=%v", projection, err)
	}
}

func TestBuildFeedProjectProjectionRejectsStaleIdentity(t *testing.T) {
	assessment := validFeedAssessment()
	assessment.LatestAnalysisID = "different"
	if _, err := BuildFeedProjectProjection(assessment, nil); err == nil {
		t.Fatal("expected mismatched analysis identity to fail")
	}
}
