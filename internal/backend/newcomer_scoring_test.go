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

type newcomerFixtureCase struct {
	Name      string                     `json:"name"`
	Overrides map[string]json.RawMessage `json:"overrides"`
	Omit      []string                   `json:"omit"`
	Expected  struct {
		SubScores    SubScores `json:"sub_scores"`
		BaseScore    float64   `json:"base_score"`
		FinalScore   float64   `json:"final_score"`
		TotalPenalty float64   `json:"total_penalty"`
		Bonus        float64   `json:"bonus"`
	} `json:"expected"`
}

func newcomerFixtures(t *testing.T) (map[string]json.RawMessage, []newcomerFixtureCase) {
	t.Helper()
	_, thisFile, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(thisFile), "..", "..", "src", "lib", "__tests__", "newcomer-score-fixtures.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Metrics map[string]json.RawMessage `json:"metrics"`
		Cases   []newcomerFixtureCase      `json:"cases"`
	}
	if err := json.Unmarshal(contents, &data); err != nil {
		t.Fatal(err)
	}
	return data.Metrics, data.Cases
}

func newcomerMetrics(t *testing.T, base map[string]json.RawMessage, row newcomerFixtureCase) RawMetrics {
	t.Helper()
	merged := make(map[string]json.RawMessage)
	for key, value := range base {
		merged[key] = value
	}
	for key, value := range row.Overrides {
		merged[key] = value
	}
	for _, key := range row.Omit {
		delete(merged, key)
	}
	encoded, err := json.Marshal(merged)
	if err != nil {
		t.Fatal(err)
	}
	var m RawMetrics
	if err := json.Unmarshal(encoded, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestSuperNewcomerSharedFixtures(t *testing.T) {
	base, rows := newcomerFixtures(t)
	for _, row := range rows {
		t.Run(row.Name, func(t *testing.T) {
			m := newcomerMetrics(t, base, row)
			got := Score(m)
			risk, _, _, penalty := AssessRisk(m)
			bonus := newcomerMaturityBonus(m, got.SubScores, risk, penalty)
			if !reflect.DeepEqual(got.SubScores, row.Expected.SubScores) || got.BaseScore != row.Expected.BaseScore || got.FinalScore != row.Expected.FinalScore || got.TotalPenalty != row.Expected.TotalPenalty {
				t.Fatalf("score mismatch: got %#v; expected %#v", got, row.Expected)
			}
			if math.Abs(bonus-row.Expected.Bonus) > 1e-9 {
				t.Fatalf("bonus %v, want %v", bonus, row.Expected.Bonus)
			}
			m.CreatedAt = nil
			previous := Score(m)
			delta := got.SubScores.AccountMaturity - previous.SubScores.AccountMaturity
			if delta < 0 || delta > 4.00000001 || got.SubScores.AccountMaturity > 10 {
				t.Fatalf("unbounded maturity delta: %v", delta)
			}
			got.SubScores.AccountMaturity = previous.SubScores.AccountMaturity
			if !reflect.DeepEqual(got.SubScores, previous.SubScores) || !reflect.DeepEqual(got.RiskAssessment, previous.RiskAssessment) {
				t.Fatal("bonus changed another dimension or risk")
			}
		})
	}
}

func TestSuperNewcomerDecayAndBounds(t *testing.T) {
	base, _ := newcomerFixtures(t)
	m := newcomerMetrics(t, base, newcomerFixtureCase{})
	last := 4.0
	for month := 0; month <= 48; month++ {
		m.AccountAgeYears = float64(month) / 12
		got := Score(m)
		risk, _, _, penalty := AssessRisk(m)
		bonus := newcomerMaturityBonus(m, got.SubScores, risk, penalty)
		if bonus < 0 || bonus > last+1e-12 {
			t.Fatalf("non-monotonic bonus %v at month %d", bonus, month)
		}
		last = bonus
		if month >= 36 && bonus != 0 {
			t.Fatal("bonus did not join old curve")
		}
	}
	for _, age := range []float64{-1, math.NaN(), math.Inf(1)} {
		m.AccountAgeYears = age
		risk, _, _, penalty := AssessRisk(m)
		if newcomerMaturityBonus(m, SubScores{}, risk, penalty) != 0 {
			t.Fatal("invalid age earned bonus")
		}
	}
}
