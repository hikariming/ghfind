package backend

import (
	"context"
	"errors"
	"strings"
	"time"
)

// inventoryCapture carries the owned-original page of the collect running
// on this context, including the fork total. Incremental mode copies that
// page into the cursor table. It stays off the public snapshot.
type inventoryCapture struct {
	Repos     *[]githubRepo
	ForkCount *float64
}

// scanCursorPlan is one source's decision for this scan. Full is a
// reconciliation pull. Since is the watermark an incremental pull stops at.
type scanCursorPlan struct {
	Source string
	Full   bool
	Since  string
	Reason scanReconcileReason
	Prev   scanCursorWatermark
}

// planScanCursors decides each resumable source independently. A missing,
// corrupt, stale, or version-mismatched cursor reconciles that source.
// Other sources may still increment. The clock is the collector clock so
// tests pin age without sleeping.
func planScanCursors(book scanCursorBook, now time.Time) map[string]scanCursorPlan {
	plans := map[string]scanCursorPlan{}
	for _, source := range []string{scanCursorRepos, scanCursorExternal, scanCursorMerged} {
		raw := book.raw(source)
		reason := decideScanReconcile(raw, now)
		plan := scanCursorPlan{Source: source, Full: reason != scanReconcileNone, Reason: reason, Prev: raw}
		if reason == scanReconcileNone {
			plan.Since = raw.Watermark
		}
		plans[source] = plan
	}
	return plans
}

// baselineFromBook rebuilds the previous source pages stored beside the
// watermarks. Incremental merges start from these pages.
func baselineFromBook(book scanCursorBook) scanSnapshotBaseline {
	baseline := scanSnapshotBaseline{}
	if mark, ok := book.source(scanCursorRepos); ok {
		baseline.Repos = append([]githubRepo(nil), mark.Repos...)
		baseline.ForkCount = mark.ForkCount
	}
	if mark, ok := book.source(scanCursorExternal); ok {
		baseline.External = append([]mergedPRNode(nil), mark.Nodes...)
	}
	if mark, ok := book.source(scanCursorMerged); ok {
		baseline.Merged = append([]mergedPRNode(nil), mark.Nodes...)
	}
	return baseline
}

// advanceCursorBook records the merged page for the sources this scan
// touched. A full plan resets that source's incremental streak.
func advanceCursorBook(book scanCursorBook, plans map[string]scanCursorPlan, baseline scanSnapshotBaseline, now time.Time) scanCursorBook {
	if book.Sources == nil {
		book.Sources = map[string]scanCursorWatermark{}
	}
	for source, plan := range plans {
		if !knownScanCursorSource(source) {
			continue
		}
		var items []scanCursorItem
		switch source {
		case scanCursorRepos:
			items = reposToCursorItems(baseline.Repos)
		case scanCursorExternal, scanCursorMerged:
			// These connections are ordered by created time. A watermark is
			// recorded only from a full read of that window.
			if !plan.Full {
				continue
			}
			if source == scanCursorExternal {
				items = nodesToCursorItems(baseline.External)
			} else {
				items = nodesToCursorItems(baseline.Merged)
			}
		}
		if len(items) == 0 {
			continue
		}
		book.Sources[source] = cursorWatermarkFromItems(source, items, plan.Prev, plan.Full, now)
	}
	return book
}

// collectCursorPart runs one part with the cursor plan for that source.
// Sources without a plan (commits, workflows, dependents) stay on the
// existing full/quick path. The returned bool is whether the pull itself
// was a delta rather than a reconcile.
func (c *GitHubCollector) collectCursorPart(ctx context.Context, username, part string, full bool, seed githubUser, overview contributionOverview, plan scanCursorPlan) (scanPartPayload, bool, error) {
	if plan.Full || plan.Since == "" || full {
		payload, err := c.CollectScanPart(ctx, username, part, full, seed, overview)
		return payload, false, err
	}
	payload := scanPartPayload{Part: part}
	if c == nil || c.github == nil || !c.github.HasToken() {
		return payload, true, ErrGitHubAuthRequired
	}
	login := seed.Login
	if login == "" {
		login = username
	}
	switch part {
	case scanPartRepos:
		repos, forks, incomplete, err := c.github.ownedOriginalInventorySince(ctx, login, full, plan.Since)
		if err != nil {
			return payload, true, err
		}
		payload.Repos = repos
		payload.ForkCount = forks
		payload.ReposIncomplete = incomplete
	case scanPartExternal, scanPartMerged:
		// Created-time order cannot resume on mergedAt. Read the window.
		collected, err := c.CollectScanPart(ctx, username, part, full, seed, overview)
		return collected, false, err
	default:
		collected, err := c.CollectScanPart(ctx, username, part, full, seed, overview)
		return collected, false, err
	}
	return payload, true, nil
}

// quickCoverageExceeded reports whether an assembled quick scan still owes
// a fullscan under the #582 truncation rules. Incremental mode does not
// invent a second escalation path.
func quickCoverageExceeded(scan ScanResult) bool {
	return scan.Collection != nil && scan.Collection.Mode == "quick" && scan.Collection.Coverage == "partial_public"
}

// collectIncremental merges per-source deltas into the stored cursor pages,
// then scores that merged page with the same finish path as Collect.
// A missing cursor, or a delta that still exceeds quick coverage, falls
// through to Collect / CollectFull so the published row matches a full pull.
func (w *ScanWorker) collectIncremental(ctx context.Context, job ScanJob) (ScanResult, *pendingScanCursors, error) {
	collector, ok := w.collector.(*GitHubCollector)
	if !ok {
		scan, err := w.collector.Collect(ctx, job.Username)
		return scan, nil, err
	}
	store, ok := w.results.(ScanCursorStore)
	if !ok {
		scan, err := collector.Collect(ctx, job.Username)
		return scan, nil, err
	}
	now := time.Now().UTC()
	if collector.clock != nil {
		now = collector.clock().UTC()
	}
	book, err := store.LoadScanCursors(ctx, job.Username)
	if err != nil {
		return ScanResult{}, nil, err
	}
	book.Username = strings.ToLower(job.Username)
	plans := planScanCursors(book, now)
	anyIncremental := false
	for _, plan := range plans {
		if !plan.Full && plan.Since != "" {
			anyIncremental = true
			break
		}
	}
	if !anyIncremental {
		var captured []githubRepo
		var forkCount float64
		scan, err := collector.Collect(context.WithValue(ctx, inventoryCapture{}, inventoryCapture{Repos: &captured, ForkCount: &forkCount}), job.Username)
		if err != nil {
			return ScanResult{}, nil, err
		}
		var pending *pendingScanCursors
		if !quickCoverageExceeded(scan) {
			pending = &pendingScanCursors{book: book, plans: plans, repos: captured, forkCount: forkCount, now: now}
		}
		return scan, pending, nil
	}
	_, user, overview, stats, lastYear, latest, err := collector.SeedScan(ctx, job.Username)
	if err != nil {
		return ScanResult{}, nil, err
	}
	baseline := baselineFromBook(book)
	payloads := map[string]scanPartPayload{}
	incrementalParts := map[string]bool{}
	for _, part := range []string{scanPartRepos, scanPartExternal, scanPartMerged, scanPartCommits, scanPartWorkflows} {
		plan := plans[part]
		payload, delta, err := collector.collectCursorPart(ctx, job.Username, part, false, user, overview, plan)
		if err != nil {
			return ScanResult{}, nil, err
		}
		if delta {
			incrementalParts[part] = true
			baseline, payload = applyIncrementalPayload(baseline, payload, false)
		} else {
			baseline = foldPayloadBaseline(baseline, payload)
		}
		payload.Incremental = false
		payloads[part] = payload
	}
	scan, sources, err := collector.assembleCollectedScan(ctx, false, user, overview, stats, lastYear, latest, payloads)
	if err != nil {
		return ScanResult{}, nil, err
	}
	scan.SourceStatus = mergedSourceStatus(scan, sources)
	if quickCoverageExceeded(scan) {
		// Delta left the quick window. #582 deepens with a full collect.
		// This run's incremental pages are discarded. Only the full inventory
		// page is a truthful cursor; PR sources are not marked full here
		// because CollectFull does not return their nodes to this worker.
		var captured []githubRepo
		var forkCount float64
		fullScan, fullErr := collector.CollectFull(context.WithValue(ctx, inventoryCapture{}, inventoryCapture{Repos: &captured, ForkCount: &forkCount}), job.Username)
		if fullErr != nil {
			return ScanResult{}, nil, fullErr
		}
		repoPlan := plans[scanCursorRepos]
		repoPlan.Source = scanCursorRepos
		repoPlan.Full = true
		repoPlan.Since = ""
		return fullScan, &pendingScanCursors{
			book: book, plans: map[string]scanCursorPlan{scanCursorRepos: repoPlan},
			repos: captured, forkCount: forkCount, now: now,
		}, nil
	}
	return scan, &pendingScanCursors{book: book, plans: plans, baseline: baseline, now: now, useBaseline: true}, nil
}

// pendingScanCursors is the cursor book for the scan that just finished.
// It is written only after PersistCollectedScan succeeds.
type pendingScanCursors struct {
	book        scanCursorBook
	plans       map[string]scanCursorPlan
	repos       []githubRepo
	forkCount   float64
	baseline    scanSnapshotBaseline
	useBaseline bool
	now         time.Time
}

// commitPendingCursors writes the book passed by this scan. A compare-and-swap
// conflict reloads once and writes again. The public scan already committed,
// so a second conflict is logged and does not fail the scan.
func (w *ScanWorker) commitPendingCursors(ctx context.Context, pending *pendingScanCursors) error {
	if pending == nil || !w.config.ScanIncrementalEnabled {
		return nil
	}
	store, ok := w.results.(ScanCursorStore)
	if !ok {
		return nil
	}
	book := pending.book
	baseline := pending.baseline
	if !pending.useBaseline {
		baseline = scanSnapshotBaseline{Repos: append([]githubRepo(nil), pending.repos...), ForkCount: pending.forkCount}
	}
	book = advanceCursorBook(book, pending.plans, baseline, pending.now)
	if mark, ok := book.Sources[scanCursorRepos]; ok && !pending.useBaseline {
		mark.ForkCount = pending.forkCount
		book.Sources[scanCursorRepos] = mark
	}
	if strings.TrimSpace(book.Username) == "" {
		return nil
	}
	err := store.SaveScanCursors(ctx, book)
	if !errors.Is(err, ErrScanCursorConflict) {
		return err
	}
	fresh, loadErr := store.LoadScanCursors(ctx, book.Username)
	if loadErr != nil {
		return loadErr
	}
	book.Revision = fresh.Revision
	return store.SaveScanCursors(ctx, book)
}
