import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanResult } from "../types";
import { PUBLIC_SCAN_COLLECTION_VERSION, type PublicScanRun } from "../scan-run-types";

const mocks = vi.hoisted(() => ({
  enqueuePublicScan: vi.fn(),
  getCompletePublicScanRuns: vi.fn(),
  getLatestPublicScanRun: vi.fn(),
  seedPublicScanQuickResult: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  enqueuePublicScan: mocks.enqueuePublicScan,
  getCompletePublicScanRuns: mocks.getCompletePublicScanRuns,
  getLatestPublicScanRun: mocks.getLatestPublicScanRun,
  seedPublicScanQuickResult: mocks.seedPublicScanQuickResult,
}));

import {
  getPublicScanStatus,
  publicScanAdmission,
  requiresDurablePublicScan,
  resolvePublicScanFromTrustedQuickScan,
  startPublicScan,
} from "../public-scan";

function scan(overrides: Partial<ScanResult["metrics"]> = {}): ScanResult {
  return {
    metrics: {
      username: "durable-case",
      account_age_years: 1,
      followers: 0,
      following: 0,
      public_repos: 1,
      merged_pr_count: 1,
      total_pr_count: 1,
      fetched_repo_count: 1,
      original_repo_count: 1,
      nonempty_original_repo_count: 1,
      fork_repo_count: 0,
      empty_original_repo_count: 0,
      total_stars: 0,
      max_stars: 0,
      issues_created: 0,
      last_year_contributions: 0,
      activity_type_count: 0,
      contribution_years_active: 1,
      recent_merged_pr_sample: 1,
      recent_trivial_pr_count: 0,
      external_trivial_pr_count: 0,
      max_impact_repo_stars: 0,
      impact_pr_count: 0,
      impact_depth_raw: 0,
      closed_unmerged_pr_count: 0,
      pr_rejection_rate: 0,
      recent_pr_sample: 1,
      top_repo_pr_share: 0,
      templated_pr_ratio: 0,
      ...overrides,
    },
    top_repos: [],
    recent_prs: [],
    flood_pr_titles: [],
    scoring: {
      final_score: 61,
      base_score: 61,
      total_penalty: 0,
      tier: "NPC",
      tier_label: "fixture",
      sub_scores: {
        account_maturity: 0,
        original_project_quality: 0,
        contribution_quality: 0,
        ecosystem_impact: 0,
        community_influence: 0,
        activity_authenticity: 0,
      },
      red_flags: [],
    },
  } as ScanResult;
}

function pendingRun(): PublicScanRun {
  return {
    id: "run-id",
    username: "durable-case",
    scoreVersion: "v7",
    collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
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

function completedSources() {
  return {
    quick: "complete",
    original_repos: "complete",
    native_prs: "complete",
    workflow_landings: "complete",
    commit_recovery: "complete",
  } as const;
}

function completeRun(collectionVersion = "v3", overrides: Partial<PublicScanRun> = {}): PublicScanRun {
  const snapshot = JSON.stringify(scan({ merged_pr_count: 301 }));
  return {
    ...pendingRun(),
    collectionVersion,
    state: "complete_public",
    coverage: "complete_public",
    sourceStatus: completedSources(),
    snapshot,
    snapshotHash: createHash("sha256").update(snapshot).digest("hex"),
    completedAt: Date.now(),
    ...overrides,
  };
}

describe("durable public scan admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLatestPublicScanRun.mockResolvedValue(null);
    mocks.getCompletePublicScanRuns.mockResolvedValue([]);
    mocks.seedPublicScanQuickResult.mockResolvedValue(true);
  });

  it("namespaces admission buckets by the canonical collection version", () => {
    const admission = publicScanAdmission("synthetic-principal");
    expect(admission.bucket).toMatch(
      new RegExp(`^durable-admission:${PUBLIC_SCAN_COLLECTION_VERSION}:[a-f0-9]{64}$`),
    );
    expect(admission.bucket).not.toContain("synthetic-principal");
  });

  it("only diverts bounded-coverage cases", () => {
    expect(requiresDurablePublicScan(scan())).toBe(false);
    expect(requiresDurablePublicScan(scan({ merged_pr_count: 51, recent_merged_pr_sample: 50 }))).toBe(true);
    expect(requiresDurablePublicScan(scan({ merged_pr_count: 301 }))).toBe(true);
    expect(requiresDurablePublicScan(scan({ total_pr_count: 601 }))).toBe(true);
    expect(requiresDurablePublicScan(scan({ public_repos: 5, fetched_repo_count: 2 }))).toBe(true);
    expect(requiresDurablePublicScan(scan({ commit_contribution_aggregation_unavailable: true }))).toBe(true);
    expect(requiresDurablePublicScan(scan({ merged_pr_contribution_aggregation_incomplete: true }))).toBe(true);
  });

  it("seeds the already-paid quick probe before queueing a new run", async () => {
    const run = pendingRun();
    mocks.enqueuePublicScan.mockResolvedValue({
      run,
      job: { id: "job-id" },
      created: true,
    });
    const quick = scan({ merged_pr_count: 301 });

    await expect(resolvePublicScanFromTrustedQuickScan("durable-case", quick)).resolves.toMatchObject({
      status: "pending",
      run: { id: "run-id" },
      headStartJobId: "job-id",
    });
    expect(mocks.seedPublicScanQuickResult).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-id", runId: "run-id" }),
    );
  });

  it("returns only an immutable complete snapshot as complete evidence", async () => {
    const complete = scan({ merged_pr_count: 301 });
    const snapshot = JSON.stringify(complete);
    mocks.getLatestPublicScanRun.mockResolvedValue({
      ...pendingRun(),
      state: "complete_public",
      coverage: "complete_public",
      sourceStatus: completedSources(),
      snapshot,
      snapshotHash: createHash("sha256").update(snapshot).digest("hex"),
    });

    await expect(startPublicScan("durable-case")).resolves.toMatchObject({
      status: "complete",
      scan: { metrics: { username: "durable-case" } },
    });
    expect(mocks.enqueuePublicScan).not.toHaveBeenCalled();
  });

  it("serves only a validated v3 snapshot while a v4 refresh is pending", async () => {
    const refresh = pendingRun();
    const legacy = completeRun();
    mocks.getLatestPublicScanRun.mockResolvedValue(refresh);
    mocks.getCompletePublicScanRuns.mockImplementation(
      async (_username: string, collectionVersion: string) =>
        collectionVersion === "v3" ? [legacy] : [],
    );

    await expect(getPublicScanStatus("durable-case")).resolves.toMatchObject({
      status: "stale",
      run: { collectionVersion: "v3" },
      refreshRun: { id: "run-id", collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION },
      refreshPending: true,
      servedCollectionVersion: "v3",
      targetCollectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
    });
    expect(mocks.enqueuePublicScan).not.toHaveBeenCalled();
    expect(mocks.getCompletePublicScanRuns).toHaveBeenCalledWith("durable-case", "v3");
  });

  it("rejects corrupt and non-v3 complete rows as stale fallbacks", async () => {
    const corrupt = completeRun("v3", { snapshotHash: "not-a-hash" });
    const incompleteScoreSnapshot = JSON.stringify({
      ...scan(),
      scoring: { ...scan().scoring, sub_scores: {} },
    });
    const incompleteScore = completeRun("v3", {
      snapshot: incompleteScoreSnapshot,
      snapshotHash: createHash("sha256").update(incompleteScoreSnapshot).digest("hex"),
    });
    const nonCanonical = completeRun("v5");
    mocks.getCompletePublicScanRuns.mockImplementation(
      async (_username: string, collectionVersion: string) =>
        collectionVersion === "v3" ? [corrupt, incompleteScore, nonCanonical] : [],
    );

    await expect(getPublicScanStatus("durable-case")).resolves.toBeNull();
    expect(mocks.getCompletePublicScanRuns).not.toHaveBeenCalledWith("durable-case", "v5");
    expect(mocks.enqueuePublicScan).not.toHaveBeenCalled();
  });

  it("recollects legacy or corrupt complete snapshots instead of trusting them", async () => {
    const complete = scan({ merged_pr_count: 301 });
    const stale = {
      ...pendingRun(),
      state: "complete_public" as const,
      coverage: "complete_public" as const,
      sourceStatus: { ...completedSources(), native_prs: "pending" },
      snapshot: JSON.stringify(complete),
      snapshotHash: "wrong-hash",
    };
    mocks.getLatestPublicScanRun.mockResolvedValue(stale);
    mocks.enqueuePublicScan.mockResolvedValue({
      run: pendingRun(),
      job: { id: "repair-job" },
      created: true,
    });

    await expect(
      resolvePublicScanFromTrustedQuickScan("durable-case", scan({ merged_pr_count: 301 })),
    ).resolves.toMatchObject({
      status: "pending",
      run: { id: "run-id" },
    });
    expect(mocks.enqueuePublicScan).toHaveBeenCalledTimes(1);
  });

  it("recollects a complete-looking snapshot missing required score facts", async () => {
    const snapshot = JSON.stringify({
      metrics: { username: "durable-case" },
      top_repos: [],
      recent_prs: [],
      flood_pr_titles: [],
      scoring: {},
    });
    mocks.getLatestPublicScanRun.mockResolvedValue({
      ...pendingRun(),
      state: "complete_public",
      coverage: "complete_public",
      sourceStatus: completedSources(),
      snapshot,
      snapshotHash: createHash("sha256").update(snapshot).digest("hex"),
    });
    mocks.enqueuePublicScan.mockResolvedValue({
      run: pendingRun(),
      job: { id: "repair-job" },
      created: true,
    });

    await expect(startPublicScan("durable-case")).resolves.toMatchObject({ status: "pending" });
    expect(mocks.enqueuePublicScan).toHaveBeenCalledTimes(1);
  });

  it("does not seed a durable run when a route only has untrusted request data", async () => {
    mocks.enqueuePublicScan.mockResolvedValue({
      run: pendingRun(),
      job: { id: "job-id" },
      created: true,
    });

    await expect(startPublicScan("durable-case")).resolves.toMatchObject({ status: "pending" });
    expect(mocks.seedPublicScanQuickResult).not.toHaveBeenCalled();
  });

  it("marks an existing durable job as passive so status readers cannot advance it", async () => {
    const run = pendingRun();
    mocks.enqueuePublicScan.mockResolvedValue({
      run,
      job: { id: "job-id" },
      created: false,
    });

    await expect(startPublicScan("durable-case")).resolves.toMatchObject({
      status: "pending",
      headStartJobId: null,
    });
  });
});
