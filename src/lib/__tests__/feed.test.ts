import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectAnalysisArtifact } from "../project-analysis-contract";
import { validProjectAnalysis } from "./project-analysis-contract.test";

let feed: typeof import("../feed");
let tmpDir: string;

const viewer = { githubId: 123_456, login: "feed-tester", image: null };

function assessment(
  number: number,
  options: Partial<ProjectAnalysisArtifact> & {
    project?: Partial<ProjectAnalysisArtifact["project"]>;
  } = {},
): ProjectAnalysisArtifact {
  const source = validProjectAnalysis as ProjectAnalysisArtifact;
  const repoKey = `owner/tool-${number}`;
  return {
    ...source,
    ...options,
    analysis_id: `feed-analysis-${number}`,
    repository: {
      ...source.repository,
      repo_key: repoKey,
      canonical_url: `https://github.com/${repoKey}`,
      resolved_commit_sha: String(number).repeat(40).slice(0, 40),
    },
    project: {
      ...source.project,
      ...options.project,
      name: `tool-${number}`,
      project_type: options.project?.project_type ?? (number === 2 ? "sdk_library" : "micro_tool"),
      lifecycle: options.project?.lifecycle ?? "active_evolution",
    },
    analyzed_at: `2026-09-0${number}T00:00:00.000Z`,
  } as ProjectAnalysisArtifact;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ghfind-feed-"));
  process.env.TURSO_DATABASE_URL = `file:${join(tmpDir, "feed.db")}`;
  process.env.AUTH_SECRET = "feed-test-signing-secret";
  process.env.FEED_MODE = "baseline";
  feed = await import("../feed");
  feed.resetFeedDbForTests();
});

afterAll(() => {
  feed.resetFeedDbForTests();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.AUTH_SECRET;
  delete process.env.FEED_MODE;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Cloudflare Feed baseline", () => {
  it("keeps unreviewed assessment tags out of recall until a governed review accepts them", async () => {
    const first = assessment(1);
    await feed.syncFeedProjectProjection(first);
    const initial = await feed.listFeedTags();
    expect(initial.tags.some((tag) => tag.id === "use_case:one-command-conversion")).toBe(false);

    const result = await feed.reviewFeedTagProposal({
      proposalId: "owner/tool-1:feed-analysis-1:use_case:one-command-conversion",
      action: "create",
      reviewer: "test-admin",
      reason: "Evidence is specific and reusable.",
    });
    expect(result).toMatchObject({ status: "accepted", canonicalTagId: "use_case:one-command-conversion" });
    const reviewed = await feed.listFeedTags();
    expect(reviewed.tags.some((tag) => tag.id === "use_case:one-command-conversion")).toBe(true);
  });

  it("serves deterministic signed pages, records state safely, and rejects cross-user feedback", async () => {
    await feed.syncFeedProjectProjection(assessment(2));
    await feed.syncFeedProjectProjection(assessment(3));
    await feed.replaceFeedPreferences(viewer, {
      taxonomyVersion: 1,
      preferences: [{ tagId: "artifact:micro-tool", value: 1 }],
    });

    const first = await feed.getFeedPage(viewer, { limit: 2 });
    expect(first.algorithmVersion).toBe("cloudflare-tag-quality-v1");
    expect(first.items).toHaveLength(2);
    expect(first.items[0]?.project.tags.every((tag) => tag.id !== "use_case:one-command-conversion" || tag.id === "use_case:one-command-conversion")).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await feed.getFeedPage(viewer, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.project.repoKey)).not.toContain(first.items[0]?.project.repoKey);

    await expect(feed.appendFeedEvents(
      { githubId: 999, login: "other-user", image: null },
      [{
        id: "018f7c87-28a1-7f70-9a25-f1d8c05d5a11",
        type: "impression",
        repoKey: first.items[0]!.project.repoKey,
        occurredAt: new Date().toISOString(),
        impressionToken: first.items[0]!.impressionToken,
      }],
    )).rejects.toMatchObject({ code: "invalid_impression_token" });

    const saved = await feed.updateFeedProjectState(viewer, first.items[0]!.project.repoKey, {
      saved: true,
      impressionToken: first.items[0]!.impressionToken,
    });
    expect(saved).toMatchObject({ saved: true, notInterested: false });
    await expect(feed.updateFeedProjectState(viewer, first.items[0]!.project.repoKey, {
      saved: true,
      impressionToken: first.items[0]!.impressionToken,
    })).resolves.toEqual(saved);

    const blocked = await feed.updateFeedProjectState(viewer, first.items[1]!.project.repoKey, {
      notInterested: true,
      impressionToken: first.items[1]!.impressionToken,
    });
    expect(blocked).toMatchObject({ saved: false, notInterested: true });
    const afterBlock = await feed.getFeedPage(viewer, { limit: 20 });
    expect(afterBlock.items.map((item) => item.project.repoKey)).not.toContain(first.items[1]!.project.repoKey);
  });

  it("never publishes metadata-only or hard-risk assessments", async () => {
    const metadataOnly = assessment(4, { verification_level: "metadata_only" });
    const critical = assessment(5, {
      risks: [{ severity: "critical", category: "security", summary: "Unresolved execution issue.", evidence_ids: ["readme-contract"] }],
    });
    await feed.syncFeedProjectProjection(metadataOnly);
    await feed.syncFeedProjectProjection(critical);
    const page = await feed.getFeedPage({ githubId: 654_321, login: "new-user", image: null }, { limit: 20 });
    const keys = page.items.map((item) => item.project.repoKey);
    expect(keys).not.toContain("owner/tool-4");
    expect(keys).not.toContain("owner/tool-5");
  });

  it("deletes Feed-only facts even when serving is disabled", async () => {
    process.env.FEED_MODE = "off";
    await expect(feed.getFeedPage(viewer, { limit: 1 })).rejects.toMatchObject({ code: "feed_disabled" });
    await expect(feed.deleteFeedProfile(viewer)).resolves.toMatchObject({ status: "completed" });
    process.env.FEED_MODE = "baseline";
    await expect(feed.getFeedPreferences(viewer)).resolves.toMatchObject({ preferences: [] });
  });
});
