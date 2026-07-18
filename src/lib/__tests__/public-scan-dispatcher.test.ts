import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processPublicScanJob: vi.fn(),
}));

vi.mock("@/lib/public-scan-worker", () => ({
  processPublicScanJob: mocks.processPublicScanJob,
}));

import { drainPublicScanJobs } from "../public-scan-dispatcher";

describe("public scan dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drains server-side work until the durable queue is idle", async () => {
    mocks.processPublicScanJob
      .mockResolvedValueOnce({ status: "continued", jobId: "job-id", phase: "merged_prs" })
      .mockResolvedValueOnce({ status: "complete", runId: "run-id" })
      .mockResolvedValueOnce({ status: "idle" });

    await expect(drainPublicScanJobs({ maxSteps: 8, maxDurationMs: 10_000 })).resolves.toEqual({
      processed: 2,
      results: [
        { status: "continued", jobId: "job-id", phase: "merged_prs" },
        { status: "complete", runId: "run-id" },
      ],
      exhaustedBudget: false,
    });
    expect(mocks.processPublicScanJob).toHaveBeenCalledTimes(3);
  });

  it("caps one invocation before it can monopolize server runtime", async () => {
    mocks.processPublicScanJob.mockResolvedValue({
      status: "continued",
      jobId: "job-id",
      phase: "merged_prs",
    });

    await expect(drainPublicScanJobs({ maxSteps: 2, maxDurationMs: 10_000 })).resolves.toMatchObject({
      processed: 2,
      exhaustedBudget: true,
    });
    expect(mocks.processPublicScanJob).toHaveBeenCalledTimes(2);
  });
});
