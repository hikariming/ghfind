import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "../types";
import type { PublicScanRun } from "../scan-run-types";

const mocks = vi.hoisted(() => ({
  enqueuePublicScan: vi.fn(),
  getLatestPublicScanRun: vi.fn(),
  seedPublicScanQuickResult: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  enqueuePublicScan: mocks.enqueuePublicScan,
  getLatestPublicScanRun: mocks.getLatestPublicScanRun,
  seedPublicScanQuickResult: mocks.seedPublicScanQuickResult,
}));

import { requiresDurablePublicScan, resolvePublicScan } from "../public-scan";

function scan(overrides: Partial<ScanResult["metrics"]> = {}): ScanResult {
  return {
    metrics: {
      username: "durable-case",
      merged_pr_count: 1,
      total_pr_count: 1,
      public_repos: 1,
      fetched_repo_count: 1,
      ...overrides,
    },
    top_repos: [],
    recent_prs: [],
    flood_pr_titles: [],
    scoring: {} as ScanResult["scoring"],
  } as ScanResult;
}

function pendingRun(): PublicScanRun {
  return {
    id: "run-id",
    username: "durable-case",
    scoreVersion: "v7",
    collectionVersion: "v1",
    state: "queued",
    coverage: "partial_public",
    sourceStatus: {},
    quickScan: null,
    snapshot: null,
    snapshotHash: null,
    startedAt: Date.now(),
    completedAt: null,
    updatedAt: Date.now(),
    lastError: null,
  };
}

describe("durable public scan admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLatestPublicScanRun.mockResolvedValue(null);
    mocks.seedPublicScanQuickResult.mockResolvedValue(true);
  });

  it("only diverts bounded-coverage cases", () => {
    expect(requiresDurablePublicScan(scan())).toBe(false);
    expect(requiresDurablePublicScan(scan({ merged_pr_count: 301 }))).toBe(true);
    expect(requiresDurablePublicScan(scan({ total_pr_count: 601 }))).toBe(true);
    expect(requiresDurablePublicScan(scan({ public_repos: 5, fetched_repo_count: 2 }))).toBe(true);
    expect(requiresDurablePublicScan(scan({ commit_contribution_aggregation_unavailable: true }))).toBe(true);
  });

  it("seeds the already-paid quick probe before queueing a new run", async () => {
    const run = pendingRun();
    mocks.enqueuePublicScan.mockResolvedValue({
      run,
      job: { id: "job-id" },
      created: true,
    });
    const quick = scan({ merged_pr_count: 301 });

    await expect(resolvePublicScan("durable-case", quick)).resolves.toMatchObject({
      status: "pending",
      run: { id: "run-id" },
    });
    expect(mocks.seedPublicScanQuickResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-id", runId: "run-id" }),
    );
  });

  it("returns only an immutable complete snapshot as complete evidence", async () => {
    const complete = scan({ merged_pr_count: 301 });
    mocks.getLatestPublicScanRun.mockResolvedValue({
      ...pendingRun(),
      state: "complete_public",
      coverage: "complete_public",
      snapshot: JSON.stringify(complete),
    });

    await expect(resolvePublicScan("durable-case")).resolves.toMatchObject({
      status: "complete",
      scan: { metrics: { username: "durable-case" } },
    });
    expect(mocks.enqueuePublicScan).not.toHaveBeenCalled();
  });
});
