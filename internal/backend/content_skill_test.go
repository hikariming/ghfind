package backend

import (
	"encoding/json"
	"math"
	"os"
	"testing"
	"time"
)

func TestContentSkillParity(t *testing.T) {
	data, err := os.ReadFile("../../src/lib/__tests__/content-skill-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name   string
		Repo   TopRepo
		Share  float64
		Weight float64
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if math.Abs(ContentSkillShare(c.Repo)-c.Share) > 1e-12 || math.Abs(OriginalRepoStarWeight(c.Repo, time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC))-c.Weight) > 1e-12 {
				t.Fatal("content curve parity")
			}
		})
	}
	zero, one := 0.0, 1.0
	if originalProjectQuality(RawMetrics{NonemptyOriginalRepoCount: 1, TotalStars: 5000, MaxStars: 5000, WeightedTotalStars: &zero, WeightedMaxStars: &zero, BestOriginalRepoQualityScore: &one}) != 6 {
		t.Fatal("weighted zero must preserve substance only")
	}
}

func TestContentSkillScores(t *testing.T) {
	data, err := os.ReadFile("../../src/lib/__tests__/content-skill-score-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string
		Metrics  RawMetrics
		Expected Scoring
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			actual := Score(c.Metrics)
			if actual.FinalScore != c.Expected.FinalScore || actual.SubScores != c.Expected.SubScores {
				t.Fatalf("got %+v, want %+v", actual, c.Expected)
			}
		})
	}
}
