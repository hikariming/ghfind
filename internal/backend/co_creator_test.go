package backend

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

func TestCoCreatorSharedEvidence(t *testing.T) {
	data, err := os.ReadFile("../../src/lib/__tests__/co-creator-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string         `json:"name"`
		Facts    CoCreatorFacts `json:"facts"`
		Share    float64        `json:"share"`
		Eligible bool           `json:"eligible"`
		Owner    string         `json:"owner"`
		Repo     string         `json:"repo"`
		Fork     bool           `json:"fork"`
		Private  bool           `json:"private"`
		Topics   []string       `json:"topics"`
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			if math.Abs(coCreatorShare(c.Facts)-c.Share) > 1e-12 {
				t.Fatal("share mismatch")
			}
			name, owner := c.Repo, c.Owner
			if name == "" {
				name = "person/project"
			}
			if owner == "" {
				owner = "person"
			}
			r := ContribRepoAgg{Repo: name, OwnerLogin: owner, IsFork: c.Fork, IsPrivate: c.Private, Topics: c.Topics, CoCreatorFacts: &c.Facts}
			got := ComputeOrgRepoAttribution(r, nil, []string{"person/project"}, c.Facts.ReleaseAuthor, c.Facts.MaintainerFile, "maker", "")
			if !c.Eligible || c.Share == 0 {
				if got != nil {
					t.Fatal("unexpected attribution")
				}
			} else if got == nil || math.Abs(*got.Share-c.Share) > 1e-12 {
				t.Fatal("attribution mismatch")
			}
		})
	}
}
func TestCoCreatorBudget(t *testing.T) {
	repos := make([]TopRepo, 8)
	for i := range repos {
		repos[i].AttributionShare = floatPointer(1)
	}
	total := 0.0
	for _, r := range budgetCoCreatorShares(repos) {
		total += *r.AttributionShare
	}
	if total >= 2 {
		t.Fatal(total)
	}
}

func TestContinuousContributionCapSharedBoundaries(t *testing.T) {
	data, err := os.ReadFile("../../src/lib/__tests__/contribution-cap-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string     `json:"name"`
		Metrics  RawMetrics `json:"metrics"`
		Expected float64    `json:"expected"`
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			value, ok := lowPrestigeBulkContributionCap(c.Metrics)
			if !ok || math.Abs(value-c.Expected) > 1e-10 {
				t.Fatalf("got %v, want %v", value, c.Expected)
			}
		})
	}
}
