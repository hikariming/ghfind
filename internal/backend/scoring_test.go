package backend

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

type scoreFixture struct {
	Input    RawMetrics `json:"input"`
	Expected Scoring    `json:"expected"`
}

func TestScoreMatchesCanonicalNodeFixtures(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate Go test file")
	}
	path := filepath.Join(filepath.Dir(thisFile), "..", "..", "src", "lib", "__tests__", "score-fixtures.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read canonical Node scoring fixtures: %v", err)
	}
	fixtures := map[string]scoreFixture{}
	if err := json.Unmarshal(contents, &fixtures); err != nil {
		t.Fatalf("decode canonical Node scoring fixtures: %v", err)
	}
	for name, fixture := range fixtures {
		t.Run(name, func(t *testing.T) {
			got := Score(fixture.Input)
			if !reflect.DeepEqual(got.SubScores, fixture.Expected.SubScores) || got.BaseScore != fixture.Expected.BaseScore {
				gotJSON, _ := json.MarshalIndent(got, "", "  ")
				wantJSON, _ := json.MarshalIndent(fixture.Expected, "", "  ")
				t.Fatalf("six-dimension score mismatch\n got: %s\nwant: %s", gotJSON, wantJSON)
			}
			if got.RiskAssessment.Version != "v10" || got.TotalPenalty < 0 || got.TotalPenalty > 25 {
				t.Fatalf("invalid v10 risk output: %#v", got.RiskAssessment)
			}
		})
	}
}

func ptrFloat(value float64) *float64 { return &value }

func TestOwnPRCommunityCredit(t *testing.T) {
	m := neutralRiskMetrics()
	m.MergedPRCount = 200
	m.OwnPRCommunity = ptrFloat(1)
	if got := ownPRCommunityCredit(m); got != 0 {
		t.Fatalf("missing external_merged_pr_count must keep v10: got %v", got)
	}

	zero := 0.0
	m.ExternalMergedPRCount = &zero
	m.OwnPRCommunity = ptrFloat(0)
	if got := ownPRCommunityCredit(m); got != 0 {
		t.Fatalf("A=0 must add nothing: got %v", got)
	}

	m.OwnPRCommunity = ptrFloat(1)
	if got := ownPRCommunityCredit(m); got != 6 {
		t.Fatalf("saturated own PRs with A=1: got %v want 6", got)
	}

	lift := m
	lift.MergedPRCount = 50
	lift.TotalPRCount = 55
	without := lift
	without.OwnPRCommunity = nil
	v10 := Score(without)
	v13 := Score(lift)
	if v13.SubScores.ContributionQuality <= v10.SubScores.ContributionQuality {
		t.Fatalf("community credit must raise contribution quality: v10=%v v13=%v", v10.SubScores.ContributionQuality, v13.SubScores.ContributionQuality)
	}
	if v13.FinalScore <= v10.FinalScore || v13.FinalScore-v10.FinalScore > 6 {
		t.Fatalf("v13 must not decrease or spike: v10=%v v13=%v", v10.FinalScore, v13.FinalScore)
	}
	capped := Score(m)
	m.OwnPRCommunity = nil
	if capped.FinalScore < Score(m).FinalScore {
		t.Fatalf("capped community credit must not decrease: v10=%v v13=%v", Score(m).FinalScore, capped.FinalScore)
	}
	m.OwnPRCommunity = ptrFloat(1)

	m.MergedPRCount = 400
	m.OwnPRCommunity = ptrFloat(0.5)
	if got := ownPRCommunityCredit(m); got != 3 {
		t.Fatalf("A=0.5 saturates at 3: got %v", got)
	}

	m.MergedPRCount = 50
	external := 40.0
	m.ExternalMergedPRCount = &external
	m.OwnPRCommunity = ptrFloat(1)
	want := LogRatio(10, 200) * 6
	if got := ownPRCommunityCredit(m); math.Abs(got-want) > 1e-9 {
		t.Fatalf("partial own volume: got %v want %v", got, want)
	}
}

func TestPublicScoreReadOrder(t *testing.T) {
	if publicScoreVersionClause("score_version") != "score_version IN (?, ?, ?)" {
		t.Fatalf("clause=%q", publicScoreVersionClause("score_version"))
	}
	args := publicScoreVersionArgs()
	if len(args) != 3 || args[0] != "v14" || args[1] != "v13" || args[2] != "v10" {
		t.Fatalf("args=%v", args)
	}
	if !isPublicScoreVersion("v14") || !isPublicScoreVersion("v13") || !isPublicScoreVersion("v10") || isPublicScoreVersion("v12") {
		t.Fatal("v14 and leftover v13 are public; retired v12 is not")
	}
}

func TestRoundToEvenMatchesPublishedBoundaryRule(t *testing.T) {
	for _, test := range []struct {
		value  float64
		digits int
		want   float64
	}{
		{17.25, 1, 17.2},
		{17.35, 1, 17.4},
		{34.205, 2, 34.2},
		{34.215, 2, 34.22},
	} {
		if got := roundToEven(test.value, test.digits); got != test.want {
			t.Errorf("roundToEven(%v, %d) = %v, want %v", test.value, test.digits, got, test.want)
		}
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
	if scanCacheKey(" Maker ") != "scan:v14:v5:maker" || scanFlightKey(" Maker ") != "lock:scan:v14:v5:maker" {
		t.Fatal("derived-impact cache must isolate v14")
	}
}
