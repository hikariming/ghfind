package backend

import (
	"encoding/json"
	"math"
	"os"
	"testing"
	"time"
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
			got := ComputeOrgRepoAttribution(r, nil, []string{"person/project"}, c.Facts.ReleaseAuthor, c.Facts.MaintainerFile, "fixture-account-045", "")
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

func TestContributionContentSharedFixtures(t *testing.T) {
	data, err := os.ReadFile("../../src/lib/__tests__/contribution-content-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Churn []struct {
			Name     string         `json:"name"`
			Repo     string         `json:"repo"`
			Files    []PRFileChange `json:"files"`
			Expected struct {
				Core  float64 `json:"core"`
				Total float64 `json:"total"`
				Fresh float64 `json:"fresh"`
			} `json:"expected"`
		} `json:"churn"`
		Contributors []struct {
			Name                string           `json:"name"`
			Login               string           `json:"login"`
			Truncated           bool             `json:"truncated"`
			HistoryTotal        float64          `json:"history_total"`
			FallbackUserCommits float64          `json:"fallback_user_commits"`
			Rows                []contributorRow `json:"rows"`
			Expected            struct {
				UserCommits    float64 `json:"user_commits"`
				TotalCommits   float64 `json:"total_commits"`
				LeadingCommits float64 `json:"leading_commits"`
			} `json:"expected"`
		} `json:"contributors"`
	}
	if err = json.Unmarshal(data, &fx); err != nil {
		t.Fatal(err)
	}
	for _, c := range fx.Churn {
		core, total, fresh := weightedCoreChurn(c.Files, c.Repo)
		if math.Abs(core-c.Expected.Core) > 1e-9 || total != c.Expected.Total || fresh != c.Expected.Fresh {
			t.Fatalf("%s: got %v/%v/%v", c.Name, core, total, fresh)
		}
	}
	for _, c := range fx.Contributors {
		user, total, leading := summarizeContributors(c.Rows, c.Login, c.Truncated, c.HistoryTotal, c.FallbackUserCommits)
		if user != c.Expected.UserCommits || total != c.Expected.TotalCommits || leading != c.Expected.LeadingCommits {
			t.Fatalf("%s: got %v/%v/%v", c.Name, user, total, leading)
		}
	}
}

func TestTopStarredQualityDoesNotDoubleCountShare(t *testing.T) {
	now := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	name, owner, lang, pushed := "org-x/app-y", "org-x", "TypeScript", "2026-09-01T00:00:00Z"
	desc := "Production scheduling service with API and dashboard"
	repo := TopRepo{Name: "app-y", OwnerLogin: &owner, NameWithOwner: &name, Stars: 3000, Forks: 300, Size: 9000, Language: &lang, Description: &desc, PushedAt: &pushed, AttributedOriginal: true}
	full, partial := 1.0, 0.3
	repo.AttributionShare = &full
	a, _ := TopStarredOriginalRepoQuality([]TopRepo{repo}, "user-a", now)
	repo.AttributionShare = &partial
	b, _ := TopStarredOriginalRepoQuality([]TopRepo{repo}, "user-a", now)
	if a <= 0.5 || a != b {
		t.Fatalf("quality full=%v partial=%v", a, b)
	}
}
