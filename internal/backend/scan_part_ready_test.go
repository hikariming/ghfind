package backend

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type failingReadyPublisher struct {
	recordingScanPublisher
	failPart     bool
	failAssemble bool
}

func (p *failingReadyPublisher) PublishScanPart(ctx context.Context, job ScanPartJob) error {
	if p.failPart && job.Part == scanPartDependents {
		return errors.New("fiction publish failed")
	}
	return p.recordingScanPublisher.PublishScanPart(ctx, job)
}

func (p *failingReadyPublisher) PublishScanAssemble(ctx context.Context, job ScanAssembleJob) error {
	if p.failAssemble {
		return errors.New("fiction assemble failed")
	}
	return p.recordingScanPublisher.PublishScanAssemble(ctx, job)
}

func readyParent(t *testing.T, store *TursoStore) scanParentRecord {
	t.Helper()
	job := ScanJob{ID: "fiction-ready-" + t.Name(), Username: "fiction-ready", RequestedAt: 1}
	if err := store.SaveScanParent(context.Background(), job, false, []string{scanPartRepos, scanPartDependents}, scanSeedEnvelope{}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.SaveScanPart(context.Background(), ScanPartJob{ParentID: job.ID, Username: job.Username, Part: scanPartRepos}, scanPartPayload{Part: scanPartRepos}); err != nil {
		t.Fatal(err)
	}
	parent, err := store.LoadScanParent(context.Background(), job.ID)
	if err != nil {
		t.Fatal(err)
	}
	return parent
}

func TestPublishFailureReleasesClaimForRedelivery(t *testing.T) {
	store := openScanPersistenceStore(t)
	publisher := &failingReadyPublisher{failPart: true}
	worker := NewScanWorker(Config{MaxAttempts: 3, ScanFanoutEnabled: true}, &fakeScanCollector{}, store, &fakeStatusStore{}, publisher, nil)
	parent := readyParent(t, store)
	part := ScanPartJob{ParentID: parent.ID, Username: parent.Username, Part: scanPartRepos, RequestedAt: 1}
	disposition, reason := worker.publishReady(context.Background(), parent, part)
	if disposition != workerRetry || reason == "" {
		t.Fatalf("first: %v %s", disposition, reason)
	}
	if len(publisher.parts) != 0 {
		t.Fatalf("failed publish recorded %+v", publisher.parts)
	}
	publisher.failPart = false
	disposition, reason = worker.publishReady(context.Background(), parent, part)
	if disposition != workerCompleted || reason != "" {
		t.Fatalf("redelivery: %v %s", disposition, reason)
	}
	if len(publisher.parts) != 1 || publisher.parts[0].Part != scanPartDependents {
		t.Fatalf("dependents=%+v", publisher.parts)
	}
	if _, _, err := store.SaveScanPart(context.Background(), ScanPartJob{ParentID: parent.ID, Username: parent.Username, Part: scanPartDependents}, scanPartPayload{Part: scanPartDependents}); err != nil {
		t.Fatal(err)
	}
	parent, err := store.LoadScanParent(context.Background(), parent.ID)
	if err != nil || !parent.Done {
		t.Fatalf("parent done=%v err=%v", parent.Done, err)
	}
	publisher.failAssemble = true
	assemblePart := ScanPartJob{ParentID: parent.ID, Username: parent.Username, Part: scanPartDependents, RequestedAt: 1}
	disposition, reason = worker.publishAssemble(context.Background(), parent, assemblePart)
	if disposition != workerRetry || reason == "" {
		t.Fatalf("assemble fail: %v %s", disposition, reason)
	}
	publisher.failAssemble = false
	disposition, reason = worker.publishAssemble(context.Background(), parent, assemblePart)
	if disposition != workerCompleted || len(publisher.assembles) != 1 {
		t.Fatalf("assemble redelivery: %v %s count=%d", disposition, reason, len(publisher.assembles))
	}
}

func TestExpiredClaimIsReclaimed(t *testing.T) {
	store := openScanPersistenceStore(t)
	parent := readyParent(t, store)
	now := time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC)
	claimed, token, err := store.claimReadyPublish(context.Background(), parent.ID, scanPartDependents, now)
	if err != nil || !claimed || token == "" {
		t.Fatalf("claim=%v token=%q err=%v", claimed, token, err)
	}
	again, againToken, err := store.claimReadyPublish(context.Background(), parent.ID, scanPartDependents, now.Add(time.Minute))
	if err != nil || again || againToken != "" {
		t.Fatalf("fresh claim reclaimed=%v token=%q err=%v", again, againToken, err)
	}
	later := now.Add(scanReadyLease())
	reclaimed, reclaimToken, err := store.claimReadyPublish(context.Background(), parent.ID, scanPartDependents, later)
	if err != nil || !reclaimed || reclaimToken == "" || reclaimToken == token {
		t.Fatalf("expired reclaim=%v token=%q err=%v", reclaimed, reclaimToken, err)
	}
	publisher := &recordingScanPublisher{}
	redeliveredAt := later.Add(scanReadyLease())
	collector := &GitHubCollector{clock: func() time.Time { return redeliveredAt }}
	worker := NewScanWorker(Config{MaxAttempts: 3, ScanFanoutEnabled: true}, collector, store, &fakeStatusStore{}, publisher, nil)
	disposition, reason := worker.publishReady(context.Background(), parent, ScanPartJob{ParentID: parent.ID, Username: parent.Username, Part: scanPartRepos, RequestedAt: 1})
	if disposition != workerCompleted || len(publisher.parts) != 1 {
		t.Fatalf("redelivery after crash: %v %s parts=%d", disposition, reason, len(publisher.parts))
	}
}

func TestPublishedClaimDoesNotRepublish(t *testing.T) {
	store := openScanPersistenceStore(t)
	publisher := &recordingScanPublisher{}
	worker := NewScanWorker(Config{MaxAttempts: 3, ScanFanoutEnabled: true}, &fakeScanCollector{}, store, &fakeStatusStore{}, publisher, nil)
	parent := readyParent(t, store)
	part := ScanPartJob{ParentID: parent.ID, Username: parent.Username, Part: scanPartRepos, RequestedAt: 1}
	disposition, reason := worker.publishReady(context.Background(), parent, part)
	if disposition != workerCompleted || len(publisher.parts) != 1 {
		t.Fatalf("first publish: %v %s", disposition, reason)
	}
	disposition, reason = worker.publishReady(context.Background(), parent, part)
	if disposition != workerCompleted || len(publisher.parts) != 1 {
		t.Fatalf("redelivery republished: %v %s count=%d", disposition, reason, len(publisher.parts))
	}
}

func readyClaimRow(t *testing.T, store *TursoStore, parentID, kind string) (state, token string) {
	t.Helper()
	err := store.db.QueryRowContext(context.Background(), `SELECT state, claim_token FROM scan_part_ready
      WHERE parent_id = ? AND kind = ?`, parentID, kind).Scan(&state, &token)
	if err != nil {
		t.Fatal(err)
	}
	return state, token
}

func TestLostClaimDoesNotTouchWinner(t *testing.T) {
	store := openScanPersistenceStore(t)
	parent := readyParent(t, store)
	now := time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC)
	claimed, tokenA, err := store.claimReadyPublish(context.Background(), parent.ID, scanPartDependents, now)
	if err != nil || !claimed || tokenA == "" {
		t.Fatalf("A claim=%v token=%q err=%v", claimed, tokenA, err)
	}
	later := now.Add(scanReadyLease())
	reclaimed, tokenB, err := store.claimReadyPublish(context.Background(), parent.ID, scanPartDependents, later)
	if err != nil || !reclaimed || tokenB == "" || tokenB == tokenA {
		t.Fatalf("B reclaim=%v token=%q err=%v", reclaimed, tokenB, err)
	}

	released, err := store.releaseReadyPublish(context.Background(), parent.ID, scanPartDependents, tokenA)
	if err != nil || released {
		t.Fatalf("A release affected=%v err=%v", released, err)
	}
	if state, token := readyClaimRow(t, store, parent.ID, scanPartDependents); state != scanReadyClaimed || token != tokenB {
		t.Fatalf("after A release state=%s token=%q", state, token)
	}
	marked, err := store.markReadyPublished(context.Background(), parent.ID, scanPartDependents, tokenA)
	if err != nil || marked {
		t.Fatalf("A mark affected=%v err=%v", marked, err)
	}
	if state, token := readyClaimRow(t, store, parent.ID, scanPartDependents); state != scanReadyClaimed || token != tokenB {
		t.Fatalf("after A mark state=%s token=%q", state, token)
	}

	publisher := &recordingScanPublisher{}
	workerA := NewScanWorker(Config{MaxAttempts: 3, ScanFanoutEnabled: true}, &GitHubCollector{clock: func() time.Time { return now }}, store, &fakeStatusStore{}, publisher, nil)
	workerB := NewScanWorker(Config{MaxAttempts: 3, ScanFanoutEnabled: true}, &GitHubCollector{clock: func() time.Time { return later }}, store, &fakeStatusStore{}, publisher, nil)
	// B already holds the claim, so B publishes and marks that token.
	// A second claim from the worker would correctly refuse the fresh lease.
	part := ScanPartJob{ParentID: parent.ID, Username: parent.Username, Phase: scanPhasePart, Part: scanPartDependents, RequestedAt: 1, Full: parent.Full}
	if err := publisher.PublishScanPart(context.Background(), part); err != nil {
		t.Fatal(err)
	}
	if err := workerB.finishReadyPublish(context.Background(), parent.ID, scanPartDependents, tokenB, true); err != nil {
		t.Fatal(err)
	}
	if len(publisher.parts) != 1 {
		t.Fatalf("B published %d parts", len(publisher.parts))
	}
	if state, token := readyClaimRow(t, store, parent.ID, scanPartDependents); state != scanReadyPublished || token != tokenB {
		t.Fatalf("after B mark state=%s token=%q", state, token)
	}

	// A's late release and mark lost the lease. They must not error, or the
	// handler would redeliver and publish a second time.
	if err := workerA.finishReadyPublish(context.Background(), parent.ID, scanPartDependents, tokenA, false); err != nil {
		t.Fatal(err)
	}
	if err := workerA.finishReadyPublish(context.Background(), parent.ID, scanPartDependents, tokenA, true); err != nil {
		t.Fatal(err)
	}
	if state, token := readyClaimRow(t, store, parent.ID, scanPartDependents); state != scanReadyPublished || token != tokenB {
		t.Fatalf("after A finish state=%s token=%q", state, token)
	}
	disposition, reason := workerA.publishReady(context.Background(), parent, ScanPartJob{ParentID: parent.ID, Username: parent.Username, Part: scanPartRepos, RequestedAt: 1})
	if disposition != workerCompleted || reason != "" || len(publisher.parts) != 1 {
		t.Fatalf("A republish: %v %s parts=%d", disposition, reason, len(publisher.parts))
	}
	disposition, reason = workerB.publishReady(context.Background(), parent, ScanPartJob{ParentID: parent.ID, Username: parent.Username, Part: scanPartRepos, RequestedAt: 1})
	if disposition != workerCompleted || reason != "" || len(publisher.parts) != 1 {
		t.Fatalf("B republish: %v %s parts=%d", disposition, reason, len(publisher.parts))
	}
}

// redeliveryCollector stores an empty payload for every part. processPart
// then reaches publishReady without a live GitHub call. The embedded
// collector carries the clock claimReadyPublish reads.
type redeliveryCollector struct {
	*GitHubCollector
}

func newRedeliveryCollector(at time.Time) *redeliveryCollector {
	return &redeliveryCollector{GitHubCollector: &GitHubCollector{clock: func() time.Time { return at }}}
}

func (c *redeliveryCollector) Collect(context.Context, string) (ScanResult, error) {
	return ScanResult{}, nil
}

func (c *redeliveryCollector) CollectScanPart(_ context.Context, _, part string, _ bool, _ githubUser, _ contributionOverview) (scanPartPayload, error) {
	return scanPartPayload{Part: part}, nil
}

func (c *redeliveryCollector) assembleCollectedScan(_ context.Context, _ bool, user githubUser, _ contributionOverview, _ *contribStats, _ float64, _ *time.Time, _ map[string]scanPartPayload) (ScanResult, map[string]string, error) {
	return ScanResult{Metrics: RawMetrics{Username: user.Login}}, map[string]string{}, nil
}

func countPublished(publisher *recordingScanPublisher, part string) (parts, assembles int) {
	publisher.mu.Lock()
	defer publisher.mu.Unlock()
	for _, job := range publisher.parts {
		if job.Part == part {
			parts++
		}
	}
	assembles = len(publisher.assembles)
	return parts, assembles
}

// finishRedeliveredParent runs the dependent part message, then assemble.
// Both go through processPart / processAssemble, the same path a queue
// redelivery takes. Dependents and assemble must each be published once.
func finishRedeliveredParent(t *testing.T, worker *ScanWorker, publisher *recordingScanPublisher, parent scanParentRecord) {
	t.Helper()
	dependents := ScanPartJob{ParentID: parent.ID, Username: parent.Username, Phase: scanPhasePart, Part: scanPartDependents, RequestedAt: 1}
	disposition, reason := worker.processPart(context.Background(), dependents)
	if disposition != workerCompleted || reason != "" {
		t.Fatalf("dependents: %v %s", disposition, reason)
	}
	parts, assembles := countPublished(publisher, scanPartDependents)
	if parts != 1 || assembles != 1 {
		t.Fatalf("after dependents parts=%d assembles=%d", parts, assembles)
	}
	disposition, reason = worker.processAssemble(context.Background(), ScanAssembleJob{
		ParentID: parent.ID, Username: parent.Username, Phase: scanPhaseAssemble, RequestedAt: 1,
	})
	if disposition != workerCompleted || (reason != "" && reason != "duplicate_delivery") {
		t.Fatalf("assemble: %v %s", disposition, reason)
	}
	parts, assembles = countPublished(publisher, scanPartDependents)
	if parts != 1 || assembles != 1 {
		t.Fatalf("published parts=%d assembles=%d", parts, assembles)
	}
}

func TestPartRedeliveryAfterPublishFailurePublishesOnce(t *testing.T) {
	store := openScanPersistenceStore(t)
	publisher := &failingReadyPublisher{failPart: true}
	now := time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC)
	worker := NewScanWorker(Config{MaxAttempts: 3, ScanFanoutEnabled: true}, newRedeliveryCollector(now), store, &fakeStatusStore{}, publisher, nil)
	parentJob := ScanJob{ID: "fiction-ready-" + t.Name(), Username: "fiction-ready", RequestedAt: 1}
	if err := store.SaveScanParent(context.Background(), parentJob, false, []string{scanPartRepos, scanPartDependents}, scanSeedEnvelope{User: githubUser{Login: parentJob.Username}}); err != nil {
		t.Fatal(err)
	}
	repos := ScanPartJob{ParentID: parentJob.ID, Username: parentJob.Username, Phase: scanPhasePart, Part: scanPartRepos, RequestedAt: 1}
	disposition, reason := worker.processPart(context.Background(), repos)
	if disposition != workerRetry || reason == "" {
		t.Fatalf("first: %v %s", disposition, reason)
	}
	if parts, assembles := countPublished(&publisher.recordingScanPublisher, scanPartDependents); parts != 0 || assembles != 0 {
		t.Fatalf("failed publish recorded parts=%d assembles=%d", parts, assembles)
	}
	publisher.failPart = false
	disposition, reason = worker.processPart(context.Background(), repos)
	if disposition != workerCompleted || reason != "" {
		t.Fatalf("redelivery: %v %s", disposition, reason)
	}
	if parts, assembles := countPublished(&publisher.recordingScanPublisher, scanPartDependents); parts != 1 || assembles != 0 {
		t.Fatalf("after redelivery parts=%d assembles=%d", parts, assembles)
	}
	parent, err := store.LoadScanParent(context.Background(), parentJob.ID)
	if err != nil {
		t.Fatal(err)
	}
	finishRedeliveredParent(t, worker, &publisher.recordingScanPublisher, parent)
}

func TestPartRedeliveryAfterClaimCrashPublishesOnce(t *testing.T) {
	store := openScanPersistenceStore(t)
	publisher := &recordingScanPublisher{}
	claimedAt := time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC)
	parentJob := ScanJob{ID: "fiction-ready-" + t.Name(), Username: "fiction-crash", RequestedAt: 1}
	if err := store.SaveScanParent(context.Background(), parentJob, false, []string{scanPartRepos, scanPartDependents}, scanSeedEnvelope{User: githubUser{Login: parentJob.Username}}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.SaveScanPart(context.Background(), ScanPartJob{ParentID: parentJob.ID, Username: parentJob.Username, Part: scanPartRepos}, scanPartPayload{Part: scanPartRepos}); err != nil {
		t.Fatal(err)
	}
	claimed, token, err := store.claimReadyPublish(context.Background(), parentJob.ID, scanPartDependents, claimedAt)
	if err != nil || !claimed || token == "" {
		t.Fatalf("crashed claim=%v token=%q err=%v", claimed, token, err)
	}
	parent, err := store.LoadScanParent(context.Background(), parentJob.ID)
	if err != nil {
		t.Fatal(err)
	}
	// The crashed worker's clock is still inside the lease, so a redelivery
	// now sees the claim and does not publish.
	early := NewScanWorker(Config{MaxAttempts: 3, ScanFanoutEnabled: true}, newRedeliveryCollector(claimedAt), store, &fakeStatusStore{}, publisher, nil)
	disposition, reason := early.processPart(context.Background(), ScanPartJob{ParentID: parent.ID, Username: parent.Username, Part: scanPartRepos, RequestedAt: 1})
	if disposition != workerCompleted || reason != "" || len(publisher.parts) != 0 {
		t.Fatalf("inside lease: %v %s parts=%d", disposition, reason, len(publisher.parts))
	}
	worker := NewScanWorker(Config{MaxAttempts: 3, ScanFanoutEnabled: true}, newRedeliveryCollector(claimedAt.Add(scanReadyLease())), store, &fakeStatusStore{}, publisher, nil)
	repos := ScanPartJob{ParentID: parent.ID, Username: parent.Username, Phase: scanPhasePart, Part: scanPartRepos, RequestedAt: 1}
	disposition, reason = worker.processPart(context.Background(), repos)
	if disposition != workerCompleted || reason != "" {
		t.Fatalf("redelivery: %v %s", disposition, reason)
	}
	if parts, _ := countPublished(publisher, scanPartDependents); parts != 1 {
		t.Fatalf("dependents published %d", parts)
	}
	finishRedeliveredParent(t, worker, publisher, parent)
}

func TestConcurrentReadyPublishClaimsOnce(t *testing.T) {
	store := openScanPersistenceStore(t)
	publisher := &recordingScanPublisher{}
	worker := NewScanWorker(Config{MaxAttempts: 3, ScanFanoutEnabled: true}, &fakeScanCollector{}, store, &fakeStatusStore{}, publisher, nil)
	parent := readyParent(t, store)
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			disposition, reason := worker.publishReady(context.Background(), parent, ScanPartJob{ParentID: parent.ID, Username: parent.Username, Part: scanPartRepos, RequestedAt: 1})
			if disposition != workerCompleted || reason != "" {
				t.Errorf("publish: %v %s", disposition, reason)
			}
		}()
	}
	wg.Wait()
	if len(publisher.parts) != 1 {
		t.Fatalf("published %d dependents", len(publisher.parts))
	}
}
