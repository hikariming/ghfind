package backend

import (
	"context"
	"sort"
	"testing"
	"time"
)

type recordingFeedProjectSource struct {
	assessments   []ProjectAssessment
	listCalls     int
	metadataCalls int
}

func (s *recordingFeedProjectSource) ListFeedProjectAssessments(_ context.Context, after string, limit int) ([]ProjectAssessment, error) {
	s.listCalls++
	items := append([]ProjectAssessment(nil), s.assessments...)
	sort.Slice(items, func(i, j int) bool { return items[i].RepoKey < items[j].RepoKey })
	result := []ProjectAssessment{}
	for _, item := range items {
		if item.RepoKey > after {
			result = append(result, item)
		}
		if len(result) == limit {
			break
		}
	}
	return result, nil
}

func (s *recordingFeedProjectSource) ListFeedProjectAssessmentChanges(_ context.Context, afterUpdatedAt int64, afterRepoKey string, limit int) ([]ProjectAssessment, error) {
	s.listCalls++
	items := append([]ProjectAssessment(nil), s.assessments...)
	sort.Slice(items, func(i, j int) bool {
		if items[i].UpdatedAt != items[j].UpdatedAt {
			return items[i].UpdatedAt < items[j].UpdatedAt
		}
		return items[i].RepoKey < items[j].RepoKey
	})
	result := []ProjectAssessment{}
	for _, item := range items {
		if item.UpdatedAt > afterUpdatedAt || (item.UpdatedAt == afterUpdatedAt && item.RepoKey > afterRepoKey) {
			result = append(result, item)
		}
		if len(result) == limit {
			break
		}
	}
	return result, nil
}

func (s *recordingFeedProjectSource) FeedProjectCatalogCount(context.Context) (int64, error) {
	return int64(len(s.assessments)), nil
}

func (s *recordingFeedProjectSource) GetProjectAssessment(_ context.Context, repoKey string) (*ProjectAssessment, error) {
	for index := range s.assessments {
		if s.assessments[index].RepoKey == repoKey {
			item := s.assessments[index]
			return &item, nil
		}
	}
	return nil, nil
}

func (s *recordingFeedProjectSource) ListFeedProjectOverviews(_ context.Context, keys []string) (map[string]*ProjectOverview, error) {
	s.metadataCalls++
	result := map[string]*ProjectOverview{}
	for _, key := range keys {
		result[key] = &ProjectOverview{Repo: ProjectRepo{RepoKey: key}}
	}
	return result, nil
}

type recordingFeedReconcileTarget struct {
	fakeFeedDataStore
	hashes       map[string]string
	projected    []FeedProjectProjection
	leaseAllowed bool
	loseRenew    bool
	renewCalls   int
	released     int
	finalized    []string
	cursor       FeedProjectChangeCursor
	cursorExists bool
	savedCursors []FeedProjectChangeCursor
}

func (t *recordingFeedReconcileTarget) FeedProjectSourceHashes(_ context.Context, keys []string) (map[string]string, error) {
	result := map[string]string{}
	for _, key := range keys {
		if hash := t.hashes[key]; hash != "" {
			result[key] = hash
		}
	}
	return result, nil
}

func (t *recordingFeedReconcileTarget) UpsertFeedProject(_ context.Context, project FeedProjectProjection) error {
	t.projected = append(t.projected, project)
	if t.hashes == nil {
		t.hashes = map[string]string{}
	}
	t.hashes[project.RepoKey] = project.SourceHash
	return nil
}

func (t *recordingFeedReconcileTarget) AcquireFeedReconcileLease(context.Context, string, time.Time, time.Duration) (bool, error) {
	return t.leaseAllowed, nil
}

func (t *recordingFeedReconcileTarget) ReleaseFeedReconcileLease(context.Context, string) error {
	t.released++
	return nil
}

func (t *recordingFeedReconcileTarget) RenewFeedReconcileLease(context.Context, string, time.Time, time.Duration) (bool, error) {
	t.renewCalls++
	return !t.loseRenew, nil
}

func (t *recordingFeedReconcileTarget) FinalizeFeedProjectReconcile(_ context.Context, seen []string, _ time.Time) (int64, error) {
	t.finalized = append([]string(nil), seen...)
	return 0, nil
}

func (t *recordingFeedReconcileTarget) LoadFeedProjectChangeCursor(context.Context) (FeedProjectChangeCursor, bool, error) {
	return t.cursor, t.cursorExists, nil
}

func (t *recordingFeedReconcileTarget) SaveFeedProjectChangeCursor(_ context.Context, cursor FeedProjectChangeCursor) error {
	t.cursor, t.cursorExists = cursor, true
	t.savedCursors = append(t.savedCursors, cursor)
	return nil
}

func reconcileAssessment(repoKey, analysisID string) ProjectAssessment {
	assessment := validFeedAssessment()
	assessment.RepoKey = repoKey
	assessment.LatestAnalysisID = analysisID
	assessment.Analysis.AnalysisID = analysisID
	assessment.Analysis.Repository.RepoKey = repoKey
	assessment.Analysis.Repository.CanonicalURL = "https://github.com/" + repoKey
	return assessment
}

func TestFeedReconcilerRefusesEmptySnapshot(t *testing.T) {
	target := &recordingFeedReconcileTarget{leaseAllowed: true}
	reconciler := NewFeedProjectReconciler(&recordingFeedProjectSource{}, target, nil)
	if _, err := reconciler.Reconcile(context.Background()); err == nil {
		t.Fatal("empty snapshot should fail closed before hiding the catalog")
	}
	if target.released != 1 || len(target.finalized) != 0 {
		t.Fatalf("lease release/finalize = %d/%v", target.released, target.finalized)
	}
}

func TestFeedReconcilerBatchesMetadataAndSkipsUnchangedProjects(t *testing.T) {
	source := &recordingFeedProjectSource{assessments: []ProjectAssessment{
		reconcileAssessment("owner/alpha", "analysis-alpha"),
		reconcileAssessment("owner/beta", "analysis-beta"),
	}}
	target := &recordingFeedReconcileTarget{leaseAllowed: true, hashes: map[string]string{}}
	reconciler := NewFeedProjectReconciler(source, target, nil)
	first, err := reconciler.Reconcile(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first.Projected != 2 || first.Unchanged != 0 || source.metadataCalls != 1 {
		t.Fatalf("first reconcile = %#v metadataCalls=%d", first, source.metadataCalls)
	}
	second, err := reconciler.Reconcile(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second.Projected != 0 || second.Unchanged != 2 || len(target.projected) != 2 {
		t.Fatalf("second reconcile = %#v projected=%d", second, len(target.projected))
	}
	if len(target.finalized) != 2 || target.finalized[0] != "owner/alpha" || target.finalized[1] != "owner/beta" {
		t.Fatalf("stable full snapshot = %#v", target.finalized)
	}
}

func TestFeedReconcilerLeasePreventsDuplicateFullSweep(t *testing.T) {
	source := &recordingFeedProjectSource{assessments: []ProjectAssessment{reconcileAssessment("owner/alpha", "analysis-alpha")}}
	target := &recordingFeedReconcileTarget{leaseAllowed: false}
	result, err := NewFeedProjectReconciler(source, target, nil).Reconcile(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !result.LeaseSkipped || source.listCalls != 0 {
		t.Fatalf("result=%#v listCalls=%d", result, source.listCalls)
	}
}

func TestFeedReconcilerLostLeaseNeverFinalizesMissingProjects(t *testing.T) {
	source := &recordingFeedProjectSource{assessments: []ProjectAssessment{reconcileAssessment("owner/alpha", "analysis-alpha")}}
	target := &recordingFeedReconcileTarget{leaseAllowed: true, loseRenew: true, hashes: map[string]string{}}
	_, err := NewFeedProjectReconciler(source, target, nil).Reconcile(context.Background())
	if err == nil {
		t.Fatal("lost reconciliation lease must abort the sweep")
	}
	if target.renewCalls == 0 || len(target.finalized) != 0 || target.released != 1 {
		t.Fatalf("renew/finalize/release=%d/%v/%d", target.renewCalls, target.finalized, target.released)
	}
}

func TestFeedReconcilerEventSyncIsIdempotent(t *testing.T) {
	source := &recordingFeedProjectSource{assessments: []ProjectAssessment{reconcileAssessment("owner/alpha", "analysis-alpha")}}
	target := &recordingFeedReconcileTarget{leaseAllowed: true, hashes: map[string]string{}}
	reconciler := NewFeedProjectReconciler(source, target, nil)
	changed, err := reconciler.SyncProject(context.Background(), "owner/alpha")
	if err != nil || !changed {
		t.Fatalf("first sync changed=%v err=%v", changed, err)
	}
	changed, err = reconciler.SyncProject(context.Background(), "owner/alpha")
	if err != nil || changed || len(target.projected) != 1 {
		t.Fatalf("second sync changed=%v err=%v projected=%d", changed, err, len(target.projected))
	}
}

func TestFeedIncrementalReconcilerReadsOnlyOverlapAndNeverHides(t *testing.T) {
	now := time.Date(2026, 8, 20, 4, 0, 0, 0, time.UTC)
	old := reconcileAssessment("owner/old", "analysis-old")
	old.UpdatedAt = now.Add(-20 * time.Minute).UnixMilli()
	recent := reconcileAssessment("owner/recent", "analysis-recent")
	recent.UpdatedAt = now.Add(-time.Minute).UnixMilli()
	source := &recordingFeedProjectSource{assessments: []ProjectAssessment{old, recent}}
	target := &recordingFeedReconcileTarget{leaseAllowed: true, hashes: map[string]string{}}
	reconciler := NewFeedProjectReconciler(source, target, nil)
	reconciler.now = func() time.Time { return now }
	result, err := reconciler.ReconcileChanges(context.Background(), FeedProjectChangeCursor{
		UpdatedAt: now.UnixMilli(), RepoKey: "owner/cursor",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Seen != 1 || result.Projected != 1 || len(target.finalized) != 0 {
		t.Fatalf("incremental result=%#v projected=%d finalized=%#v", result, len(target.projected), target.finalized)
	}
	if result.HighWater.UpdatedAt != now.UnixMilli() || result.HighWater.RepoKey != "owner/cursor" {
		t.Fatalf("incremental high-water moved backwards: %#v", result.HighWater)
	}
}

func TestFeedReconcileCycleBootstrapsFullThenUsesIncremental(t *testing.T) {
	now := time.Date(2026, 8, 20, 4, 0, 0, 0, time.UTC)
	first := reconcileAssessment("owner/first", "analysis-first")
	first.UpdatedAt = now.Add(-time.Minute).UnixMilli()
	source := &recordingFeedProjectSource{assessments: []ProjectAssessment{first}}
	target := &recordingFeedReconcileTarget{leaseAllowed: true, hashes: map[string]string{}}
	reconciler := NewFeedProjectReconciler(source, target, nil)
	reconciler.now = func() time.Time { return now }
	result, mode, err := reconciler.reconcileCycle(context.Background())
	if err != nil || mode != "full" || result.Projected != 1 || len(target.savedCursors) != 1 {
		t.Fatalf("bootstrap result=%#v mode=%s saved=%#v err=%v", result, mode, target.savedCursors, err)
	}
	if target.cursor.SourceCount != 1 || !target.cursor.LastFullAt.Equal(now) {
		t.Fatalf("bootstrap cursor=%#v", target.cursor)
	}

	second := reconcileAssessment("owner/second", "analysis-second")
	second.UpdatedAt = now.Add(time.Second).UnixMilli()
	source.assessments = append(source.assessments, second)
	reconciler.now = func() time.Time { return now.Add(30 * time.Second) }
	result, mode, err = reconciler.reconcileCycle(context.Background())
	if err != nil || mode != "incremental" || result.Projected != 1 {
		t.Fatalf("incremental result=%#v mode=%s err=%v", result, mode, err)
	}
	if target.cursor.SourceCount != 2 || target.cursor.RepoKey != "owner/second" || len(target.finalized) != 1 {
		t.Fatalf("incremental cursor=%#v finalized=%#v", target.cursor, target.finalized)
	}
}

func TestFeedReconcileCycleCountDecreaseForcesFullAntiEntropy(t *testing.T) {
	now := time.Date(2026, 8, 20, 4, 0, 0, 0, time.UTC)
	assessment := reconcileAssessment("owner/remaining", "analysis-remaining")
	assessment.UpdatedAt = now.Add(-time.Minute).UnixMilli()
	source := &recordingFeedProjectSource{assessments: []ProjectAssessment{assessment}}
	target := &recordingFeedReconcileTarget{
		leaseAllowed: true,
		hashes:       map[string]string{},
		cursorExists: true,
		cursor: FeedProjectChangeCursor{
			UpdatedAt: now.Add(-time.Minute).UnixMilli(), RepoKey: "owner/old", SourceCount: 2, LastFullAt: now.Add(-time.Hour),
		},
	}
	reconciler := NewFeedProjectReconciler(source, target, nil)
	reconciler.now = func() time.Time { return now }
	_, mode, err := reconciler.reconcileCycle(context.Background())
	if err != nil || mode != "full" || len(target.finalized) != 1 || target.cursor.SourceCount != 1 {
		t.Fatalf("count-decrease mode=%s finalized=%#v cursor=%#v err=%v", mode, target.finalized, target.cursor, err)
	}
}
