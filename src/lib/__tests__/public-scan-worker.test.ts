import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "../types";

const mocks = vi.hoisted(() => ({
  claimPublicScanJob: vi.fn(),
  acquirePublicScanExecutionLease: vi.fn(),
  getPublicScanRun: vi.fn(),
  savePublicScanQuickResult: vi.fn(),
  savePublicScanJobProgress: vi.fn(),
  releasePublicScanExecutionLease: vi.fn(),
  buildScanResult: vi.fn(),
  fetchDurablePullRequestPage: vi.fn(),
  upsertPublicScanPrFacts: vi.fn(),
  upsertPublicScanCommitRepoFacts: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  acquirePublicScanExecutionLease: mocks.acquirePublicScanExecutionLease,
  acquirePublicScanRateWindow: vi.fn(),
  claimPublicScanJob: mocks.claimPublicScanJob,
  completePublicScanRun: vi.fn(),
  failPublicScanJob: vi.fn(),
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
      },
    });
    mocks.acquirePublicScanExecutionLease.mockResolvedValue(1);
    mocks.getPublicScanRun.mockResolvedValue({
      id: "run-id",
      sourceStatus: {},
      quickScan: null,
    });
    mocks.buildScanResult.mockResolvedValue(quickScan);
    mocks.savePublicScanQuickResult.mockResolvedValue(true);
    mocks.savePublicScanJobProgress.mockResolvedValue(true);
    mocks.fetchDurablePullRequestPage.mockResolvedValue({ facts: [], hasNextPage: false, endCursor: null });
    mocks.upsertPublicScanPrFacts.mockResolvedValue(true);
    mocks.upsertPublicScanCommitRepoFacts.mockResolvedValue(true);
  });

  it("persists the quick probe then queues the bounded next phase", async () => {
    await expect(processPublicScanJob("job-id")).resolves.toEqual({
      status: "continued",
      jobId: "job-id",
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
    });

    await expect(processPublicScanJob("job-id")).resolves.toEqual({
      status: "continued",
      jobId: "job-id",
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
