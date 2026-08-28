package backend

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/rabbitmq/amqp091-go"
)

const (
	// projectAnalysisPollInterval mirrors the implicit cadence of the former
	// Next reconcile loop; the worker polls the Mosoo snapshot at this rate.
	projectAnalysisPollInterval = 5 * time.Second
	// projectAnalysisArtifactGraceMs mirrors the 30-second artifact grace in
	// finalizeCompletedRun: a just-completed run may still be committing files.
	projectAnalysisArtifactGrace = 30 * time.Second
	// maxAutomaticMosooRunRetries mirrors MAX_AUTOMATIC_MOSOO_RUN_RETRIES.
	maxAutomaticMosooRunRetries = 1
	// projectAnalysisDeliveryBuffer keeps the per-delivery context alive past
	// the run timeout so one last finalize pass can finish.
	projectAnalysisDeliveryBuffer = time.Minute
	// projectAnalysisDeferredRedriveDelay is the wake-up interval for a run
	// parked by slot contention: the delayed retry lane re-enqueues the job
	// until an execution slot frees. Runs parked on a scheduled create retry
	// instead wake at their exact retry time.
	projectAnalysisDeferredRedriveDelay = 15 * time.Second
	// projectAnalysisDeferredRedriveJitter spreads the fixed redrive interval
	// by ±5s so runs parked by the same event (e.g. a full slot window right
	// after an outage) do not wake in lockstep and race the slot check.
	projectAnalysisDeferredRedriveJitter = 5 * time.Second
)

var mosooRunRetrySuffix = regexp.MustCompile(`-retry-(\d+)$`)

// ProjectAnalysisWorker drives the full reconcile loop that
// src/lib/project-analysis-service.ts used to run inside the Next runtime:
// reserve a concurrency slot, create or resume the Mosoo Thread, poll the
// snapshot into Turso, and finalize validated artifacts.
type ProjectAnalysisWorker struct {
	config    Config
	runs      *TursoStore
	mosoo     *MosooClient
	cache     ProjectAnalysisResultCache
	publisher ProjectAnalysisJobPublisher
	feedSync  FeedCatalogSyncPublisher
	metrics   *BackendMetrics
	log       *slog.Logger
	poll      time.Duration
	verifier  *http.Client
}

func NewProjectAnalysisWorker(
	config Config,
	runs *TursoStore,
	mosoo *MosooClient,
	statuses JobStatusStore,
	publisher ProjectAnalysisJobPublisher,
	logger *slog.Logger,
) *ProjectAnalysisWorker {
	if logger == nil {
		logger = slog.Default()
	}
	worker := &ProjectAnalysisWorker{
		config: config, runs: runs, mosoo: mosoo, publisher: publisher,
		metrics: NewBackendMetrics(), log: logger,
		poll:     projectAnalysisPollInterval,
		verifier: &http.Client{Timeout: 5 * time.Second},
	}
	if config.FeedMode.Enabled() {
		if feedSync, ok := publisher.(FeedCatalogSyncPublisher); ok {
			worker.feedSync = feedSync
		}
	}
	if cache, ok := statuses.(ProjectAnalysisResultCache); ok {
		worker.cache = cache
	}
	return worker
}

func (w *ProjectAnalysisWorker) UseMetrics(metrics *BackendMetrics) *ProjectAnalysisWorker {
	if metrics != nil {
		w.metrics = metrics
	}
	return w
}

func (w *ProjectAnalysisWorker) Run(ctx context.Context) error {
	connection, err := amqp091.Dial(w.config.RabbitURL)
	if err != nil {
		return fmt.Errorf("dial RabbitMQ project analysis consumer: %w", err)
	}
	defer connection.Close()
	channel, err := connection.Channel()
	if err != nil {
		return fmt.Errorf("open project analysis worker channel: %w", err)
	}
	defer channel.Close()
	if err := declareJobTopology(channel); err != nil {
		return err
	}
	concurrency := w.config.ProjectAnalysisConcurrency
	if concurrency < 1 {
		concurrency = 1
	}
	if err := channel.Qos(concurrency, 0, false); err != nil {
		return fmt.Errorf("configure project analysis worker prefetch: %w", err)
	}
	deliveries, err := channel.Consume(projectAnalysisQueue, "ghfind-project-analysis-worker", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume project analysis jobs: %w", err)
	}
	return w.consumeDeliveries(ctx, deliveries, concurrency)
}

// consumeDeliveries mirrors ScanWorker.consumeDeliveries: bounded parallelism
// with per-delivery goroutines, and in-flight jobs drain on shutdown.
func (w *ProjectAnalysisWorker) consumeDeliveries(ctx context.Context, deliveries <-chan amqp091.Delivery, concurrency int) error {
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
				return fmt.Errorf("RabbitMQ project analysis delivery channel closed")
			}
			semaphore <- struct{}{}
			inFlight.Add(1)
			go func() {
				defer inFlight.Done()
				defer func() { <-semaphore }()
				w.handleDelivery(ctx, delivery)
			}()
		}
	}
}

func (w *ProjectAnalysisWorker) handleDelivery(ctx context.Context, delivery amqp091.Delivery) {
	var job ProjectAnalysisJob
	if err := json.Unmarshal(delivery.Body, &job); err != nil || job.ID == "" {
		w.log.Error("discarding malformed project analysis job", "error", err)
		_ = delivery.Reject(false)
		return
	}
	processCtx, cancel := context.WithTimeout(ctx, w.config.ProjectAnalysisTimeout+projectAnalysisDeliveryBuffer)
	disposition, reason := w.process(processCtx, job)
	cancel()
	switch disposition {
	case workerCompleted:
		_ = delivery.Ack(false)
	case workerRetry:
		next := job
		next.Attempt++
		if next.Attempt >= w.config.MaxAttempts {
			w.deadLetterOrRequeue(ctx, delivery, next, reason)
			return
		}
		publishCtx, cancel := context.WithTimeout(ctx, workerDeliveryTimeout)
		err := w.publisher.PublishProjectAnalysisRetry(publishCtx, next, retryDelay(next.Attempt))
		cancel()
		if err != nil {
			w.log.Error("publish project analysis retry", "job_id", job.ID, "error", err)
			_ = delivery.Nack(false, true)
			return
		}
		_ = delivery.Ack(false)
	case workerDead:
		w.deadLetterOrRequeue(ctx, delivery, job, reason)
	}
}

func (w *ProjectAnalysisWorker) deadLetterOrRequeue(ctx context.Context, delivery amqp091.Delivery, job ProjectAnalysisJob, reason string) {
	publishCtx, cancel := context.WithTimeout(ctx, workerDeliveryTimeout)
	err := w.publisher.PublishProjectAnalysisDead(publishCtx, job, reason)
	cancel()
	if err != nil {
		w.log.Error("publish terminal project analysis failure", "job_id", job.ID, "error", err)
		_ = delivery.Nack(false, true)
		return
	}
	w.metrics.recordWorkerJobDeadLettered(ProjectAnalysisJobKind)
	_ = delivery.Ack(false)
}

// process runs the reconcile loop for one analysis until the run reaches a
// terminal state, parks (slot contention or a scheduled create retry), or a
// transient infrastructure failure forces a redelivery.
func (w *ProjectAnalysisWorker) process(ctx context.Context, job ProjectAnalysisJob) (workerDisposition, string) {
	startedAt := time.Now()
	w.metrics.recordWorkerJobStarted(ProjectAnalysisJobKind)
	run, err := w.runs.GetProjectAnalysisRun(ctx, job.ID)
	if err != nil {
		w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
		return workerRetry, "run store unavailable: " + err.Error()
	}
	if run == nil {
		w.metrics.recordWorkerJobFailed(ProjectAnalysisJobKind, "permanent", time.Since(startedAt))
		return workerDead, "analysis_not_found"
	}
	for {
		if projectAnalysisTerminal(run.Status) {
			w.metrics.recordWorkerJobCompleted(ProjectAnalysisJobKind, run.Status, time.Since(startedAt))
			return workerCompleted, ""
		}
		if run.StartedAt != nil && time.Since(time.UnixMilli(*run.StartedAt)) > w.config.ProjectAnalysisTimeout {
			if err := w.failRun(ctx, run.ID, "analysis_timeout", "Project analysis exceeded the configured execution timeout.", ProjectAnalysisStatusExpired, nil); err != nil {
				w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
				return workerRetry, err.Error()
			}
			run = w.reloadRun(ctx, run)
			continue
		}
		var disposition workerDisposition
		var reason string
		if run.MosooThreadID == nil {
			disposition, reason, run = w.createOrResumeThread(ctx, job, run, startedAt)
		} else {
			disposition, reason, run = w.pollThread(ctx, run, startedAt)
		}
		if disposition != workerCompleted || reason != "" {
			return disposition, reason
		}
	}
}

func projectAnalysisTerminal(status ProjectAnalysisStatus) bool {
	return status == ProjectAnalysisStatusCompleted ||
		status == ProjectAnalysisStatusFailed ||
		status == ProjectAnalysisStatusCancelled ||
		status == ProjectAnalysisStatusExpired
}

// reloadRun refreshes the run after a state write. A refresh failure keeps the
// last known state: the next loop pass reads the row again.
func (w *ProjectAnalysisWorker) reloadRun(ctx context.Context, run *ProjectAnalysisRun) *ProjectAnalysisRun {
	fresh, err := w.runs.GetProjectAnalysisRun(ctx, run.ID)
	if err != nil || fresh == nil {
		return run
	}
	return fresh
}

func (w *ProjectAnalysisWorker) failRun(ctx context.Context, analysisID, code, message, status string, activities []ProjectAnalysisActivity) error {
	if err := w.runs.FailProjectAnalysis(ctx, analysisID, code, message, status, activities); err != nil {
		return fmt.Errorf("fail project analysis: %w", err)
	}
	return nil
}

// createOrResumeThread mirrors createOrResumeMosooThread. It returns a
// completed disposition (with an empty reason) whenever the loop should
// continue with the returned run, and a parked marker when the delivery is
// done because the run waits on a slot or a scheduled create retry. Parked
// runs are re-driven through the delayed retry lane (see redriveDeferred), so
// they no longer depend on the external reconcile endpoint to wake up.
func (w *ProjectAnalysisWorker) createOrResumeThread(ctx context.Context, job ProjectAnalysisJob, run *ProjectAnalysisRun, startedAt time.Time) (workerDisposition, string, *ProjectAnalysisRun) {
	now := time.Now()
	if run.MosooThreadID == nil && run.CreateAttempts >= w.config.ProjectAnalysisCreateMaxAttempts &&
		(run.CreateRetryAt == nil || *run.CreateRetryAt <= now.UnixMilli()) {
		message := fmt.Sprintf("Mosoo Thread creation failed after %d attempts.", run.CreateAttempts)
		if err := w.failRun(ctx, run.ID, "mosoo_create_retry_exhausted", message, "", nil); err != nil {
			w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
			return workerRetry, err.Error(), run
		}
		return workerCompleted, "", w.reloadRun(ctx, run)
	}
	reserved, err := w.runs.ReserveProjectAnalysisExecutionSlot(ctx, run.ID, w.config.ProjectAnalysisConcurrency, w.config.ProjectAnalysisCreateAttemptLease())
	if err != nil {
		w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
		return workerRetry, "reserve execution slot: " + err.Error(), run
	}
	if !reserved {
		// Slot contention or a pending create retry: park the delivery and
		// republish the job through the delayed retry lane so the run wakes up
		// on its own. The reconcile endpoint remains a manual backstop.
		current := w.reloadRun(ctx, run)
		disposition, reason := w.redriveDeferred(ctx, job, deferredRedriveDelayFor(current), startedAt)
		return disposition, reason, current
	}
	attemptRun := w.reloadRun(ctx, run)
	snapshot, err := w.mosoo.CreateProjectAnalysisThread(ctx, attemptRun, w.config.ProjectAnalysisExecutionMode(attemptRun.RepoKey))
	if err != nil {
		if IsRetryableMosooError(err) {
			mosooErr := err.(*MosooError)
			if attemptRun.CreateAttempts >= w.config.ProjectAnalysisCreateMaxAttempts {
				if failErr := w.failRun(ctx, attemptRun.ID, "mosoo_create_retry_exhausted", mosooErr.Message, "", nil); failErr != nil {
					w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
					return workerRetry, failErr.Error(), attemptRun
				}
				return workerCompleted, "", w.reloadRun(ctx, attemptRun)
			}
			retryAt := time.Now().Add(w.createRetryDelay(attemptRun.CreateAttempts, mosooErr)).UnixMilli()
			pending, scheduleErr := w.runs.ScheduleProjectAnalysisCreateRetry(ctx, attemptRun.ID, retryAt)
			if scheduleErr != nil {
				w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
				return workerRetry, "schedule create retry: " + scheduleErr.Error(), attemptRun
			}
			if pending == nil {
				w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
				return workerRetry, "Project analysis could not schedule its next creation attempt.", attemptRun
			}
			w.log.Warn("project_analysis.create_retry_scheduled",
				"analysis_id", pending.ID, "repo_key", pending.RepoKey,
				"attempt", pending.CreateAttempts, "error_code", mosooErr.Code)
			disposition, reason := w.redriveDeferred(ctx, job, time.Until(time.UnixMilli(retryAt)), startedAt)
			return disposition, reason, pending
		}
		code := MosooUnavailable
		message := "Mosoo project analysis failed."
		if mosooErr, ok := err.(*MosooError); ok {
			code = mosooErr.Code
			message = mosooErr.Message
		}
		if failErr := w.failRun(ctx, attemptRun.ID, code, message, "", nil); failErr != nil {
			w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
			return workerRetry, failErr.Error(), attemptRun
		}
		return workerCompleted, "", w.reloadRun(ctx, attemptRun)
	}
	if err := w.runs.AttachMosooThread(ctx, AttachMosooThreadInput{
		AnalysisID: attemptRun.ID,
		AgentID:    w.mosoo.AgentID(),
		ThreadID:   snapshot.ThreadID,
		RunID:      snapshot.RunID,
	}); err != nil {
		w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
		return workerRetry, "attach Mosoo thread: " + err.Error(), attemptRun
	}
	attached := w.reloadRun(ctx, attemptRun)
	if attached.MosooThreadID == nil {
		w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
		return workerRetry, "Project analysis disappeared after Mosoo Thread creation.", attemptRun
	}
	return workerCompleted, "", attached
}

// createRetryDelay mirrors createRetryDelayMs: an upstream Retry-After wins,
// otherwise the base delay doubles per attempt, capped at one minute.
func (w *ProjectAnalysisWorker) createRetryDelay(attempt int, err *MosooError) time.Duration {
	if err.RetryAfterSeconds > 0 {
		delay := time.Duration(err.RetryAfterSeconds) * time.Second
		if delay > 5*time.Minute {
			return 5 * time.Minute
		}
		return delay
	}
	delay := w.config.ProjectAnalysisCreateRetryBase
	for i := 1; i < attempt && delay < time.Minute; i++ {
		delay *= 2
	}
	if delay > time.Minute {
		return time.Minute
	}
	return delay
}

// deferredRedriveDelayFor picks the wake-up delay for a parked run: a pending
// create retry wakes at its scheduled time, while slot contention polls on a
// fixed jittered interval until an execution slot frees.
func deferredRedriveDelayFor(run *ProjectAnalysisRun) time.Duration {
	if run != nil && run.CreateRetryAt != nil {
		if delay := time.Until(time.UnixMilli(*run.CreateRetryAt)); delay > 0 {
			return delay
		}
	}
	spread := int64(2 * projectAnalysisDeferredRedriveJitter)
	jitter := time.Duration(rand.Int63n(spread)) - projectAnalysisDeferredRedriveJitter
	return projectAnalysisDeferredRedriveDelay + jitter
}

// redriveDeferred republishes a parked job through the delayed retry lane so
// the run is re-driven without the external reconcile endpoint. The attempt
// counter is preserved on purpose: parking is waiting, not a failure, so it
// must not consume the MaxAttempts budget or dead-letter the job. A publish
// failure falls back to the ordinary workerRetry path.
func (w *ProjectAnalysisWorker) redriveDeferred(ctx context.Context, job ProjectAnalysisJob, delay time.Duration, startedAt time.Time) (workerDisposition, string) {
	if delay < time.Second {
		delay = time.Second
	}
	publishCtx, cancel := context.WithTimeout(ctx, workerDeliveryTimeout)
	err := w.publisher.PublishProjectAnalysisRetry(publishCtx, job, delay)
	cancel()
	if err != nil {
		w.log.Error("redrive deferred project analysis", "job_id", job.ID, "error", err)
		w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
		return workerRetry, "redrive deferred project analysis: " + err.Error()
	}
	w.metrics.recordWorkerJobCompleted(ProjectAnalysisJobKind, "deferred", time.Since(startedAt))
	return workerCompleted, "deferred"
}

// pollThread mirrors the snapshot-driven half of reconcileProjectAnalysis.
func (w *ProjectAnalysisWorker) pollThread(ctx context.Context, run *ProjectAnalysisRun, startedAt time.Time) (workerDisposition, string, *ProjectAnalysisRun) {
	snapshot, err := w.mosoo.GetProjectAnalysisSnapshot(ctx, *run.MosooThreadID)
	if err != nil {
		if IsRetryableMosooError(err) {
			// Mirror reconcileProjectAnalysis: a transient snapshot failure
			// leaves the run untouched and the loop tries again next pass.
			if !w.sleep(ctx) {
				w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
				return workerRetry, ctx.Err().Error(), run
			}
			return workerCompleted, "", w.reloadRun(ctx, run)
		}
		code := MosooUnavailable
		message := "Mosoo project analysis failed."
		if mosooErr, ok := err.(*MosooError); ok {
			code = mosooErr.Code
			message = mosooErr.Message
		}
		if failErr := w.failRun(ctx, run.ID, code, message, "", nil); failErr != nil {
			w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
			return workerRetry, failErr.Error(), run
		}
		return workerCompleted, "", w.reloadRun(ctx, run)
	}

	switch snapshot.RunStatus {
	case "waiting_input":
		if err := w.failRun(ctx, run.ID, "unexpected_input_request", "The Cattle project Agent unexpectedly requested user input.", "", nil); err != nil {
			w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
			return workerRetry, err.Error(), run
		}
		return workerCompleted, "", w.reloadRun(ctx, run)
	case "failed", "cancelled", "expired":
		if snapshot.RunStatus == "failed" && snapshot.RunError != nil &&
			snapshot.RunError.Code == "runtime.inactive" &&
			mosooRunRetryCount(run) < maxAutomaticMosooRunRetries {
			pending, err := w.runs.PrepareProjectAnalysisRetry(ctx, run.ID, *run.MosooThreadID,
				fmt.Sprintf("%s-retry-%d", run.IdempotencyKey, mosooRunRetryCount(run)+1))
			if err != nil {
				w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
				return workerRetry, "prepare run retry: " + err.Error(), run
			}
			if pending != nil {
				return workerCompleted, "", pending
			}
			return workerCompleted, "", w.reloadRun(ctx, run)
		}
		terminalStatus := ProjectAnalysisStatusFailed
		if snapshot.RunStatus == "cancelled" {
			terminalStatus = ProjectAnalysisStatusCancelled
		} else if snapshot.RunStatus == "expired" {
			terminalStatus = ProjectAnalysisStatusExpired
		}
		code := "mosoo_run_" + snapshot.RunStatus
		message := fmt.Sprintf("Mosoo project analysis ended with %s.", snapshot.RunStatus)
		if err := w.failRun(ctx, run.ID, code, message, terminalStatus, snapshot.Activities); err != nil {
			w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
			return workerRetry, err.Error(), run
		}
		return workerCompleted, "", w.reloadRun(ctx, run)
	case "completed":
		return w.finalizeCompletedRun(ctx, run, startedAt)
	default:
		phase, progress := projectAnalysisRunningPhase(snapshot)
		if err := w.runs.UpdateProjectAnalysisState(ctx, UpdateProjectAnalysisStateInput{
			AnalysisID: run.ID,
			Status:     ProjectAnalysisStatusRunning,
			Phase:      phase,
			Progress:   progress,
			RunID:      &snapshot.RunID,
			Activities: snapshot.Activities,
		}); err != nil {
			w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
			return workerRetry, "update analysis state: " + err.Error(), run
		}
		if !w.sleep(ctx) {
			w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
			return workerRetry, ctx.Err().Error(), run
		}
		return workerCompleted, "", w.reloadRun(ctx, run)
	}
}

func mosooRunRetryCount(run *ProjectAnalysisRun) int {
	match := mosooRunRetrySuffix.FindStringSubmatch(run.IdempotencyKey)
	if len(match) != 2 {
		return 0
	}
	count := 0
	for _, digit := range match[1] {
		count = count*10 + int(digit-'0')
	}
	return count
}

// sleep waits one poll interval; it reports false when the delivery context
// ended first.
func (w *ProjectAnalysisWorker) sleep(ctx context.Context) bool {
	timer := time.NewTimer(w.poll)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// finalizeCompletedRun mirrors finalizeCompletedRun: download the artifacts,
// verify the repository identity, validate both artifacts, and commit the
// finalization transaction.
func (w *ProjectAnalysisWorker) finalizeCompletedRun(ctx context.Context, run *ProjectAnalysisRun, startedAt time.Time) (workerDisposition, string, *ProjectAnalysisRun) {
	artifacts, err := w.mosoo.ReadProjectAnalysisArtifacts(ctx, *run.MosooThreadID, run.ID)
	if err != nil {
		if mosooErr, ok := err.(*MosooError); ok && mosooErr.Code == MosooArtifactMissing &&
			time.Since(time.UnixMilli(run.UpdatedAt)) < projectAnalysisArtifactGrace {
			// The run just completed; files may still be committing. Wait one
			// poll instead of failing, exactly like the TypeScript grace.
			if !w.sleep(ctx) {
				w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
				return workerRetry, ctx.Err().Error(), run
			}
			return workerCompleted, "", w.reloadRun(ctx, run)
		}
		code := MosooArtifactMissing
		message := "Project artifacts are missing."
		if mosooErr, ok := err.(*MosooError); ok {
			code = mosooErr.Code
			message = mosooErr.Message
		}
		if failErr := w.failRun(ctx, run.ID, code, message, "", nil); failErr != nil {
			w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
			return workerRetry, failErr.Error(), run
		}
		return workerCompleted, "", w.reloadRun(ctx, run)
	}

	if err := w.runs.UpdateProjectAnalysisState(ctx, UpdateProjectAnalysisStateInput{
		AnalysisID: run.ID,
		Status:     ProjectAnalysisStatusFinalizing,
		Phase:      "persisting",
		Progress:   90,
	}); err != nil {
		w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
		return workerRetry, "mark analysis finalizing: " + err.Error(), run
	}

	failInvalid := func(cause error) (workerDisposition, string, *ProjectAnalysisRun) {
		if failErr := w.failRun(ctx, run.ID, "artifact_invalid", cause.Error(), "", nil); failErr != nil {
			w.metrics.recordWorkerJobRetry(ProjectAnalysisJobKind, time.Since(startedAt))
			return workerRetry, failErr.Error(), run
		}
		return workerCompleted, "", w.reloadRun(ctx, run)
	}

	expectedRepoKey := w.verifiedArtifactRepoKey(ctx, run, artifacts.AnalysisJSON)
	parsed, err := ParseProjectAnalysisArtifacts(ProjectAnalysisArtifactsInput{
		AnalysisRaw:        artifacts.AnalysisJSON,
		EvidenceRaw:        artifacts.EvidenceJSON,
		ReportMarkdown:     artifacts.ReportMarkdown,
		ExpectedAnalysisID: run.ID,
		ExpectedRepoKey:    expectedRepoKey,
		ExpectedRun: &ProjectAnalysisRunIdentity{
			RubricVersion: run.RubricVersion,
			AgentVersion:  run.AgentVersion,
			SkillVersion:  run.SkillVersion,
			RequestedRef:  run.RequestedRef,
		},
	})
	if err != nil {
		return failInvalid(err)
	}
	completed, err := w.runs.FinalizeProjectAnalysis(ctx, FinalizeProjectAnalysisInput{
		AnalysisID:     run.ID,
		Analysis:       parsed.Analysis,
		AnalysisJSON:   artifacts.AnalysisJSON,
		EvidenceJSON:   artifacts.EvidenceJSON,
		ReportMarkdown: artifacts.ReportMarkdown,
		Hashes: ProjectAnalysisArtifactHashes{
			Analysis: sha256Hex(artifacts.AnalysisJSON),
			Evidence: sha256Hex(artifacts.EvidenceJSON),
			Report:   sha256Hex(artifacts.ReportMarkdown),
		},
	})
	if err != nil {
		return failInvalid(err)
	}
	// The completed-result index is best-effort, exactly like
	// cacheCompletedProjectAnalysis: Turso remains the authority.
	if w.cache != nil {
		fingerprint := ProjectAnalysisResultFingerprint(
			completed.RepoKey, completed.RequestedRef,
			completed.SchemaVersion, completed.RubricVersion,
			completed.AgentVersion, completed.SkillVersion,
		)
		if err := w.cache.SetCachedProjectAnalysisID(ctx, fingerprint, completed.ID); err != nil {
			w.log.Warn("cache completed project analysis", "analysis_id", completed.ID, "error", err)
		}
	}
	// Turso completion is the authoritative commit and must never be rolled
	// back because the optional Feed projection is unavailable. Publish a
	// confirmed low-latency hint after that commit; the leased 30-second
	// reconciliation sweep repairs a lost cross-database message.
	if w.feedSync != nil {
		publishCtx, cancel := context.WithTimeout(ctx, workerDeliveryTimeout)
		err := w.feedSync.PublishFeedCatalogSync(publishCtx, FeedCatalogSyncJob{
			RepoKey: completed.RepoKey, AnalysisID: completed.ID, RequestedAt: time.Now().UTC().UnixMilli(),
		})
		cancel()
		if err != nil {
			w.log.Warn("publish Feed catalog sync after analysis completion", "analysis_id", completed.ID,
				"repo_key", completed.RepoKey, "error", err)
		}
	}
	w.log.Info("project_analysis.completed",
		"analysis_id", completed.ID, "repo_key", completed.RepoKey,
		"mosoo_thread_id", completed.MosooThreadID, "status", completed.Status,
		"verification_level", completed.VerificationLevel)
	return workerCompleted, "", completed
}

// verifiedArtifactRepoKey mirrors verifiedArtifactRepoKey: when an artifact
// claims a different repository, a redirect-following HEAD on the canonical
// URL decides whether the rename is legitimate.
func (w *ProjectAnalysisWorker) verifiedArtifactRepoKey(ctx context.Context, run *ProjectAnalysisRun, analysisJSON string) string {
	claimed := artifactRepoKey(analysisJSON)
	if claimed == "" || claimed == run.RepoKey {
		return run.RepoKey
	}
	headCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(headCtx, http.MethodHead, run.CanonicalURL, nil)
	if err != nil {
		return run.RepoKey
	}
	request.Header.Set("User-Agent", "ghfind-project-identity-resolver")
	response, err := w.verifier.Do(request)
	if err != nil {
		return run.RepoKey
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return run.RepoKey
	}
	redirected, err := NormalizeGitHubRepository(response.Request.URL.String())
	if err != nil {
		return run.RepoKey
	}
	if redirected.RepoKey == claimed {
		return redirected.RepoKey
	}
	return run.RepoKey
}

// artifactRepoKey mirrors the TypeScript artifactRepoKey: best-effort peek at
// repository.repo_key without full validation.
func artifactRepoKey(analysisJSON string) string {
	var value struct {
		Repository *struct {
			RepoKey string `json:"repo_key"`
		} `json:"repository"`
	}
	if err := json.Unmarshal([]byte(analysisJSON), &value); err != nil || value.Repository == nil {
		return ""
	}
	return strings.ToLower(value.Repository.RepoKey)
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// projectAnalysisRunningPhase mirrors runningPhase: the latest public
// activity wins, then raw event types, then the classifying default.
func projectAnalysisRunningPhase(snapshot *MosooThreadSnapshot) (string, int) {
	if len(snapshot.Activities) > 0 {
		switch snapshot.Activities[len(snapshot.Activities)-1].Kind {
		case "started":
			return "classifying", 15
		case "inspecting_source":
			return "inspecting", 30
		case "inspecting_docs":
			return "inspecting", 40
		case "inspecting_history":
			return "inspecting", 50
		case "checking_community":
			return "inspecting", 60
		case "evaluating":
			return "evaluating", 70
		case "writing":
			return "writing_report", 80
		case "validating":
			return "persisting", 88
		case "saving":
			return "persisting", 92
		case "completed":
			return "persisting", 95
		case "failed":
			return "evaluating", 65
		}
	}
	for _, eventType := range snapshot.EventTypes {
		if eventType == "file.changed" || eventType == "session_files.updated" {
			return "writing_report", 80
		}
	}
	for _, eventType := range snapshot.EventTypes {
		if eventType == "tool.use.completed" {
			return "evaluating", 65
		}
	}
	for _, eventType := range snapshot.EventTypes {
		if eventType == "tool.use.started" {
			return "inspecting", 35
		}
	}
	return "classifying", 15
}
