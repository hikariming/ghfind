package backend

import (
	"encoding/json"
	"os"
	"testing"
)

type discoverGoldenCase struct {
	Input struct {
		Pain              float64       `json:"pain"`
		Effectiveness     float64       `json:"effectiveness"`
		Experience        float64       `json:"experience"`
		ValueDensity      float64       `json:"valueDensity"`
		ProductScore      float64       `json:"productScore"`
		Confidence        float64       `json:"confidence"`
		VerificationLevel string        `json:"verificationLevel"`
		Lifecycle         string        `json:"lifecycle"`
		ExposureBand      string        `json:"exposureBand"`
		CommunityStrength *float64      `json:"communityStrength"`
		Risks             []ProjectRisk `json:"risks"`
		Partition         string        `json:"partition"`
		ProjectType       *string       `json:"projectType"`
		TimeToFirstValue  *string       `json:"timeToFirstValue"`
	} `json:"input"`
	Expected DiscoverScoreResult `json:"expected"`
}

// The golden file is generated from the TypeScript reference
// (platform/shared/discover-score.ts) and checked by both suites, so the
// Feed shadow score cannot drift from the app's score.
func TestComputeDiscoverScoreMatchesTypeScriptGolden(t *testing.T) {
	raw, err := os.ReadFile("testdata/discover-score-golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Version string               `json:"version"`
		Cases   []discoverGoldenCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	if golden.Version != DiscoverScoreVersion || len(golden.Cases) < 100 {
		t.Fatalf("golden version %q with %d cases", golden.Version, len(golden.Cases))
	}
	for i, c := range golden.Cases {
		in := c.Input
		input := DiscoverScoreInput{
			Pain: in.Pain, Effectiveness: in.Effectiveness, Experience: in.Experience, ValueDensity: in.ValueDensity,
			ProductScore: in.ProductScore, Confidence: in.Confidence, VerificationLevel: in.VerificationLevel,
			Lifecycle: in.Lifecycle, ExposureBand: in.ExposureBand, CommunityStrength: in.CommunityStrength,
			Risks: in.Risks, Partition: in.Partition,
		}
		if in.ProjectType != nil {
			input.ProjectType = *in.ProjectType
		}
		if in.TimeToFirstValue != nil {
			input.TimeToFirstValue = *in.TimeToFirstValue
		}
		got := ComputeDiscoverScore(input)
		want := c.Expected
		if got.Score != want.Score || got.Band != want.Band || got.Eligible != want.Eligible || got.StrangerTryability != want.StrangerTryability {
			t.Fatalf("case %d: got %+v want %+v", i, got, want)
		}
	}
}

func TestDiscoverPartitionFromTagsNeedsExplicitNamespace(t *testing.T) {
	legacy := []ProductTag{{Namespace: "use_case", Slug: "ai-agent"}}
	if got := DiscoverPartitionFromTags(legacy); got != "none" {
		t.Fatalf("legacy tag set partition %q", got)
	}
	explicit := []ProductTag{{Namespace: "use_case", Slug: "x"}, {Namespace: "artifact", Slug: "sandbox", NamespaceExplicit: true}}
	if got := DiscoverPartitionFromTags(explicit); got != "sandbox" {
		t.Fatalf("partition %q", got)
	}
}
