package backend

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/rabbitmq/amqp091-go"
)

// scanFanoutCollector is the optional collector surface used only when
// GHFIND_SCAN_FANOUT_ENABLED is on. The default worker still calls Collect.
type scanFanoutCollector interface {
	SeedScan(context.Context, string) (scanSeedSignals, githubUser, contributionOverview, *contribStats, float64, *time.Time, error)
	CollectScanPart(context.Context, string, string, bool, githubUser, contributionOverview) (scanPartPayload, error)
	assembleCollectedScan(context.Context, bool, githubUser, contributionOverview, *contribStats, float64, *time.Time, map[string]scanPartPayload) (ScanResult, map[string]string, error)
}

// scanIncrementalCollector is the optional surface used only when
// GHFIND_SCAN_INCREMENTAL_ENABLED is on. Parts may carry a per-source since
// watermark; assemble merges those deltas into the stored cursor pages.
type scanIncrementalCollector interface {
	scanFanoutCollector
	collectCursorPart(context.Context, string, string, bool, githubUser, contributionOverview, scanCursorPlan) (scanPartPayload, bool, error)
}

// maybeSplitScan seeds the account and, for a heavy plan, publishes part
// jobs. A light plan returns false so the caller keeps the in-process path.
// Search parts share one lane and are published together; consumers still
// run that lane one part at a time because each search part is its own
// message and the parent records them independently. The planner already
// capped the set at maxScanFanoutParts.
func (w *ScanWorker) maybeSplitScan(ctx context.Context, job ScanJob, collector scanFanoutCollector, store ScanPartStore) (bool, error) {
	signals, user, overview, stats, lastYear, latest, err := collector.SeedScan(ctx, job.Username)
	if err != nil {
		return false, err
	}
	// Parent jobs are the quick admission path. Full collection is the
	// in-process deepen step after a partial quick scan, not a fan-out.
	signals.Full = false
	plan := planScanFanout(signals)
	if !plan.Split {
		return false, nil
	}
	var latestRaw *string
	if latest != nil {
		value := latest.UTC().Format(time.RFC3339)
		latestRaw = &value
	}
	seed := scanSeedEnvelope{User: user, Overview: overview, Stats: stats, LastYear: lastYear, LatestEvent: latestRaw, Full: signals.Full, InlineParts: plan.InlineParts}
	parts := plan.parts()
	if err := store.SaveScanParent(ctx, job, signals.Full, parts, seed); err != nil {
		return false, err
	}
	since := map[string]string{}
	if w.config.ScanIncrementalEnabled {
		since = w.incrementalSince(ctx, job.Username)
	}
	for _, part := range plan.SearchParts {
		if err := w.publisher.PublishScanPart(ctx, ScanPartJob{
			ParentID: job.ID, Username: job.Username, Phase: scanPhasePart, Part: part,
			RequestedAt: job.RequestedAt, Full: signals.Full, Lane: 0, Since: since[part],
		}); err != nil {
			return false, err
		}
	}
	for index, part := range plan.ParallelParts {
		if err := w.publisher.PublishScanPart(ctx, ScanPartJob{
			ParentID: job.ID, Username: job.Username, Phase: scanPhasePart, Part: part,
			RequestedAt: job.RequestedAt, Full: signals.Full, Lane: index + 1, Since: since[part],
		}); err != nil {
			return false, err
		}
	}
	return true, nil
}

// incrementalSince reads stored watermarks for the parts a split may enqueue.
// A reconcile reason yields an empty since so that part pulls its full window.
// Cursor store failures fail open to the full window rather than blocking the scan.
func (w *ScanWorker) incrementalSince(ctx context.Context, username string) map[string]string {
	out := map[string]string{}
	store, ok := w.results.(ScanCursorStore)
	if !ok {
		return out
	}
	book, err := store.LoadScanCursors(ctx, username)
	if err != nil {
		return out
	}
	now := time.Now().UTC()
	if collector, ok := w.collector.(*GitHubCollector); ok && collector.clock != nil {
		now = collector.clock().UTC()
	}
	plans := planScanCursors(book, now)
	if plan, ok := plans[scanCursorRepos]; ok && !plan.Full && plan.Since != "" {
		out[scanCursorRepos] = plan.Since
	}
	return out
}

func (w *ScanWorker) consumePartDeliveries(ctx context.Context, deliveries <-chan amqp091.Delivery, concurrency int) error {
	return w.consumeRaw(ctx, deliveries, concurrency, w.handlePartDelivery)
}

func (w *ScanWorker) consumeAssembleDeliveries(ctx context.Context, deliveries <-chan amqp091.Delivery, concurrency int) error {
	return w.consumeRaw(ctx, deliveries, concurrency, w.handleAssembleDelivery)
}

func (w *ScanWorker) consumeRaw(ctx context.Context, deliveries <-chan amqp091.Delivery, concurrency int, handle func(context.Context, amqp091.Delivery)) error {
	semaphore := make(chan struct{}, concurrency)
	var inFlight sync.WaitGroup
	for {
		select {
		case <-ctx.Done():
			inFlight.Wait()
			return nil
		case delivery, open := <-deliveries:
			if !open {
				inFlight.Wait()
				return nil
			}
			semaphore <- struct{}{}
			inFlight.Add(1)
			go func() {
				defer inFlight.Done()
				defer func() { <-semaphore }()
				handle(ctx, delivery)
			}()
		}
	}
}

func (w *ScanWorker) handlePartDelivery(ctx context.Context, delivery amqp091.Delivery) {
	var job ScanPartJob
	if err := json.Unmarshal(delivery.Body, &job); err != nil || job.ParentID == "" || job.Part == "" || job.Username == "" {
		_ = delivery.Reject(false)
		return
	}
	processCtx, cancel := context.WithTimeout(ctx, scanWorkerProcessTimeout)
	disposition, reason := w.processPart(processCtx, job)
	cancel()
	w.finishChildDelivery(ctx, delivery, job.Attempt, disposition, reason, func(nextAttempt int) error {
		job.Attempt = nextAttempt
		return w.publisher.PublishScanPartRetry(ctx, job, retryDelay(job.Attempt))
	}, func(reason string) error {
		return w.publisher.PublishScanPartDead(ctx, job, reason)
	})
}

func (w *ScanWorker) processPart(ctx context.Context, job ScanPartJob) (workerDisposition, string) {
	collector, ok := w.collector.(scanFanoutCollector)
	store, storeOK := w.results.(ScanPartStore)
	if !ok || !storeOK {
		return workerDead, "scan fan-out collector unavailable"
	}
	parent, err := store.LoadScanParent(ctx, job.ParentID)
	if err != nil {
		return workerRetry, err.Error()
	}
	if _, already := parent.Payloads[job.Part]; already {
		// A redelivery after a failed publish, or after a crash that claimed
		// and never marked, still has this payload. Done only means assemble
		// is next. While the parent is open, publishReady claims dependents
		// again; the claim is a no-op when another delivery still holds it.
		return w.publishReady(ctx, parent, job)
	}
	payload, err := w.collectPart(ctx, collector, job, parent)
	if err != nil {
		if errors.Is(err, ErrGitHubAccountNotFound) || errors.Is(err, ErrGitHubAuthRequired) {
			payload = scanPartPayload{Part: job.Part, Failed: true, Error: err.Error()}
		} else if job.Attempt+1 >= w.config.MaxAttempts {
			payload = scanPartPayload{Part: job.Part, Failed: true, Error: err.Error()}
		} else {
			return workerRetry, err.Error()
		}
	}
	_, _, err = store.SaveScanPart(ctx, job, payload)
	if err != nil {
		return workerRetry, err.Error()
	}
	parent, err = store.LoadScanParent(ctx, job.ParentID)
	if err != nil {
		return workerRetry, err.Error()
	}
	// The parent is not Done until dependents land, and dependents are
	// published here. Waiting for Done first would never publish them.
	return w.publishReady(ctx, parent, job)
}

// publishReady emits the dependent part once the independent parts are in,
// then the assemble job once dependents are in too.
func (w *ScanWorker) publishReady(ctx context.Context, parent scanParentRecord, job ScanPartJob) (workerDisposition, string) {
	if _, ok := parent.Payloads[scanPartDependents]; !ok && containsPart(parent.Parts, scanPartDependents) && job.Part != scanPartDependents {
		independentDone := true
		for _, part := range parent.Parts {
			if part == scanPartDependents {
				continue
			}
			if _, present := parent.Payloads[part]; !present {
				independentDone = false
				break
			}
		}
		if independentDone {
			return w.publishClaimed(ctx, parent.ID, scanPartDependents, func() error {
				return w.publisher.PublishScanPart(ctx, ScanPartJob{
					ParentID: job.ParentID, Username: job.Username, Phase: scanPhasePart, Part: scanPartDependents,
					RequestedAt: job.RequestedAt, Full: parent.Full,
				})
			})
		}
	}
	if parent.Done {
		return w.publishAssemble(ctx, parent, job)
	}
	return workerCompleted, ""
}

func (w *ScanWorker) publishAssemble(ctx context.Context, parent scanParentRecord, job ScanPartJob) (workerDisposition, string) {
	return w.publishClaimed(ctx, parent.ID, scanPhaseAssemble, func() error {
		return w.publisher.PublishScanAssemble(ctx, ScanAssembleJob{
			ParentID: parent.ID, Username: parent.Username, Phase: scanPhaseAssemble,
			RequestedAt: job.RequestedAt, Full: parent.Full,
		})
	})
}

// publishClaimed claims, publishes, then marks the claim published. A failed
// publish releases the claim and asks for redelivery. A claim that is not
// won means another delivery already published or still holds a fresh lease.
func (w *ScanWorker) publishClaimed(ctx context.Context, parentID, kind string, publish func() error) (workerDisposition, string) {
	claimed, token, err := w.claimReadyPublish(ctx, parentID, kind)
	if err != nil {
		return workerRetry, err.Error()
	}
	if !claimed {
		return workerCompleted, ""
	}
	if err := publish(); err != nil {
		if releaseErr := w.finishReadyPublish(ctx, parentID, kind, token, false); releaseErr != nil {
			return workerRetry, releaseErr.Error()
		}
		return workerRetry, err.Error()
	}
	if err := w.finishReadyPublish(ctx, parentID, kind, token, true); err != nil {
		return workerRetry, err.Error()
	}
	return workerCompleted, ""
}

func (w *ScanWorker) handleAssembleDelivery(ctx context.Context, delivery amqp091.Delivery) {
	var job ScanAssembleJob
	if err := json.Unmarshal(delivery.Body, &job); err != nil || job.ParentID == "" || job.Username == "" {
		_ = delivery.Reject(false)
		return
	}
	processCtx, cancel := context.WithTimeout(ctx, scanWorkerProcessTimeout)
	disposition, reason := w.processAssemble(processCtx, job)
	cancel()
	w.finishChildDelivery(ctx, delivery, job.Attempt, disposition, reason, func(nextAttempt int) error {
		job.Attempt = nextAttempt
		return w.publisher.PublishScanAssembleRetry(ctx, job, retryDelay(job.Attempt))
	}, func(reason string) error {
		return w.publisher.PublishScanAssembleDead(ctx, job, reason)
	})
}

func (w *ScanWorker) processAssemble(ctx context.Context, job ScanAssembleJob) (workerDisposition, string) {
	collector, ok := w.collector.(scanFanoutCollector)
	store, storeOK := w.results.(ScanPartStore)
	if !ok || !storeOK {
		return workerDead, "scan fan-out collector unavailable"
	}
	parent, err := store.LoadScanParent(ctx, job.ParentID)
	if err != nil {
		return workerRetry, err.Error()
	}
	if !parent.Done {
		return workerRetry, "scan parts incomplete"
	}
	for _, part := range parent.Seed.InlineParts {
		if _, present := parent.Payloads[part]; present {
			continue
		}
		payload, err := w.collectPart(ctx, collector, ScanPartJob{
			ParentID: parent.ID, Username: parent.Username, Part: part, Full: parent.Full,
			Since: w.incrementalSince(ctx, parent.Username)[part],
		}, parent)
		if err != nil {
			payload = scanPartPayload{Part: part, Failed: true, Error: err.Error()}
		}
		parent.Payloads[part] = payload
	}
	var latest *time.Time
	if parent.Seed.LatestEvent != nil {
		parsed, parseErr := time.Parse(time.RFC3339, *parent.Seed.LatestEvent)
		if parseErr == nil {
			latest = &parsed
		}
	}
	payloads := parent.Payloads
	incrementalParts := map[string]bool{}
	if w.config.ScanIncrementalEnabled {
		for part, payload := range parent.Payloads {
			if payload.Incremental && !payload.Failed {
				incrementalParts[part] = true
			}
		}
		if merged, err := w.mergeIncrementalPayloads(ctx, parent); err == nil {
			payloads = merged
		}
	}
	scan, sources, err := collector.assembleCollectedScan(ctx, parent.Full, parent.Seed.User, parent.Seed.Overview, parent.Seed.Stats, parent.Seed.LastYear, latest, payloads)
	if err != nil {
		return workerRetry, err.Error()
	}
	scan.SourceStatus = mergedSourceStatus(scan, sources)
	var pending *pendingScanCursors
	if w.config.ScanIncrementalEnabled {
		pending = w.stageIncrementalCursors(ctx, parent.Username, payloads, incrementalParts)
	}
	if !parent.Full && quickCoverageExceeded(scan) {
		// The delta left quick coverage. Discard this run's incremental
		// cursor and let #582 deepen. Only the captured inventory page is
		// a truthful watermark; PR nodes are not rewritten from the delta.
		pending = nil
		if fullCollector, ok := w.collector.(interface {
			CollectFull(context.Context, string) (ScanResult, error)
		}); ok {
			var captured []githubRepo
			var forkCount float64
			fullScan, fullErr := fullCollector.CollectFull(context.WithValue(ctx, inventoryCapture{}, inventoryCapture{Repos: &captured, ForkCount: &forkCount}), parent.Username)
			if fullErr != nil {
				return workerRetry, fullErr.Error()
			}
			scan = fullScan
			scan.SourceStatus = nil
			if store, ok := w.results.(ScanCursorStore); ok {
				book, loadErr := store.LoadScanCursors(ctx, parent.Username)
				if loadErr == nil {
					now := time.Now().UTC()
					if collector, ok := w.collector.(*GitHubCollector); ok && collector.clock != nil {
						now = collector.clock().UTC()
					}
					repoPlan := scanCursorPlan{Source: scanCursorRepos, Full: true}
					pending = &pendingScanCursors{
						book: book, plans: map[string]scanCursorPlan{scanCursorRepos: repoPlan},
						repos: captured, forkCount: forkCount, now: now,
					}
				}
			}
		}
	}
	return w.persistFinishedScan(ctx, job.asScanJob(), scan, pending)
}

// collectPart uses the cursor plan when the flag is on and the part carries
// a since watermark. Otherwise it is the Phase 2 part collect.
func (w *ScanWorker) collectPart(ctx context.Context, collector scanFanoutCollector, job ScanPartJob, parent scanParentRecord) (scanPartPayload, error) {
	if w.config.ScanIncrementalEnabled && job.Since != "" {
		if incremental, ok := collector.(scanIncrementalCollector); ok {
			plan := scanCursorPlan{Source: job.Part, Since: job.Since}
			payload, delta, err := incremental.collectCursorPart(ctx, job.Username, job.Part, parent.Full || job.Full, parent.Seed.User, parent.Seed.Overview, plan)
			if err != nil {
				return payload, err
			}
			payload.Incremental = delta
			return payload, nil
		}
	}
	return collector.CollectScanPart(ctx, job.Username, job.Part, parent.Full || job.Full, parent.Seed.User, parent.Seed.Overview)
}

// mergeIncrementalPayloads folds incremental part deltas into the stored
// source pages. A part that was a full reconcile replaces its page.
func (w *ScanWorker) mergeIncrementalPayloads(ctx context.Context, parent scanParentRecord) (map[string]scanPartPayload, error) {
	store, ok := w.results.(ScanCursorStore)
	if !ok {
		return parent.Payloads, nil
	}
	book, err := store.LoadScanCursors(ctx, parent.Username)
	if err != nil {
		return nil, err
	}
	baseline := baselineFromBook(book)
	merged := map[string]scanPartPayload{}
	for part, payload := range parent.Payloads {
		if !payload.Incremental || payload.Failed {
			baseline = foldPayloadBaseline(baseline, payload)
			merged[part] = payload
			continue
		}
		baseline, payload = applyIncrementalPayload(baseline, payload, false)
		payload.Incremental = false
		merged[part] = payload
	}
	return merged, nil
}

// stageIncrementalCursors builds the cursor book for a finished assemble.
// It does not write. persistFinishedScan writes it after the public scan
// row commits. PR sources are included only when that part read its full
// window; an incremental repo delta does not mark them full.
func (w *ScanWorker) stageIncrementalCursors(ctx context.Context, username string, payloads map[string]scanPartPayload, incrementalParts map[string]bool) *pendingScanCursors {
	store, ok := w.results.(ScanCursorStore)
	if !ok {
		return nil
	}
	book, err := store.LoadScanCursors(ctx, username)
	if err != nil {
		return nil
	}
	book.Username = username
	now := time.Now().UTC()
	if collector, ok := w.collector.(*GitHubCollector); ok && collector.clock != nil {
		now = collector.clock().UTC()
	}
	plans := map[string]scanCursorPlan{}
	baseline := scanSnapshotBaseline{}
	for part, payload := range payloads {
		switch part {
		case scanPartRepos:
		case scanPartExternal, scanPartMerged:
			if incrementalParts[part] {
				continue
			}
		default:
			continue
		}
		if payload.Failed {
			continue
		}
		plans[part] = scanCursorPlan{Source: part, Full: !incrementalParts[part], Prev: book.raw(part)}
		baseline, _ = applyIncrementalPayload(baseline, payload, true)
	}
	if len(plans) == 0 {
		return nil
	}
	return &pendingScanCursors{book: book, plans: plans, baseline: baseline, useBaseline: true, now: now}
}

func (w *ScanWorker) persistFinishedScan(ctx context.Context, job ScanJob, scan ScanResult, pending *pendingScanCursors) (workerDisposition, string) {
	startedAt := time.Now()
	created, err := w.results.PersistCollectedScan(ctx, job, scan)
	if errors.Is(err, ErrScanJobConflict) {
		w.metrics.recordWorkerJobFailed(ScanJobKind, "conflict", time.Since(startedAt))
		return workerDead, err.Error()
	}
	if err != nil {
		w.metrics.recordWorkerJobRetry(ScanJobKind, time.Since(startedAt))
		return workerRetry, err.Error()
	}
	// Cursor save is best-effort after the public row commits. One CAS retry
	// lives in commitPendingCursors. A remaining error does not fail the scan.
	if err := w.commitPendingCursors(ctx, pending); err != nil {
		w.log.Warn("save scan cursors", "job_id", job.ID, "error", err)
	}
	if w.scanCache != nil {
		if err := w.scanCache.SetCachedScan(ctx, scan.Metrics.Username, scan); err != nil {
			w.log.Warn("cache collected scan", "job_id", job.ID, "error", err)
		}
	}
	if created {
		recordSuccessfulScanOutcome(ctx, w.outcomes, w.lookupGate, w.revisions, scan.Metrics.Username, job.LookupHash, job.Campaign, time.Now().UTC())
	}
	completed := newScanJobStatus(job, JobCompleted, "")
	if !created {
		completed.Error = "duplicate_delivery"
	}
	if err := w.statuses.Put(ctx, completed); err != nil {
		return workerRetry, "status store unavailable: " + err.Error()
	}
	if !created {
		return workerCompleted, "duplicate_delivery"
	}
	return workerCompleted, ""
}

func (w *ScanWorker) finishChildDelivery(ctx context.Context, delivery amqp091.Delivery, attempt int, disposition workerDisposition, reason string, retry func(int) error, dead func(string) error) {
	switch disposition {
	case workerCompleted:
		_ = delivery.Ack(false)
	case workerRetry:
		next := attempt + 1
		if next >= w.config.MaxAttempts {
			if err := dead(reason); err != nil {
				_ = delivery.Nack(false, true)
				return
			}
			_ = delivery.Ack(false)
			return
		}
		if err := retry(next); err != nil {
			_ = delivery.Nack(false, true)
			return
		}
		_ = delivery.Ack(false)
	case workerDead:
		if err := dead(reason); err != nil {
			_ = delivery.Nack(false, true)
			return
		}
		_ = delivery.Ack(false)
	}
}

func containsPart(parts []string, want string) bool {
	for _, part := range parts {
		if part == want {
			return true
		}
	}
	return false
}
