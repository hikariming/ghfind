package backend

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// Captured before the incremental MMR optimization at 5a3333d. These fixtures
// fix the complete private ranked output, including conditional probabilities,
// selection branch, features and reasons, rather than only the public order.
// Binary-exact tag weights avoid summation-order noise in weighted Jaccard.
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
		{"capacity-a", true, "44886065ca60e1178ca6b0a1cde33dc0c6cf3e793713001fb8a26b8d7c51a2e1"}, {"capacity-b", true, "3b90753095a3802798db595689e46590df86a8e27042b0f6cb6d22a3eefbba84"}, {"capacity-c", false, "f05bae7cdae8ae0a7a7be92092e8bbbfb28093d3e5e7ec6dce7cc7cc9796498c"},
	} {
		options := FeedRankOptions{Now: now, Limit: 240, Seed: tc.seed, OwnerCap: 2, ExplorationRate: .1}
		if tc.rolling {
			options.ExplorationWindowSize = 20
		}
		ranked := RankFeedCandidates(candidates, options)
		dto := make([]FeedRankedItemDTO, 0, len(ranked))
		for _, item := range ranked {
			dto = append(dto, feedRankedItemDTO(item))
		}
		encoded, err := json.Marshal(dto)
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
