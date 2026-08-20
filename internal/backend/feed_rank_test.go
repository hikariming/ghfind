package backend

import (
	"fmt"
	"math"
	"reflect"
	"testing"
	"time"
)

func feedCandidate(key, owner string, score, confidence float64, exposure string, analyzedAt time.Time, tags ...string) FeedCandidate {
	feedTags := make([]FeedTag, 0, len(tags))
	for _, tag := range tags {
		feedTags = append(feedTags, FeedTag{ID: tag, Weight: 1, Confidence: 1})
	}
	return FeedCandidate{Project: FeedProject{
		RepoKey: key, ItemID: owner + ":" + key, OwnerLogin: owner, Name: key,
		ProductScore: score, Confidence: confidence, ExposureBand: exposure,
		AnalyzedAt: analyzedAt, Publishable: true, Tags: feedTags,
	}, Sources: []string{"quality"}}
}

func TestRankFeedCandidatesIsDeterministicAndHonorsHardFilters(t *testing.T) {
	now := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	candidates := []FeedCandidate{
		feedCandidate("one/alpha", "one", 95, 90, "low", now.Add(-24*time.Hour), "domain:ai"),
		feedCandidate("one/beta", "one", 94, 90, "low", now.Add(-48*time.Hour), "domain:ai"),
		feedCandidate("one/gamma", "one", 93, 90, "low", now.Add(-72*time.Hour), "domain:ai"),
		feedCandidate("two/delta", "two", 88, 85, "emerging", now.Add(-24*time.Hour), "domain:data"),
		feedCandidate("hidden/no", "hidden", 100, 100, "low", now),
	}
	candidates[4].Project.Publishable = false
	blocked := feedCandidate("blocked/no", "blocked", 100, 100, "low", now)
	blocked.NotInterested = true
	candidates = append(candidates, blocked, candidates[0])
	options := FeedRankOptions{Now: now, Limit: 4, Seed: "same-seed", ExplorationRate: .25, OwnerCap: 2}
	first := RankFeedCandidates(candidates, options)
	second := RankFeedCandidates(candidates, options)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("same seed produced different rankings\nfirst=%#v\nsecond=%#v", first, second)
	}
	seen, owners := map[string]bool{}, map[string]int{}
	for _, item := range first {
		if seen[item.Project.RepoKey] {
			t.Fatalf("duplicate %s", item.Project.RepoKey)
		}
		seen[item.Project.RepoKey] = true
		owners[item.Project.OwnerLogin]++
		if item.Project.RepoKey == "hidden/no" || item.Project.RepoKey == "blocked/no" {
			t.Fatalf("hard-filtered item was served: %s", item.Project.RepoKey)
		}
		if item.Propensity <= 0 || item.Propensity > 1 {
			t.Fatalf("invalid propensity %f", item.Propensity)
		}
	}
	if owners["one"] > 2 {
		t.Fatalf("owner cap not enforced: %#v", owners)
	}
}

func TestBaselineFeedScoreRenormalizesMissingSignals(t *testing.T) {
	now := time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC)
	candidate := feedCandidate("owner/repo", "owner", 80, 70, "low", now)
	without, _ := baselineFeedScore(candidate, now)
	semantic := .8
	candidate.SemanticSimilarity = &semantic
	with, _ := baselineFeedScore(candidate, now)
	if without <= 0 || without > 1 || with <= 0 || with > 1 {
		t.Fatalf("scores out of range: %f %f", without, with)
	}
	if math.Abs(with-without) < .001 {
		t.Fatalf("semantic signal did not change score: %f %f", without, with)
	}
}

func TestMMRDiversifiesNearDuplicates(t *testing.T) {
	now := time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC)
	first := feedCandidate("a/one", "a", 95, 95, "low", now, "domain:ai", "use:chat")
	near := feedCandidate("b/two", "b", 94, 95, "low", now, "domain:ai", "use:chat")
	diverse := feedCandidate("c/three", "c", 91, 90, "low", now, "domain:data")
	ranked := RankFeedCandidates([]FeedCandidate{first, near, diverse}, FeedRankOptions{Now: now, Limit: 3, Seed: "mmr", ExplorationRate: 0, MaxExploration: 0})
	if len(ranked) != 3 {
		t.Fatalf("ranked len = %d", len(ranked))
	}
	if ranked[1].Project.RepoKey != "c/three" {
		t.Fatalf("MMR did not diversify: %#v", ranked)
	}
}

func TestCosineAndWeightedJaccard(t *testing.T) {
	if got := cosineSimilarity([]float64{1, 0}, []float64{1, 0}); math.Abs(got-1) > 1e-9 {
		t.Fatalf("cosine = %f", got)
	}
	if got := cosineSimilarity([]float64{1}, []float64{1, 0}); got != 0 {
		t.Fatalf("mismatched cosine = %f", got)
	}
	left := []FeedTag{{ID: "a", Weight: 1}, {ID: "b", Weight: .5}}
	right := []FeedTag{{ID: "a", Weight: .5}, {ID: "c", Weight: 1}}
	if got := weightedTagJaccard(left, right); math.Abs(got-.2) > 1e-9 {
		t.Fatalf("jaccard = %f", got)
	}
}

func TestRankFeedCandidatesOnlyReintroducesSevenToThirtyDayItemsWhenPoolIsShort(t *testing.T) {
	now := time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC)
	recent := feedCandidate("recent/repo", "recent", 100, 100, "low", now)
	seen := now.Add(-10 * 24 * time.Hour)
	recent.SeenAt = &seen
	unseen := feedCandidate("fresh/repo", "fresh", 50, 50, "low", now)
	page := RankFeedCandidates([]FeedCandidate{recent, unseen}, FeedRankOptions{Now: now, Limit: 1, Seed: "one", ExplorationRate: 0})
	if len(page) != 1 || page[0].Project.RepoKey != "fresh/repo" {
		t.Fatalf("recent item bypassed 30-day exclusion: %#v", page)
	}
	page = RankFeedCandidates([]FeedCandidate{recent, unseen}, FeedRankOptions{Now: now, Limit: 2, Seed: "two", ExplorationRate: 0})
	if len(page) != 2 {
		t.Fatalf("recent fallback was not used for short pool: %#v", page)
	}
}

func TestFeedExplorationBudgetResetsPerPage(t *testing.T) {
	now := time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC)
	candidates := make([]FeedCandidate, 0, 60)
	for index := 0; index < 60; index++ {
		owner := fmt.Sprintf("owner-%02d", index)
		candidates = append(candidates, feedCandidate(owner+"/project", owner, float64(100-index), 90, "established", now))
	}
	ranked := RankFeedCandidates(candidates, FeedRankOptions{Now: now, Limit: 60, Seed: "per-page",
		ExplorationRate: 1, MaxExploration: 2, ExplorationPageSize: 20, OwnerCap: 2})
	if len(ranked) != 60 {
		t.Fatalf("ranked=%d", len(ranked))
	}
	for start := 0; start < len(ranked); start += 20 {
		exploration := 0
		for _, item := range ranked[start : start+20] {
			if item.Exploration {
				exploration++
			}
		}
		if exploration != 2 {
			t.Fatalf("page %d exploration=%d", start/20, exploration)
		}
	}
}

func TestMergeGorseCandidatesCapsExclusiveSourceAtTwentyFivePercent(t *testing.T) {
	now := time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC)
	baseline := make([]FeedCandidate, 0, 240)
	for index := 0; index < 240; index++ {
		owner := fmt.Sprintf("base-%03d", index)
		baseline = append(baseline, feedCandidate(owner+"/project", owner, float64(index%100), 80, "established", now))
	}
	gorse := make([]FeedCandidate, 0, 80)
	for index := 0; index < 80; index++ {
		owner := fmt.Sprintf("gorse-%03d", index)
		gorse = append(gorse, feedCandidate(owner+"/project", owner, 50, 50, "emerging", now))
	}
	merged := mergeGorseFeedCandidates(baseline, gorse, now, 240)
	if len(merged) != 240 {
		t.Fatalf("merged=%d", len(merged))
	}
	exclusive := 0
	for _, candidate := range merged {
		if containsString(candidate.Sources, "gorse") {
			exclusive++
		}
	}
	if exclusive != 60 {
		t.Fatalf("Gorse candidates=%d, expected 60", exclusive)
	}
}
