package backend

import (
	"encoding/json"
	"math"
	"os"
	"strings"
	"testing"
)

func TestSmoothImpactSharedFixtures(t *testing.T) {
	data, err := os.ReadFile("../../src/lib/__tests__/smooth-impact-fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string             `json:"name"`
		Repo     ContribRepoAgg     `json:"repo"`
		Expected map[string]float64 `json:"expected"`
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, f := range cases {
		t.Run(f.Name, func(t *testing.T) {
			impact := ComputeImpactFromContribMap([]ContribRepoAgg{f.Repo}, "maker")
			actual := map[string]float64{"weight": attributedCreatorWeight(f.Repo, "maker"), "evidence": impactEvidenceWeight(f.Repo), "discount": impactStarDiscount(f.Repo), "star_weight": ownStarWeight(f.Repo.Stars), "impact_prestige_score": impact.ImpactPrestigeScore, "impact_depth_raw": impact.ImpactDepthRaw, "impact_repo_count": impact.ImpactRepoCount}
			for k, v := range actual {
				if math.Abs(v-f.Expected[k]) > 1e-12 {
					t.Errorf("%s=%v want %v", k, v, f.Expected[k])
				}
			}
		})
	}
	for _, severity := range []float64{0, .9} {
		values := []float64{}
		for _, f := range cases {
			if strings.HasPrefix(f.Name, "farm-stars-") && f.Repo.StarInflationSeverity != nil && *f.Repo.StarInflationSeverity == severity {
				values = append(values, attributedCreatorWeight(f.Repo, "maker")*LogRatio(f.Repo.Stars, 100000))
			}
		}
		if len(values) != 4 || values[2]-values[1] >= values[1]-values[0] || values[3]-values[2] >= values[2]-values[1] {
			t.Fatal("star returns must diminish", values)
		}
		if severity > 0 && values[3] >= .002 {
			t.Fatal("suspicious star reward too high", values)
		}
	}

	base := cases[0].Repo
	for _, forks := range []bool{true, false} {
		prev := ImpactMetrics{}
		lastWeight, lastGain := 0.0, 1.0
		for n := 0; n <= 1000; n++ {
			r := base
			facts := *base.CommunityFacts
			r.CommunityFacts = &facts
			if forks {
				r.Forks = float64(n)
				facts.Forks = float64(n)
			} else {
				facts.OutsideMergedPRs = float64(n)
			}
			cur := ComputeImpactFromContribMap([]ContribRepoAgg{r}, "maker")
			if cur.ImpactPrestigeScore < prev.ImpactPrestigeScore || cur.ImpactDepthRaw < prev.ImpactDepthRaw {
				t.Fatalf("nonmonotone at %d", n)
			}
			weight := impactEvidenceWeight(r)
			gain := weight - lastWeight
			if n > 0 && gain > lastGain+1e-12 {
				t.Fatalf("increasing evidence returns at %d", n)
			}
			if n > 0 {
				lastGain = gain
			}
			lastWeight = weight
			prev = cur
		}
	}
	for _, forks := range []bool{true, false} {
		gate := 1.0
		if forks {
			gate = 10
		}
		values := []float64{}
		for _, n := range []float64{gate - .001, gate + .001} {
			r := base
			facts := *base.CommunityFacts
			r.CommunityFacts = &facts
			if forks {
				r.Forks = n
				facts.Forks = n
			} else {
				facts.OutsideMergedPRs = n
			}
			values = append(values, attributedCreatorWeight(r, "maker"))
		}
		if math.Abs(values[1]-values[0]) >= .002 {
			t.Fatal("evidence cliff", values)
		}
	}

	for _, gate := range []float64{200, 1000} {
		r := base
		r.Forks = 33
		r.Stars = gate - 1
		a := ComputeImpactFromContribMap([]ContribRepoAgg{r}, "maker")
		r.Stars = gate + 1
		b := ComputeImpactFromContribMap([]ContribRepoAgg{r}, "maker")
		if math.Abs(a.ImpactPrestigeScore-b.ImpactPrestigeScore) >= .002 || math.Abs(a.ImpactDepthRaw-b.ImpactDepthRaw) >= .02 {
			t.Fatalf("cliff at %v", gate)
		}
	}
}
