package backend

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"testing"
	"time"
)

// Each platform compares complete private output exactly with the frozen
// pre-optimization algorithm from 5a3333d. The cross-platform digest rounds
// numeric JSON leaves to 12 decimal places because Go math.Exp differs by an
// ulp between arm64 and amd64. Order, branches and strings remain exact; numeric
// precision exceeds the policy probability contract. Binary-exact tag weights
// avoid map summation-order noise in the reference Jaccard implementation.
func feedRankCapacityFixture() ([]FeedCandidate, time.Time) {
	now := time.Date(2026, 9, 8, 0, 0, 0, 0, time.UTC)
	candidates := make([]FeedCandidate, 0, 240)
	for i := 0; i < 240; i++ {
		owner := fmt.Sprintf("golden-owner-%02d", i%31)
		c := feedCandidate(fmt.Sprintf("%s/project-%03d", owner, i), owner, float64(50+i%51), float64(60+i%41), []string{"low", "emerging", "unknown", "established"}[i%4], now.Add(-time.Duration(i)*12*time.Hour))
		c.Project.Tags = []FeedTag{{ID: fmt.Sprintf("topic-%d", i%7), Weight: 1}, {ID: fmt.Sprintf("topic-%d", (i+2)%7), Weight: .5}, {ID: fmt.Sprintf("topic-%d", i%7), Weight: .25}}
		if i%3 != 0 {
			v := float64(i%9-4) / 4
			c.TagAffinity = &v
		}
		if i%5 == 0 {
			v := .5
			c.SemanticSimilarity = &v
			c.Embedding = []float64{float64(i % 3), 1, 0}
		}
		c.Sources = []string{"quality", "tag"}
		if i%29 == 0 {
			c.NotInterested = true
		}
		if i%37 == 0 {
			c.Project.Publishable = false
		}
		if i%23 == 0 {
			seen := now.Add(-10 * 24 * time.Hour)
			c.SeenAt = &seen
		}
		candidates = append(candidates, c)
	}
	return candidates, now
}

func TestFeedRankIncrementalMMRGolden(t *testing.T) {
	candidates, now := feedRankCapacityFixture()
	for _, tc := range []struct {
		seed    string
		rolling bool
		digest  string
	}{
		{"capacity-a", true, "fee233358044c8936217e31bbbd7aaa719d8bf68fdd7cd156a8083adafa25704"}, {"capacity-b", true, "8d91a386182ebf9470f97d4c9609fc1129b0afd9ea7f3472e3eff35cb8b283b8"}, {"capacity-c", false, "0d6602ce7762b0e38cde1dd9b460a78a456691753cacd7e72143a13660792a59"},
	} {
		options := FeedRankOptions{Now: now, Limit: 240, Seed: tc.seed, OwnerCap: 2, ExplorationRate: .1}
		if tc.rolling {
			options.ExplorationWindowSize = 20
		}
		ranked := RankFeedCandidates(candidates, options)
		if reference := referenceRankFeedCandidates(candidates, options); !reflect.DeepEqual(ranked, reference) {
			t.Fatalf("%s: optimized complete output differs from frozen original", tc.seed)
		}
		dto := make([]FeedRankedItemDTO, 0, len(ranked))
		for _, item := range ranked {
			dto = append(dto, feedRankedItemDTO(item))
		}
		encoded, err := json.Marshal(dto)
		if err != nil {
			t.Fatal(err)
		}
		var canonical any
		if err := json.Unmarshal(encoded, &canonical); err != nil {
			t.Fatal(err)
		}
		encoded, err = json.Marshal(normalizeFeedRankGolden(canonical))
		if err != nil {
			t.Fatal(err)
		}
		digest := fmt.Sprintf("%x", sha256.Sum256(encoded))
		if digest != tc.digest {
			t.Errorf("%s: ranked=%d digest=%s want=%s", tc.seed, len(ranked), digest, tc.digest)
		}
	}
}

func BenchmarkFeedRankCapacity(b *testing.B) {
	candidates, now := feedRankCapacityFixture()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		RankFeedCandidates(candidates, FeedRankOptions{Now: now, Limit: 240, Seed: "capacity-a", OwnerCap: 2, ExplorationRate: .1, ExplorationWindowSize: 20})
	}
}

func normalizeFeedRankGolden(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, item := range x {
			x[k] = normalizeFeedRankGolden(item)
		}
	case []any:
		for i, item := range x {
			x[i] = normalizeFeedRankGolden(item)
		}
	case float64:
		return math.Round(x*1e12) / 1e12
	}
	return v
}
