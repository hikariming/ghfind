import { beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "../scan-run-types";
import type { ScanResult } from "../types";

const mocks = vi.hoisted(() => ({
  PublicScanStorageError: class PublicScanStorageError extends Error {
    constructor(readonly operation: string) {
      super("public scan storage unavailable");
      this.name = "PublicScanStorageError";
    }
  },
  claimPublicScanJob: vi.fn(),
  acquirePublicScanExecutionLease: vi.fn(),
  getPublicScanRun: vi.fn(),
  savePublicScanQuickResult: vi.fn(),
  savePublicScanJobProgress: vi.fn(),
  releasePublicScanExecutionLease: vi.fn(),
  releasePublicScanJobClaim: vi.fn(),
  buildScanResult: vi.fn(),
  fetchDurablePullRequestPage: vi.fn(),
  failPublicScanJob: vi.fn(),
  upsertPublicScanPrFacts: vi.fn(),
  upsertPublicScanCommitRepoFacts: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  PublicScanStorageError: mocks.PublicScanStorageError,
  acquirePublicScanExecutionLease: mocks.acquirePublicScanExecutionLease,
  acquirePublicScanRateWindow: vi.fn(),
  claimPublicScanJob: mocks.claimPublicScanJob,
  completePublicScanRun: vi.fn(),
  failPublicScanJob: mocks.failPublicScanJob,
  getNextPublicScanCommitVerificationWork: vi.fn(),
  getPublicScanContributionAggregates: vi.fn(),
  getPublicScanOwnedRepoFacts: vi.fn(),
  getPublicScanPrSummary: vi.fn(),
  getPublicScanRun: mocks.getPublicScanRun,
  materializePublicScanCommitRepoFacts: vi.fn(),
  preparePublicScanCommitVerificationWork: vi.fn(),
  savePublicScanJobProgress: mocks.savePublicScanJobProgress,
  savePublicScanQuickResult: mocks.savePublicScanQuickResult,
  splitPublicScanCommitVerificationWork: vi.fn(),
  upsertPublicScanCommitCandidates: vi.fn(),
  upsertPublicScanCommitRepoFacts: mocks.upsertPublicScanCommitRepoFacts,
  upsertPublicScanOwnedRepoFacts: vi.fn(),
  upsertPublicScanPrFacts: mocks.upsertPublicScanPrFacts,
  recordPublicScanCommitVerificationPage: vi.fn(),
  releasePublicScanExecutionLease: mocks.releasePublicScanExecutionLease,
  releasePublicScanJobClaim: mocks.releasePublicScanJobClaim,
}));

vi.mock("@/lib/github", () => ({
  fetchDurableOwnedRepositoryPage: vi.fn(),
  fetchDurablePullRequestPage: mocks.fetchDurablePullRequestPage,
  hydrateTopRepoEvidence: vi.fn(),
  listPublicDefaultBranchCommits: vi.fn(),
  searchPublicCommitCandidates: vi.fn(),
  verifyWorkflowLandedPublicScanFacts: vi.fn(),
}));

vi.mock("@/lib/scan-core", () => ({
  applyPublicContributionAggregate: vi.fn(),
  applyPublicOriginalRepoInventory: vi.fn(),
  buildScanResult: mocks.buildScanResult,
}));

vi.mock("@/lib/redis", () => ({ setCachedScan: vi.fn() }));

import { processPublicScanJob } from "../public-scan-worker";

const quickScan = {
  metrics: { username: "worker-case" },
  top_repos: [],
  recent_prs: [],
  flood_pr_titles: [],
  scoring: {},
} as unknown as ScanResult;

describe("public scan worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimPublicScanJob.mockResolvedValue({
      leaseToken: "lease-token",
      job: {
        id: "job-id",
        runId: "run-id",
        username: "worker-case",
        phase: "quick",
        payload: "{}",
        attemptCount: 0,
        collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
      },
    });
    mocks.acquirePublicScanExecutionLease.mockResolvedValue(1);
    mocks.getPublicScanRun.mockResolvedValue({
      id: "run-id",
      sourceStatus: {},
      quickScan: null,
      collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
    });
    mocks.buildScanResult.mockResolvedValue(quickScan);
    mocks.savePublicScanQuickResult.mockResolvedValue(true);
    mocks.savePublicScanJobProgress.mockResolvedValue(true);
    mocks.failPublicScanJob.mockResolvedValue(true);
    mocks.releasePublicScanJobClaim.mockResolvedValue(true);
    mocks.fetchDurablePullRequestPage.mockResolvedValue({ facts: [], hasNextPage: false, endCursor: null });
    mocks.upsertPublicScanPrFacts.mockResolvedValue(true);
    mocks.upsertPublicScanCommitRepoFacts.mockResolvedValue(true);
  });

  it("persists the quick probe then queues the bounded next phase", async () => {
    await expect(processPublicScanJob("job-id")).resolves.toEqual({
      status: "continued",
      jobId: "job-id",
      runId: "run-id",
      phase: "original_repos",
    });
    expect(mocks.savePublicScanQuickResult).toHaveBeenCalledWith(
      expect.objectContaining({ quickScan: JSON.stringify(quickScan) }),
    );
    expect(mocks.upsertPublicScanCommitRepoFacts).toHaveBeenCalledWith(
      expect.objectContaining({ facts: [] }),
    );
    expect(mocks.savePublicScanJobProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "original_repos",
        payload: "{\"page\":1}",
        nextRunAt: undefined,
      }),
    );
    expect(mocks.releasePublicScanExecutionLease).toHaveBeenCalledWith({
      slot: 1,
      jobId: "job-id",
      leaseToken: "lease-token",
    });
    expect(mocks.claimPublicScanJob).toHaveBeenCalledWith({
      collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
      jobId: "job-id",
    });
  });

  it("uses the dedicated worker lease without changing request-side defaults", async () => {
    await expect(processPublicScanJob({ jobId: "job-id", leaseMs: 300_000 })).resolves.toMatchObject({
      status: "continued",
    });
    expect(mocks.claimPublicScanJob).toHaveBeenCalledWith({
      collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
      jobId: "job-id",
      leaseMs: 300_000,
    });
    expect(mocks.acquirePublicScanExecutionLease).toHaveBeenCalledWith({
      jobId: "job-id",
      leaseToken: "lease-token",
      leaseMs: 300_000,
    });
  });

  it("rejects a non-canonical job before acquiring quota or calling GitHub", async () => {
    mocks.claimPublicScanJob.mockResolvedValue({
      leaseToken: "lease-token",
      job: {
        id: "obsolete-job-id",
        runId: "obsolete-run-id",
        username: "synthetic-worker-case",
        phase: "quick",
        payload: "{}",
        attemptCount: 0,
        collectionVersion: "obsolete-collection",
      },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(processPublicScanJob("obsolete-job-id")).resolves.toEqual({
      status: "failed",
      jobId: "obsolete-job-id",
      runId: "obsolete-run-id",
      phase: "quick",
      retryScheduled: false,
    });
    expect(mocks.acquirePublicScanExecutionLease).not.toHaveBeenCalled();
    expect(mocks.buildScanResult).not.toHaveBeenCalled();
    expect(mocks.failPublicScanJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "obsolete-job-id",
        error: "worker_non_canonical",
        retryAt: undefined,
      }),
    );
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("synthetic-worker-case");
    consoleError.mockRestore();
  });

  it("returns a slot-busy claim to the immediately ready queue", async () => {
    mocks.acquirePublicScanExecutionLease.mockResolvedValue(null);

    await expect(processPublicScanJob("job-id")).resolves.toEqual({
      status: "slot_busy",
      jobId: "job-id",
      runId: "run-id",
      phase: "quick",
    });
    expect(mocks.releasePublicScanJobClaim).toHaveBeenCalledWith({
      jobId: "job-id",
      runId: "run-id",
      leaseToken: "lease-token",
    });
    expect(mocks.getPublicScanRun).not.toHaveBeenCalled();
    expect(mocks.savePublicScanJobProgress).not.toHaveBeenCalled();
    expect(mocks.buildScanResult).not.toHaveBeenCalled();
  });

  it("surfaces durable storage failures instead of reporting an idle queue", async () => {
    mocks.claimPublicScanJob.mockRejectedValue(
      new mocks.PublicScanStorageError("claim_job"),
    );

    await expect(processPublicScanJob("job-id")).rejects.toMatchObject({
      name: "PublicScanStorageError",
      operation: "claim_job",
    });
    expect(mocks.acquirePublicScanExecutionLease).not.toHaveBeenCalled();
    expect(mocks.failPublicScanJob).not.toHaveBeenCalled();
    expect(mocks.buildScanResult).not.toHaveBeenCalled();
  });

  it("allows only one synthetic concurrent job to reach GitHub work", async () => {
    mocks.claimPublicScanJob.mockImplementation(async ({ jobId }: { jobId?: string }) => ({
      leaseToken: `lease-${jobId}`,
      job: {
        id: jobId,
        runId: `run-${jobId}`,
        username: `synthetic-${jobId}`,
        phase: "quick",
        payload: "{}",
        attemptCount: 0,
        collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
      },
    }));
    mocks.acquirePublicScanExecutionLease
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(null);

    const results = await Promise.all([
      processPublicScanJob("job-a"),
      processPublicScanJob("job-b"),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["continued", "slot_busy"]);
    expect(mocks.buildScanResult).toHaveBeenCalledOnce();
    expect(mocks.releasePublicScanJobClaim).toHaveBeenCalledOnce();
    expect(mocks.releasePublicScanJobClaim).toHaveBeenCalledWith({
      jobId: "job-b",
      runId: "run-job-b",
      leaseToken: "lease-job-b",
    });
  });

  it("persists successful contribution-graph commits before collecting complete PR history", async () => {
    mocks.buildScanResult.mockResolvedValue({
      ...quickScan,
      impact_repos: [{ repo: "public/project", stars: 40_000, commits: 7, prs: 0 }],
    });

    await expect(processPublicScanJob("job-id")).resolves.toMatchObject({
      status: "continued",
      phase: "original_repos",
    });

    expect(mocks.upsertPublicScanCommitRepoFacts).toHaveBeenCalledWith(
      expect.objectContaining({
        facts: [
          expect.objectContaining({
            repoKey: "public/project",
            commits: 7,
            source: "contribution_graph",
          }),
        ],
      }),
    );
  });

  it("does not consume commit-search quota when the normal graph aggregate is available", async () => {
    mocks.claimPublicScanJob.mockResolvedValue({
      leaseToken: "lease-token",
      job: {
        id: "job-id",
        runId: "run-id",
        username: "worker-case",
        phase: "workflow_landings",
        payload: "{}",
        attemptCount: 0,
        collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
      },
    });
    mocks.getPublicScanRun.mockResolvedValue({
      id: "run-id",
      sourceStatus: {
        quick: "complete",
        original_repos: "complete",
        native_prs: "complete",
        workflow_landings: "pending",
        commit_recovery: "pending",
      },
      quickScan: JSON.stringify({
        ...quickScan,
        metrics: { username: "worker-case", commit_contribution_aggregation_unavailable: false },
      }),
      collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
    });

    await expect(processPublicScanJob("job-id")).resolves.toEqual({
      status: "continued",
      jobId: "job-id",
      runId: "run-id",
      phase: "publish",
    });
    expect(mocks.savePublicScanJobProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "publish",
        sourceStatus: expect.objectContaining({
          workflow_landings: "complete",
          commit_recovery: "complete",
        }),
      }),
    );
  });
});
