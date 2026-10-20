package backend

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestAttributedCreatorImpact(t *testing.T) {
	data, err := os.ReadFile("../../src/lib/__tests__/attributed-impact-fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Metrics       RawMetrics              `json:"metrics"`
		Repo          ContribRepoAgg          `json:"repo"`
		Raw           OwnRepoCommunityRaw     `json:"raw"`
		Context       OwnRepoCommunityContext `json:"context"`
		ExpectedFacts OwnRepoCommunityFacts   `json:"expected_facts"`
	}
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	facts := ComputeOwnRepoCommunityFacts(f.Raw, f.Context)
	if !reflect.DeepEqual(facts, f.ExpectedFacts) {
		t.Fatalf("facts %#v != %#v", facts, f.ExpectedFacts)
	}
	repos := ApplyOwnRepoCommunities([]ContribRepoAgg{f.Repo}, map[string]OwnRepoCommunityFacts{"ephemeral-ai-lab/layerfs": facts}, false)
	impact := ComputeImpactFromContribMap(repos, "yifanxuaaa")
	if impact.ImpactRepoCount != 1 || impact.ImpactPrestigeScore != .5417 || impact.ImpactDepthRaw != 1.83 {
		t.Fatalf("impact %+v", impact)
	}
	if Score(f.Metrics).FinalScore != 68.1 {
		t.Fatal("v15 replay of original snapshot changed")
	}
	f.Metrics.ImpactPrestigeScore = &impact.ImpactPrestigeScore
	f.Metrics.ImpactDepthRaw += impact.ImpactDepthRaw
	f.Metrics.ImpactPRCount = impact.ImpactPRCount
	f.Metrics.MaxImpactRepoStars = impact.MaxImpactRepoStars
	f.Metrics.ExternalMergedPRCount = floatPointer(29)
	f.Metrics.OwnPRCommunity = floatPointer(OwnPRCommunityShare(repos, "yifanxuaaa", 79))
	result := Score(f.Metrics)
	if result.SubScores.EcosystemImpact != 8.1 || result.FinalScore != 76.5 {
		t.Fatalf("score %+v", result)
	}
	for _, name := range []string{"empty"} {
		t.Run(name, func(t *testing.T) {
			r := f.Repo
			switch name {
			case "empty":
				r.Forks = 0
			case "two-forks":
				r.Forks = 2
			case "member":
				r.AttributionEvidence = []string{"org member of Ephemeral-AI-Lab"}
			case "inflated":
				r.StarInflationSuspect = true
			case "personal":
				r.AttributedOriginal = false
				r.OwnerLogin = "yifanxuaaa"
			}
			if ComputeImpactFromContribMap([]ContribRepoAgg{r}, "yifanxuaaa").ImpactRepoCount != 0 {
				t.Fatal("unearned impact")
			}
			pr := RecentPR{Repo: &r.Repo, RepoStars: 520}
			if IsEcosystemImpactPR(pr, "yifanxuaaa", []ContribRepoAgg{r}) {
				t.Fatal("unearned verified PR")
			}
		})
	}
}
