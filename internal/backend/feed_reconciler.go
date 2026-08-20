package backend

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"
)

const (
	feedReconcileInterval = 30 * time.Second
	feedReconcileLeaseTTL = 45 * time.Second
	feedReconcileTimeout  = 8 * time.Minute
)

type feedReconcileLeaseRenewer interface {
	RenewFeedReconcileLease(context.Context, string, time.Time, time.Duration) (bool, error)
}

type FeedProjectSource interface {
	ListFeedProjectAssessments(context.Context, string, int) ([]ProjectAssessment, error)
	GetProjectAssessment(context.Context, string) (*ProjectAssessment, error)
	ListFeedProjectOverviews(context.Context, []string) (map[string]*ProjectOverview, error)
}

type FeedProjectReconcileResult struct {
	Seen          int   `json:"seen"`
	Projected     int   `json:"projected"`
	Unchanged     int   `json:"unchanged"`
	HiddenMissing int64 `json:"hiddenMissing"`
	LeaseSkipped  bool  `json:"leaseSkipped"`
}

type FeedProjectReconciler struct {
	source   FeedProjectSource
	target   FeedDataStore
	log      *slog.Logger
	interval time.Duration
	leaseTTL time.Duration
	timeout  time.Duration
	workerID string
	now      func() time.Time
}

func NewFeedProjectReconciler(source FeedProjectSource, target FeedDataStore, logger *slog.Logger) *FeedProjectReconciler {
	if logger == nil {
		logger = slog.Default()
	}
	workerID, err := NewFeedID("catalog_reconciler")
	if err != nil {
		// NewFeedID only fails when the OS cryptographic RNG is unavailable.
		// A deterministic process-local fallback still preserves lease safety;
		// two processes have different start times at nanosecond resolution.
		workerID = "catalog_reconciler_" + strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	return &FeedProjectReconciler{
		source: source, target: target, log: logger, interval: feedReconcileInterval,
		leaseTTL: feedReconcileLeaseTTL, timeout: feedReconcileTimeout,
		workerID: workerID, now: time.Now,
	}
}

func (r *FeedProjectReconciler) buildProjections(
	ctx context.Context,
	assessments []ProjectAssessment,
) ([]FeedProjectProjection, error) {
	keys := make([]string, 0, len(assessments))
	for _, assessment := range assessments {
		keys = append(keys, assessment.RepoKey)
	}
	overviews, err := r.source.ListFeedProjectOverviews(ctx, keys)
	if err != nil {
		// Repository language/topics enrich ranking but are not publication
		// facts. Preserve tag-only projection when the graph query is degraded.
		r.log.Warn("Feed project metadata batch unavailable; projecting assessments only", "error", err)
		overviews = map[string]*ProjectOverview{}
	}
	projections := make([]FeedProjectProjection, 0, len(assessments))
	for _, assessment := range assessments {
		projection, err := BuildFeedProjectProjection(assessment, overviews[strings.ToLower(assessment.RepoKey)])
		if err != nil {
			return nil, fmt.Errorf("build Feed projection for %s: %w", assessment.RepoKey, err)
		}
		projections = append(projections, projection)
	}
	return projections, nil
}

// SyncProject is the low-latency path triggered after a Turso analysis commits.
// It is idempotent by source hash and never makes project-analysis completion
// depend on PostgreSQL: a failed event is recovered by the periodic sweep.
func (r *FeedProjectReconciler) SyncProject(ctx context.Context, repoKey string) (bool, error) {
	if r.source == nil || r.target == nil {
		return false, fmt.Errorf("Feed project reconciler dependencies are required")
	}
	assessment, err := r.source.GetProjectAssessment(ctx, repoKey)
	if err != nil {
		return false, fmt.Errorf("read Turso Feed assessment %s: %w", repoKey, err)
	}
	if assessment == nil {
		return false, nil
	}
	projections, err := r.buildProjections(ctx, []ProjectAssessment{*assessment})
	if err != nil {
		return false, err
	}
	known, err := r.target.FeedProjectSourceHashes(ctx, []string{projections[0].RepoKey})
	if err != nil {
		return false, err
	}
	if known[projections[0].RepoKey] == projections[0].SourceHash {
		return false, nil
	}
	if err := r.target.UpsertFeedProject(ctx, projections[0]); err != nil {
		return false, fmt.Errorf("project %s into Feed catalog: %w", projections[0].RepoKey, err)
	}
	return true, nil
}

func (r *FeedProjectReconciler) Reconcile(ctx context.Context) (FeedProjectReconcileResult, error) {
	result := FeedProjectReconcileResult{}
	if r.source == nil || r.target == nil {
		return result, fmt.Errorf("Feed project reconciler dependencies are required")
	}
	startedAt := r.now().UTC()
	acquired, err := r.target.AcquireFeedReconcileLease(ctx, r.workerID, startedAt, r.leaseTTL)
	if err != nil {
		return result, err
	}
	if !acquired {
		result.LeaseSkipped = true
		return result, nil
	}
	defer func() {
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := r.target.ReleaseFeedReconcileLease(releaseCtx, r.workerID); err != nil {
			r.log.Warn("release Feed project reconciliation lease", "error", err)
		}
	}()
	renewLease := func() error {
		renewer, ok := r.target.(feedReconcileLeaseRenewer)
		if !ok {
			return nil
		}
		renewed, err := renewer.RenewFeedReconcileLease(ctx, r.workerID, r.now().UTC(), r.leaseTTL)
		if err != nil {
			return fmt.Errorf("renew Feed project reconciliation lease: %w", err)
		}
		if !renewed {
			return fmt.Errorf("Feed project reconciliation lease was lost")
		}
		return nil
	}

	seen := []string{}
	const pageSize = 100
	afterRepoKey := ""
	for {
		assessments, err := r.source.ListFeedProjectAssessments(ctx, afterRepoKey, pageSize)
		if err != nil {
			_ = r.target.MarkFeedReconcile(ctx, afterRepoKey, startedAt, false)
			return result, fmt.Errorf("list Turso Feed assessments after %q: %w", afterRepoKey, err)
		}
		if len(assessments) == 0 {
			break
		}
		projections, err := r.buildProjections(ctx, assessments)
		if err != nil {
			_ = r.target.MarkFeedReconcile(ctx, afterRepoKey, startedAt, false)
			return result, err
		}
		keys := make([]string, 0, len(projections))
		for _, projection := range projections {
			keys = append(keys, projection.RepoKey)
		}
		known, err := r.target.FeedProjectSourceHashes(ctx, keys)
		if err != nil {
			_ = r.target.MarkFeedReconcile(ctx, afterRepoKey, startedAt, false)
			return result, err
		}
		for _, projection := range projections {
			result.Seen++
			seen = append(seen, projection.RepoKey)
			afterRepoKey = projection.RepoKey
			if known[projection.RepoKey] == projection.SourceHash {
				result.Unchanged++
				continue
			}
			if err := r.target.UpsertFeedProject(ctx, projection); err != nil {
				_ = r.target.MarkFeedReconcile(ctx, afterRepoKey, startedAt, false)
				return result, fmt.Errorf("project %s into Feed catalog: %w", projection.RepoKey, err)
			}
			result.Projected++
		}
		if err := renewLease(); err != nil {
			_ = r.target.MarkFeedReconcile(ctx, afterRepoKey, startedAt, false)
			return result, err
		}
		if len(assessments) < pageSize {
			break
		}
	}
	if result.Seen == 0 {
		_ = r.target.MarkFeedReconcile(ctx, "0", startedAt, false)
		return result, fmt.Errorf("Turso Feed reconciliation returned an empty snapshot; refusing mass hide")
	}
	if err := renewLease(); err != nil {
		_ = r.target.MarkFeedReconcile(ctx, afterRepoKey, startedAt, false)
		return result, err
	}
	hidden, err := r.target.FinalizeFeedProjectReconcile(ctx, seen, startedAt)
	if err != nil {
		_ = r.target.MarkFeedReconcile(ctx, afterRepoKey, startedAt, false)
		return result, err
	}
	result.HiddenMissing = hidden
	if err := r.target.MarkFeedReconcile(ctx, strconv.Itoa(result.Seen), startedAt, true); err != nil {
		return result, err
	}
	return result, nil
}

func (r *FeedProjectReconciler) Run(ctx context.Context) error {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		started := r.now().UTC()
		reconcileCtx, cancel := context.WithTimeout(ctx, r.timeout)
		result, err := r.Reconcile(reconcileCtx)
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			r.log.Error("Feed project reconciliation failed", "error", err)
		} else if !result.LeaseSkipped {
			r.log.Info("Feed project reconciliation completed", "seen", result.Seen,
				"projected", result.Projected, "unchanged", result.Unchanged,
				"hidden_missing", result.HiddenMissing, "duration", r.now().UTC().Sub(started))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
