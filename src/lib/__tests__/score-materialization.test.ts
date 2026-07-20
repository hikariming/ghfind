import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SCORE_CACHE_VERSION } from "../cache-version";
import { materializeCanonicalScore } from "../score-materialization";
import {
  PUBLIC_SCAN_COLLECTION_VERSION,
  type PublicScanSourceStatus,
} from "../scan-run-types";
import { score, spamBotScore } from "../score";
import type { RawMetrics, ScanResult } from "../types";

const SCANNED_AT = 1_800_000_000_000;

const COMPLETE_SOURCES: PublicScanSourceStatus = {
  quick: "complete",
  original_repos: "complete",
  native_prs: "complete",
  workflow_landings: "complete",
  commit_recovery: "complete",
};

function metrics(overrides: Partial<RawMetrics> = {}): RawMetrics {
  return {
    username: "synthetic-user",
    profile_url: "https://example.test/synthetic-user",
    avatar_url: "https://example.test/avatar.png",
    name: "Synthetic User",
    bio: "Synthetic fixture",
    company: null,
    account_age_years: 4,
    created_at: "2022-01-01T00:00:00.000Z",
    followers: 20,
    following: 10,
    public_repos: 4,
    fetched_repo_count: 4,
    original_repo_count: 3,
    nonempty_original_repo_count: 3,
    fork_repo_count: 1,
    empty_original_repo_count: 0,
    total_stars: 80,
    max_stars: 50,
    merged_pr_count: 8,
    total_pr_count: 10,
    issues_created: 3,
    last_year_contributions: 320,
    activity_type_count: 3,
    contribution_years_active: 3,
    days_since_last_activity: 4,
    recent_merged_pr_sample: 8,
    recent_trivial_pr_count: 1,
    external_trivial_pr_count: 0,
    max_impact_repo_stars: 1_000,
    impact_pr_count: 2,
    impact_depth_raw: 1,
    star_inflation_suspect: false,
    closed_unmerged_pr_count: 2,
    pr_rejection_rate: 0.2,
    recent_pr_sample: 10,
    top_repo_pr_target: "sample/repository",
    top_repo_pr_share: 0.25,
    templated_pr_ratio: 0.1,
    pr_flood_suspect: false,
    ...overrides,
  };
}

function scan(metricOverrides: Partial<RawMetrics> = {}): ScanResult {
  const rawMetrics = metrics(metricOverrides);
  const embedded = score(rawMetrics);
  return {
    metrics: rawMetrics,
    top_repos: [],
    recent_prs: [],
    flood_pr_titles: [],
    impact_repos: [],
    verified_impact_prs: [],
    pinned_repos: [],
    organizations: [],
    scoring: {
      ...embedded,
      final_score: 99,
      sub_scores: { ...embedded.sub_scores, account_maturity: 99 },
    },
  };
}

function input(
  value: ScanResult = scan(),
  overrides: Partial<Parameters<typeof materializeCanonicalScore>[0]> = {},
): Parameters<typeof materializeCanonicalScore>[0] {
  const snapshot = overrides.snapshot ?? JSON.stringify(value);
  return {
    snapshot,
    snapshotHash:
      overrides.snapshotHash ?? createHash("sha256").update(snapshot).digest("hex"),
    username: "synthetic-user",
    scoreVersion: SCORE_CACHE_VERSION,
    collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
    scannedAt: SCANNED_AT,
    mode: "quick",
    ...overrides,
  };
}

describe("materializeCanonicalScore", () => {
  it("reruns the deterministic scorer and returns a DB-compatible empty-report entry", () => {
    const original = scan();
    const expected = score(original.metrics);

    const first = materializeCanonicalScore(input(original));
    const second = materializeCanonicalScore(input(original));

    expect(first).toEqual(second);
    expect(first).toEqual({
      scoreEntry: {
        username: "synthetic-user",
        display_name: "Synthetic User",
        avatar_url: "https://example.test/avatar.png",
        profile_url: "https://example.test/synthetic-user",
        final_score: expected.final_score,
        tier: expected.tier,
        tags: { zh: [], en: [] },
        roast_line: { zh: "", en: "" },
        bot_score: spamBotScore(original.metrics),
        sub_scores: expected.sub_scores,
        scanned_at: SCANNED_AT,
      },
      provenance: {
        scoreVersion: SCORE_CACHE_VERSION,
        collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
        snapshotHash: input(original).snapshotHash,
        mode: "quick",
      },
      scan: { ...original, scoring: expected },
    });
    expect(first?.scoreEntry.final_score).not.toBe(original.scoring.final_score);
    expect(first?.scan.scoring.sub_scores.account_maturity).not.toBe(99);
  });

  it("matches usernames after canonical normalization", () => {
    const result = materializeCanonicalScore(
      input(scan({ username: "Synthetic-User" }), {
        username: "  @synthetic-user ",
      }),
    );

    expect(result?.scoreEntry.username).toBe("synthetic-user");
  });

  it("accepts bounded quick snapshots even when history is sampled", () => {
    const durable = scan({ merged_pr_count: 12, recent_merged_pr_sample: 8 });

    expect(materializeCanonicalScore(input(durable))).not.toBeNull();
  });

  it.each([
    { merged_pr_count: 9, recent_merged_pr_sample: 8 },
    { merged_pr_count: 301, recent_merged_pr_sample: 301 },
    { total_pr_count: 601 },
    { public_repos: 5, fetched_repo_count: 4 },
    { commit_contribution_aggregation_unavailable: true },
    { merged_pr_contribution_aggregation_incomplete: true },
  ] satisfies Partial<RawMetrics>[])(
    "materializes a bounded quick scan %#",
    (overrides) => {
      expect(materializeCanonicalScore(input(scan(overrides)))).not.toBeNull();
    },
  );

  it("accepts a durable-mode snapshot without requiring a worker source map", () => {
    const durable = scan({ merged_pr_count: 12, recent_merged_pr_sample: 8 });

    expect(materializeCanonicalScore(input(durable, { mode: "durable" }))).not.toBeNull();
    expect(
      materializeCanonicalScore(
        input(durable, {
          mode: "durable",
          sourceStatus: { ...COMPLETE_SOURCES, native_prs: "pending" },
        }),
      ),
    ).not.toBeNull();
  });

  it("accepts an explicitly partial source set in quick mode", () => {
    expect(
      materializeCanonicalScore(
        input(scan(), {
          sourceStatus: { ...COMPLETE_SOURCES, original_repos: "unavailable" },
        }),
      ),
    ).not.toBeNull();
  });

  it.each([
    { field: "scoreVersion", value: `${SCORE_CACHE_VERSION}-legacy` },
    { field: "collectionVersion", value: `${PUBLIC_SCAN_COLLECTION_VERSION}-legacy` },
  ])("rejects non-canonical $field", ({ field, value }) => {
    expect(materializeCanonicalScore(input(scan(), { [field]: value }))).toBeNull();
  });

  it("rejects an unknown runtime mode", () => {
    const candidate = input(scan());
    expect(
      materializeCanonicalScore({
        ...candidate,
        mode: "unknown" as typeof candidate.mode,
      }),
    ).toBeNull();
  });

  it("rejects invalid timestamps and snapshot hashes", () => {
    expect(materializeCanonicalScore(input(scan(), { scannedAt: 0 }))).toBeNull();
    expect(materializeCanonicalScore(input(scan(), { scannedAt: 1.5 }))).toBeNull();
    expect(materializeCanonicalScore(input(scan(), { snapshotHash: "0".repeat(64) }))).toBeNull();
    expect(materializeCanonicalScore(input(scan(), { snapshotHash: "not-a-sha256" }))).toBeNull();
  });

  it("rejects malformed JSON, damaged shapes, and mismatched usernames", () => {
    const malformed = "{";
    expect(
      materializeCanonicalScore(
        input(scan(), {
          snapshot: malformed,
          snapshotHash: createHash("sha256").update(malformed).digest("hex"),
        }),
      ),
    ).toBeNull();

    const damaged = { ...scan(), recent_prs: [{ title: "missing required fields" }] };
    const damagedSnapshot = JSON.stringify(damaged);
    expect(
      materializeCanonicalScore(
        input(scan(), {
          snapshot: damagedSnapshot,
          snapshotHash: createHash("sha256").update(damagedSnapshot).digest("hex"),
        }),
      ),
    ).toBeNull();

    const damagedNestedShape = {
      ...scan(),
      top_repos: [
        {
          name: "sample",
          stars: 1,
          forks: 0,
          open_issues: 0,
          size: 1,
          language: null,
          description: null,
          pushed_at: null,
          readme: {},
        },
      ],
    };
    const damagedNestedSnapshot = JSON.stringify(damagedNestedShape);
    expect(
      materializeCanonicalScore(
        input(scan(), {
          snapshot: damagedNestedSnapshot,
          snapshotHash: createHash("sha256").update(damagedNestedSnapshot).digest("hex"),
        }),
      ),
    ).toBeNull();

    expect(
      materializeCanonicalScore(input(scan(), { username: "different-user" })),
    ).toBeNull();
  });
});
