import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processPublicScanJob: vi.fn(),
  recordPublicScanWorkerMetrics: vi.fn(),
  recordPublicScanStepMetrics: vi.fn(),
}));

vi.mock("@/lib/public-scan-worker", () => ({
  processPublicScanJob: mocks.processPublicScanJob,
}));

vi.mock("@/lib/db", () => ({
  recordPublicScanWorkerMetrics: mocks.recordPublicScanWorkerMetrics,
  recordPublicScanStepMetrics: mocks.recordPublicScanStepMetrics,
}));

import {
  drainPublicScanJobs,
  drainPublicScanJobsFromWorker,
} from "../public-scan-dispatcher";

describe("public scan dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordPublicScanWorkerMetrics.mockResolvedValue(true);
    mocks.recordPublicScanStepMetrics.mockResolvedValue(true);
  });

  it("drains canonical worker work until the durable queue is idle", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.processPublicScanJob
      .mockResolvedValueOnce({
        status: "continued",
        jobId: "job-id",
        runId: "run-id",
        phase: "merged_prs",
      })
      .mockResolvedValueOnce({
        status: "complete",
        jobId: "job-id",
        runId: "run-id",
        phase: "publish",
      })
      .mockResolvedValueOnce({ status: "idle" });

    await expect(
      drainPublicScanJobs({
        maxSteps: 8,
        maxDurationMs: 10_000,
        source: "worker",
      }),
    ).resolves.toEqual({
      processed: 2,
      results: [
        { status: "continued", jobId: "job-id", runId: "run-id", phase: "merged_prs" },
        { status: "complete", jobId: "job-id", runId: "run-id", phase: "publish" },
      ],
      exhaustedBudget: false,
    });
    expect(mocks.processPublicScanJob).toHaveBeenCalledTimes(3);
    expect(mocks.processPublicScanJob).toHaveBeenNthCalledWith(1, undefined);
    expect(mocks.recordPublicScanStepMetrics).toHaveBeenCalledWith({
      collectionVersion: "v4",
      observations: [
        expect.objectContaining({ phase: "merged_prs", outcome: "continued" }),
        expect.objectContaining({ phase: "publish", outcome: "complete" }),
      ],
    });
    log.mockRestore();
  });

  it("caps one worker drain call at its requested number of steps", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.processPublicScanJob.mockResolvedValue({
      status: "continued",
      jobId: "job-id",
      runId: "run-id",
      phase: "merged_prs",
    });

    await expect(
      drainPublicScanJobs({
        maxSteps: 2,
        maxDurationMs: 10_000,
        source: "worker",
      }),
    ).resolves.toMatchObject({ processed: 2, exhaustedBudget: true });
    expect(mocks.processPublicScanJob).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it("runs exactly one bounded step for the explicitly created request job", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.processPublicScanJob.mockResolvedValue({
      status: "continued",
      jobId: "target-job-id",
      runId: "target-run-id",
      phase: "original_repos",
    });

    await expect(
      drainPublicScanJobs({
        maxSteps: 24,
        maxDurationMs: 50_000,
        source: "request",
        targetJobId: "target-job-id",
      }),
    ).resolves.toMatchObject({ processed: 1, exhaustedBudget: true });
    expect(mocks.processPublicScanJob).toHaveBeenCalledOnce();
    expect(mocks.processPublicScanJob).toHaveBeenCalledWith("target-job-id");
    log.mockRestore();
  });

  it("stops a global drain after slot contention without counting a processed step", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.processPublicScanJob.mockResolvedValue({
      status: "slot_busy",
      jobId: "blocked-job-id",
      runId: "blocked-run-id",
      phase: "quick",
    });

    await expect(
      drainPublicScanJobs({
        maxSteps: 24,
        maxDurationMs: 50_000,
        source: "worker",
      }),
    ).resolves.toMatchObject({ processed: 0, exhaustedBudget: false });
    expect(mocks.processPublicScanJob).toHaveBeenCalledOnce();
    expect(mocks.recordPublicScanStepMetrics).toHaveBeenCalledWith({
      collectionVersion: "v4",
      observations: [expect.objectContaining({ phase: "quick", outcome: "slot_busy" })],
    });
    log.mockRestore();
  });

  it("records a successful worker heartbeat even when the queue is empty", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.processPublicScanJob.mockResolvedValue({ status: "idle" });

    await expect(drainPublicScanJobsFromWorker({ leaseMs: 300_000 })).resolves.toMatchObject({ processed: 0 });
    expect(mocks.processPublicScanJob).toHaveBeenCalledWith({
      jobId: undefined,
      leaseMs: 300_000,
    });
    expect(mocks.recordPublicScanWorkerMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ processed: 0, failedSteps: 0, success: true }),
    );
    log.mockRestore();
  });

  it("does not persist an explicitly throttled idle heartbeat", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.processPublicScanJob.mockResolvedValue({ status: "idle" });

    await expect(
      drainPublicScanJobsFromWorker({ leaseMs: 300_000, recordIdleHeartbeat: false }),
    ).resolves.toMatchObject({ processed: 0 });
    expect(mocks.recordPublicScanWorkerMetrics).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith("public_scan.worker", expect.any(String));
    log.mockRestore();
  });

  it("records a failed worker heartbeat without logging the raw exception", async () => {
    const rawMarker = "sensitive-upstream-marker";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.processPublicScanJob.mockRejectedValue(new Error(rawMarker));

    await expect(drainPublicScanJobsFromWorker({ leaseMs: 300_000 })).rejects.toThrow("public scan worker drain failed");
    expect(mocks.recordPublicScanWorkerMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
    expect(log.mock.calls.flat().join(" ")).not.toContain(rawMarker);
    log.mockRestore();
  });

  it("fails the worker when its durable heartbeat cannot be persisted", async () => {
    const rawMarker = "sensitive-metrics-marker";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.processPublicScanJob.mockResolvedValue({ status: "idle" });
    mocks.recordPublicScanWorkerMetrics.mockRejectedValue(new Error(rawMarker));

    await expect(drainPublicScanJobsFromWorker({ leaseMs: 300_000 })).rejects.toThrow("public scan worker drain failed");
    expect(mocks.recordPublicScanWorkerMetrics).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join(" ")).not.toContain(rawMarker);
    log.mockRestore();
  });
});
