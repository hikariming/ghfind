package backend

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

func TestV10ScoreHasNoNewcomerMaturityBonus(t *testing.T) {
	_, thisFile, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(thisFile), "..", "..", "src", "lib", "__tests__", "newcomer-score-fixtures.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Metrics json.RawMessage `json:"metrics"`
	}
	if err := json.Unmarshal(contents, &data); err != nil {
		t.Fatal(err)
	}
	var m RawMetrics
	if err := json.Unmarshal(data.Metrics, &m); err != nil {
		t.Fatal(err)
	}
	got := Score(m)
	agePoints := min(m.AccountAgeYears/6, 1) * 7
	spanPoints := 3.0
	if m.ContributionYearsActive == 0 {
		spanPoints = 0
	} else if m.ContributionYearsActive == 1 {
		spanPoints = 1
	} else if m.ContributionYearsActive == 2 {
		spanPoints = 2
	}
	want := roundToEven(agePoints+spanPoints, 1)
	if got.SubScores.AccountMaturity != want {
		t.Fatalf("maturity %v, want %v", got.SubScores.AccountMaturity, want)
	}
	m.CreatedAt = nil
	previous := Score(m)
	if !reflect.DeepEqual(got.SubScores, previous.SubScores) || got.FinalScore != previous.FinalScore {
		t.Fatal("created_at changed v10 scoring")
	}
}
