package backend

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestComputeFloodSignalsPreservesExternalOnlyRule(t *testing.T) {
	prs := make([]AnyPR, 10)
	for i := range prs {
		prs[i] = AnyPR{Title: "refactor(api): migrate item", Repo: "upstream/project"}
	}
	got := ComputeFloodSignals(prs, "alice")
	if !got.PRFloodSuspect || got.TopRepoPRTarget == nil || *got.TopRepoPRTarget != "upstream/project" || got.TemplatedPRRatio != 1 {
		t.Fatalf("unexpected external flood result: %#v", got)
	}
	for i := range prs {
		prs[i].Repo = "alice/project"
	}
	if got := ComputeFloodSignals(prs, "alice"); got.PRFloodSuspect {
		t.Fatalf("own-repository work must not be marked flood: %#v", got)
	}
}

func TestImpactAndQualitySignalsMirrorScoringInputs(t *testing.T) {
	codeTitle, docTitle, externalRepo := "fix scheduler", "docs: update guide", "org/framework"
	prs := []RecentPR{
		{Title: &codeTitle, Repo: &externalRepo, RepoStars: 20000, Files: []string{"internal/worker.go"}},
		{Title: &docTitle, Repo: &externalRepo, RepoStars: 20000, Files: []string{"docs/guide.md"}},
	}
	quality := ComputeImpactQualitySignals(prs, 5, "alice", 1)
	if quality.VerifiedImpactPRCount != 2 || quality.CoreImpactPRCount != 1 || quality.DocLikeImpactPRCount != 1 || quality.UnverifiedImpactPRCount != 2 {
		t.Fatalf("quality = %#v", quality)
	}
	impact := ComputeImpactFromContribMap([]ContribRepoAgg{
		{Repo: "org/framework", Stars: 20000, OwnerLogin: "org", PRs: 3},
		{Repo: "alice/tiny", Stars: 999, OwnerLogin: "alice", PRs: 20},
	}, "alice")
	if impact.ImpactRepoCount != 1 || impact.ImpactPRCount != 3 || !reflect.DeepEqual(impact.ImpactRepos, []ImpactRepo{{Repo: "org/framework", Stars: 20000, PRs: 3}}) {
		t.Fatalf("impact = %#v", impact)
	}
}

func TestOriginalRepoQualityUsesProjectSignalsNotStars(t *testing.T) {
	readme := "Install usage examples architecture test"
	name := "project"
	repo := TopRepo{Name: name, Stars: 50000, Size: 300, Language: stringPointer("Go"), Description: stringPointer("A useful project that users can install"), ReadmeExcerpt: &readme, PushedAt: stringPointer("2026-07-01T00:00:00Z")}
	quality := OriginalRepoQualityScore(repo, "alice", time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC))
	if quality != 0.7 {
		t.Fatalf("quality = %v, want 0.7", quality)
	}
}

func TestOriginalRepoQualitySoftensNotesDiscountWithOrganicTraction(t *testing.T) {
	readme := strings.Repeat("Install usage examples architecture test. ", 20)
	now := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	notes := func(stars, forks float64) TopRepo {
		return TopRepo{Name: "project", Stars: stars, Forks: forks, Size: 1800, Language: stringPointer("Go"), Description: stringPointer("My learning notes for ML systems"), ReadmeExcerpt: &readme, PushedAt: stringPointer("2026-07-01T00:00:00Z")}
	}
	for _, tc := range []struct {
		stars, forks, want float64
	}{{40, 5, 0.55}, {7000, 50, 0.55}, {7000, 500, 0.75}} {
		if got := OriginalRepoQualityScore(notes(tc.stars, tc.forks), "alice", now); got != tc.want {
			t.Fatalf("stars=%v forks=%v quality = %v, want %v", tc.stars, tc.forks, got, tc.want)
		}
	}
}
