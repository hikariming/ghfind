import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processPublicScanJob: vi.fn(),
  recordPublicScanCronMetrics: vi.fn(),
  recordPublicScanStepMetrics: vi.fn(),
}));

vi.mock("@/lib/public-scan-worker", () => ({
  processPublicScanJob: mocks.processPublicScanJob,
}));

vi.mock("@/lib/db", () => ({
  recordPublicScanCronMetrics: mocks.recordPublicScanCronMetrics,
  recordPublicScanStepMetrics: mocks.recordPublicScanStepMetrics,
}));

import {
  drainPublicScanJobs,
  drainPublicScanJobsFromCron,
} from "../public-scan-dispatcher";

describe("public scan dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordPublicScanCronMetrics.mockResolvedValue(true);
    mocks.recordPublicScanStepMetrics.mockResolvedValue(true);
  });

  it("drains canonical Cron work until the durable queue is idle", async () => {
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
        source: "cron",
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

  it("caps one Cron invocation before it can monopolize server runtime", async () => {
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
        source: "cron",
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
        source: "cron",
      }),
    ).resolves.toMatchObject({ processed: 0, exhaustedBudget: false });
    expect(mocks.processPublicScanJob).toHaveBeenCalledOnce();
    expect(mocks.recordPublicScanStepMetrics).toHaveBeenCalledWith({
      collectionVersion: "v4",
      observations: [expect.objectContaining({ phase: "quick", outcome: "slot_busy" })],
    });
    log.mockRestore();
  });

  it("records a successful Cron heartbeat even when the queue is empty", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.processPublicScanJob.mockResolvedValue({ status: "idle" });

    await expect(drainPublicScanJobsFromCron()).resolves.toMatchObject({ processed: 0 });
    expect(mocks.recordPublicScanCronMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ processed: 0, failedSteps: 0, success: true }),
    );
    log.mockRestore();
  });

  it("records a failed Cron heartbeat without logging the raw exception", async () => {
    const rawMarker = "sensitive-upstream-marker";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.processPublicScanJob.mockRejectedValue(new Error(rawMarker));

    await expect(drainPublicScanJobsFromCron()).rejects.toThrow("public scan Cron drain failed");
    expect(mocks.recordPublicScanCronMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
    expect(log.mock.calls.flat().join(" ")).not.toContain(rawMarker);
    log.mockRestore();
  });

  it("fails Cron when its durable heartbeat cannot be persisted", async () => {
    const rawMarker = "sensitive-metrics-marker";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.processPublicScanJob.mockResolvedValue({ status: "idle" });
    mocks.recordPublicScanCronMetrics.mockRejectedValue(new Error(rawMarker));

    await expect(drainPublicScanJobsFromCron()).rejects.toThrow("public scan Cron drain failed");
    expect(mocks.recordPublicScanCronMetrics).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join(" ")).not.toContain(rawMarker);
    log.mockRestore();
  });
});
