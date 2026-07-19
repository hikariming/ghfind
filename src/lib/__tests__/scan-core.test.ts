import { describe, expect, it } from "vitest";
import { buildPublicSignatureWork, buildRecentSignatureWork } from "../scan-core";
import type { PublicScanPrFact } from "../scan-run-types";
import type { ScanResult } from "../types";

const fact = (over: Partial<PublicScanPrFact>): PublicScanPrFact => ({
  pullRequestId: over.pullRequestId ?? crypto.randomUUID(),
  source: "native_merged",
  repoKey: "org/control-plane",
  ownerLogin: "org",
  stars: 39,
  isPrivate: false,
  isFork: false,
  createdAt: "2026-01-01T00:00:00Z",
  mergedAt: "2026-01-01T00:00:00Z",
  closedAt: null,
  title: null,
  additions: 100,
  deletions: 20,
  changedFiles: 4,
  labels: [],
  ...over,
});

describe("buildPublicSignatureWork", () => {
  it("surfaces all-history low-star clusters with substantive fix titles", () => {
    const signature = buildPublicSignatureWork(
      [{ repo: "org/main-platform", stars: 100_000, prs: 1, commits: 0 }],
      [
        fact({ pullRequestId: "1", title: "fix(api): revoke bound deployment capabilities" }),
        fact({ pullRequestId: "2", title: "fix(cost): atomically persist usage ledger" }),
        fact({ pullRequestId: "3", title: "feat(api): persist bound capability run provenance" }),
      ],
    );

    expect(signature.source).toBe("all_history_public_scan");
    expect(signature.work_clusters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repo: "org/control-plane",
          stars: 39,
          all_time_prs: 3,
          quality_keyword_hits: 3,
          org_context_repo: "org/main-platform",
          org_context_stars: 100_000,
          substantive_low_star_signal: true,
        }),
      ]),
    );
  });

  it("keeps high-volume all-history clusters even without many keyword hits", () => {
    const facts = Array.from({ length: 14 }, (_, i) =>
      fact({
        pullRequestId: `bulk-${i}`,
        repoKey: "foundation/runtime-tools",
        ownerLogin: "foundation",
        stars: 12_000,
        title: `adjust runtime fixture ${i}`,
      }),
    );
    const signature = buildPublicSignatureWork([], facts);

    expect(signature.work_clusters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repo: "foundation/runtime-tools",
          all_time_prs: 14,
        }),
      ]),
    );
  });
});

describe("buildRecentSignatureWork", () => {
  it("does not label docs/site/example clusters as substantive low-star fixes", () => {
    const signature = buildRecentSignatureWork({
      impact_repos: [],
      recent_prs: [
        {
          repo: "foundation/project-site",
          repo_stars: 27,
          title: "Feat:[Site]: add scala/kotlin code example in main page",
          churn: 120,
          changed_files: 4,
          trivial: false,
        },
        {
          repo: "foundation/project-site",
          repo_stars: 27,
          title: "Fix：CSS media queries solve mobile adaptation issues",
          churn: 90,
          changed_files: 3,
          trivial: false,
        },
        {
          repo: "foundation/project-site",
          repo_stars: 27,
          title: "Fix: HomePageLanguageCard Route redirection bug",
          churn: 80,
          changed_files: 2,
          trivial: false,
        },
      ],
    } as unknown as ScanResult);

    expect(signature.source).toBe("recent_sample");
    expect(signature.work_clusters).toEqual([
      expect.objectContaining({
        repo: "foundation/project-site",
        quality_keyword_hits: 0,
        substantive_low_star_signal: false,
      }),
    ]);
  });

  it("prioritizes informative fix titles over placeholder titles in examples", () => {
    const signature = buildRecentSignatureWork({
      impact_repos: [],
      recent_prs: [
        {
          repo: "team/app",
          repo_stars: 2,
          title: "Experimental",
          churn: 120,
          changed_files: 4,
          trivial: false,
        },
        {
          repo: "team/app",
          repo_stars: 2,
          title: "Experimental",
          churn: 90,
          changed_files: 3,
          trivial: false,
        },
        {
          repo: "team/app",
          repo_stars: 2,
          title: "fix: citations prompt",
          churn: 80,
          changed_files: 2,
          trivial: false,
        },
      ],
    } as unknown as ScanResult);

    expect(signature.work_clusters[0].examples).toEqual([
      "fix: citations prompt",
      "Experimental",
    ]);
  });
});
