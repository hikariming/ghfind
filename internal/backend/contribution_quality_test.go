package backend

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"testing"
)

func TestContributionQualityRecognitionGolden(t *testing.T) {
	data, err := os.ReadFile("../../src/lib/__tests__/contribution-quality-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name     string     `json:"name"`
		Metrics  RawMetrics `json:"metrics"`
		Expected Scoring    `json:"expected"`
		Cap      float64    `json:"cap"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, f := range fixtures {
		t.Run(f.Name, func(t *testing.T) {
			got := Score(f.Metrics)
			if got.SubScores != f.Expected.SubScores || got.FinalScore != f.Expected.FinalScore || got.BaseScore != f.Expected.BaseScore || got.TotalPenalty != f.Expected.TotalPenalty || got.Tier != f.Expected.Tier || !reflect.DeepEqual(got.RedFlags, f.Expected.RedFlags) {
				t.Fatalf("got %+v want %+v", got, f.Expected)
			}
			cap, ok := lowPrestigeBulkContributionCap(f.Metrics)
			if !ok || math.Abs(cap-f.Cap) > 1e-12 {
				t.Fatalf("cap %v want %v", cap, f.Cap)
			}
		})
	}
	base := fixtures[0].Metrics
	for _, stars := range []float64{0, 950, 1000, 1050, 2507, 1000000} {
		m := base
		m.MaxStars = stars
		if got := Score(m).SubScores.ContributionQuality; got < 19 || got > 20 {
			t.Fatalf("own stars bypassed the smooth ceiling: %v", got)
		}
	}
	for _, n := range []float64{0, 1, 22, 10000} {
		m := base
		m.SelfClosedExternalPRCount, m.SelfClosedOwnRepoPRCount = ptrFloat(n), ptrFloat(n)
		if !reflect.DeepEqual(Score(m), Score(base)) {
			t.Fatal("self-closure must remain neutral")
		}
	}
	unknown := base
	unknown.ExternalMergedPRCount = nil
	if cap, _ := lowPrestigeBulkContributionCap(unknown); math.Abs(cap-21.944) > 1e-12 {
		t.Fatalf("unknown ownership cap %v", cap)
	}
}
