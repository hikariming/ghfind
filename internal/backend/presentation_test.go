package backend

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

func TestPresentationParity(t *testing.T) {
	data, err := os.ReadFile("../../src/lib/__tests__/presentation-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string     `json:"name"`
		PRs      []RecentPR `json:"prs"`
		OwnRepos []string   `json:"own_repos"`
		Expected RawMetrics `json:"expected"`
		Discount float64    `json:"discount"`
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			var m RawMetrics
			applyPresentationSignals(&m, c.PRs, "maker", c.OwnRepos)
			for _, pair := range [][2]*float64{{m.PresentationChurnShare, c.Expected.PresentationChurnShare}, {m.PresentationCoreChurnShare, c.Expected.PresentationCoreChurnShare}, {m.PresentationRepoConcentration, c.Expected.PresentationRepoConcentration}, {m.PresentationPRSample, c.Expected.PresentationPRSample}, {m.PresentationCorePRCount, c.Expected.PresentationCorePRCount}} {
				if math.Abs(*pair[0]-*pair[1]) > 1e-12 {
					t.Fatalf("signals: %+v expected %+v", m, c.Expected)
				}
			}
			if math.Abs(presentationDiscount(m)-c.Discount) > 1e-12 {
				t.Fatal("discount mismatch")
			}
		})
	}
}

func TestPresentationFullScoreParity(t *testing.T) {
	data, err := os.ReadFile("../../src/lib/__tests__/presentation-score-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string     `json:"name"`
		Metrics  RawMetrics `json:"metrics"`
		Expected struct {
			FinalScore float64   `json:"final_score"`
			SubScores  SubScores `json:"sub_scores"`
		} `json:"expected"`
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			got := Score(c.Metrics)
			if got.FinalScore != c.Expected.FinalScore || got.SubScores != c.Expected.SubScores {
				t.Fatalf("score %+v want %+v", got, c.Expected)
			}
		})
	}
}

func TestFractionalPresentationRepositoryCredit(t *testing.T) {
	repo := "org/engine"
	sample := impactCodeSample([]RecentPR{{Repo: &repo, ChangedFiles: 2, FileChanges: []PRFileChange{{Path: "src/main.ts", Additions: 900}, {Path: "README.md", Additions: 100}}}})
	if sample.PRSample != 1 || math.Abs(sample.CodePRSample-.9) > 1e-12 {
		t.Fatalf("fractional sample %+v", sample)
	}
}

func TestLegacyPresentationUIStylesRemainCore(t *testing.T) {
	title, repo := "fix styling", "patternfly/patternfly"
	sample := impactCodeSample([]RecentPR{{Title: &title, Repo: &repo, Files: []string{"src/button.scss"}}})
	if sample.CodePRSample != 1 {
		t.Fatal(sample)
	}
}
