package backend

import (
	"fmt"
	"sort"
	"testing"
	"time"
)

func TestEscapeLikeMatchesUnderscoreAndPercentLiterally(t *testing.T) {
	if got := escapeLike("octo_cat%\\"); got != "octo\\_cat\\%\\\\" {
		t.Fatalf("escapeLike = %q", got)
	}
}

func TestEncodeSegmentsPreservesRepoSeparator(t *testing.T) {
	if got := encodeSegments("open ai/repo name"); got != "open%20ai/repo%20name" {
		t.Fatalf("encodeSegments = %q", got)
	}
}

func TestTrendingScoreMatchesEstablishedWeights(t *testing.T) {
	now := time.Now().UnixMilli()
	entry := LeaderboardEntry{FinalScore: 80, RecentLookupCount: 20, lastLookupAt: &now}
	if got := computeTrendingScore(entry, now); got != 84 {
		t.Fatalf("trending score = %v, want 84", got)
	}
}

func TestLeaderboardWindowUsesLegacySevenDayTrendingCutoffForAll(t *testing.T) {
	now := time.Now().UnixMilli()
	cutoff, active := leaderboardWindowCutoff("all", now)
	if active || cutoff != now-int64(7*24*time.Hour/time.Millisecond) {
		t.Fatalf("all cutoff=%d active=%v", cutoff, active)
	}
}

func TestTrendingSortPrefersHeatOutsideTheFirstAlphabeticalPage(t *testing.T) {
	now := time.Now().UnixMilli()
	entries := make([]LeaderboardEntry, leaderboardLimit+1)
	for index := range entries {
		entries[index] = LeaderboardEntry{
			Username:   fmt.Sprintf("a-%03d", index),
			FinalScore: 60,
		}
	}
	entries[len(entries)-1] = LeaderboardEntry{
		Username:          "z-hot",
		FinalScore:        100,
		RecentLookupCount: 20,
		lastLookupAt:      &now,
	}
	sort.SliceStable(entries, func(i, j int) bool { return trendingBefore(entries[i], entries[j], now) })
	entries = entries[:leaderboardLimit]
	if entries[0].Username != "z-hot" {
		t.Fatalf("first ranked entry = %q", entries[0].Username)
	}
}
