package backend

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSmoothImpactArchetypes(t *testing.T) {
	data, err := os.ReadFile("../../src/lib/__tests__/smooth-impact-archetypes.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name                string     `json:"name"`
		Metrics             RawMetrics `json:"metrics"`
		EcosystemImpact     float64    `json:"ecosystem_impact"`
		ContributionQuality float64    `json:"contribution_quality"`
		FinalScore          float64    `json:"final_score"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 4 {
		t.Fatalf("archetypes %d", len(cases))
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			got := Score(c.Metrics)
			if got.SubScores.EcosystemImpact != c.EcosystemImpact || got.SubScores.ContributionQuality != c.ContributionQuality || got.FinalScore != c.FinalScore {
				t.Fatalf("got eco %v cq %v final %v", got.SubScores.EcosystemImpact, got.SubScores.ContributionQuality, got.FinalScore)
			}
		})
	}
}
