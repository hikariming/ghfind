package backend

import (
	"encoding/json"
	"testing"
)

func ptrFloat(value float64) *float64 { return &value }

func TestPublicScoreReadOrder(t *testing.T) {
	if publicScoreVersionClause("score_version") != "score_version IN (?, ?, ?, ?, ?, ?, ?, ?)" {
		t.Fatalf("clause=%q", publicScoreVersionClause("score_version"))
	}
	args := publicScoreVersionArgs()
	if len(args) != 8 || args[0] != "v19" || args[1] != "v18" || args[2] != "v17" || args[3] != "v16" || args[4] != "v15" || args[5] != "v14" || args[6] != "v13" || args[7] != "v10" {
		t.Fatalf("args=%v", args)
	}
	if !isPublicScoreVersion("v14") || !isPublicScoreVersion("v13") || !isPublicScoreVersion("v10") || isPublicScoreVersion("v12") {
		t.Fatal("v14 and leftover v13 are public; retired v12 is not")
	}
}

// The shared Upstash scan cache is read by both runtimes, and the Node scorer
// distinguishes `undefined` (unmeasured) from `null` (a real value). Go must
// omit optional metric keys when they are nil, keep explicit nulls for fields
// typed `| null` on the Node side, and never serialize required arrays as
// null.
func TestScanResultJSONHonorsNodeNullSemantics(t *testing.T) {
	scan := ScanResult{
		Metrics:       RawMetrics{Username: "alice"},
		TopRepos:      []TopRepo{},
		RecentPRs:     []RecentPR{},
		FloodPRTitles: []string{},
	}
	encoded, err := json.Marshal(scan)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	metrics, ok := payload["metrics"].(map[string]any)
	if !ok {
		t.Fatalf("metrics missing in %s", encoded)
	}
	for _, optional := range []string{
		"top_repo_engagement_ratio", "impact_quality_cap",
		"maintainer_closed_unmerged_pr_count", "self_closed_external_pr_count",
		"self_closed_own_repo_pr_count", "recent_doc_like_pr_count",
		"recent_external_doc_like_pr_count", "workflow_landed_pr_count",
	} {
		if _, present := metrics[optional]; present {
			t.Errorf("optional metric %q must be omitted when nil, got %v", optional, metrics[optional])
		}
	}
	for _, nullable := range []string{"profile_url", "avatar_url", "name", "days_since_last_activity", "top_repo_pr_target"} {
		value, present := metrics[nullable]
		if !present || value != nil {
			t.Errorf("nullable metric %q must be present as explicit null, present=%v value=%v", nullable, present, value)
		}
	}
	for _, array := range []string{"top_repos", "recent_prs", "flood_pr_titles"} {
		value, present := payload[array]
		if !present {
			t.Errorf("required array %q missing", array)
			continue
		}
		if _, isArray := value.([]any); !isArray {
			t.Errorf("required array %q serialized as %T, want JSON array", array, value)
		}
	}
}

func TestV10RiskBreakdownAtTwentyFivePointCap(t *testing.T) {
	m := neutralRiskMetrics()
	m.NonemptyOriginalRepoCount = 0
	m.Following, m.Followers = 5000, 1
	m.PRFloodSuspect, m.StarInflationSuspect = true, true
	m.TopRepoPRShare, m.TemplatedPRRatio = 1, 1
	m.RecentMergedPRSample, m.ExternalTrivialPRCount = 30, 30
	got := Score(m)
	if got.RiskAssessment.Version != "v10" || got.TotalPenalty < 0 || got.TotalPenalty > 25 {
		t.Fatalf("invalid v10 cap: %#v", got)
	}
	detail := &ProfileDetail{SubScores: got.SubScores, FinalScore: got.FinalScore}
	if !validProfileScoring(&got, detail) {
		t.Fatal("v10 score lost its complete profile breakdown")
	}
	encoded, err := json.Marshal(got.RiskAssessment)
	if err != nil || parseRiskAssessment(string(encoded)) == nil {
		t.Fatal("stored v10 risk assessment was rejected")
	}
	got.TotalPenalty = 40
	got.RiskAssessment.AppliedPenalty = 40
	got.RiskAssessment.RiskScore = 100
	if validProfileScoring(&got, detail) {
		t.Fatal("v10 must keep the 25-point cap")
	}
}

func TestScanCacheSeparatesDerivedImpactVersions(t *testing.T) {
	if scanCacheKey(" fixture-account-045 ") != "scan:v19:v8:fixture-account-045" || scanFlightKey(" fixture-account-045 ") != "lock:scan:v19:v8:fixture-account-045" {
		t.Fatal("derived-impact cache must isolate score v19 and collection v8")
	}
}
