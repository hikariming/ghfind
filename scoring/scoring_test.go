package scoring

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
	path := filepath.Join(filepath.Dir(thisFile), "fixtures", "score-fixtures.json")
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
