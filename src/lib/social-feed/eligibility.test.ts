import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { SCORE_CACHE_VERSION } from "@/lib/cache-version";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "@/lib/scan-run-types";
import { publicationFromScore, publishingCapabilities, githubIdentityFromSnapshot, xIngestPublication, type PublishingScoreRecord } from "./eligibility";
import { SocialFeedError, type FeedActor } from "./contract";

const actor: FeedActor = { user_id: "github:7", github_user_id: "7", github_login: "octocat", name: "Octocat", avatar_url: null };
function score(value: number): PublishingScoreRecord {
  return { username: "octocat", github_user_id: "7", final_score: value, hidden: 0, score_version: SCORE_CACHE_VERSION,
    score_source_collection_version: PUBLIC_SCAN_COLLECTION_VERSION, score_source_snapshot_hash: "a".repeat(64) };
}
describe("social-feed publishing eligibility", () => {
  it("requires the unrounded minimum for every publication", () => {
    expect(() => publicationFromScore("octocat", score(59.96), "7")).toThrowError("score_below_minimum");
    expect(publicationFromScore("octocat", score(60), "7").score).toBe(60);
  });
  it("rejects missing, hidden, mismatched and incomplete score artifacts", () => {
    expect(() => publicationFromScore("octocat", null, "7")).toThrowError("score_required");
    expect(() => publicationFromScore("someone", score(90), "7")).toThrowError("score_required");
    expect(() => publicationFromScore("octocat", { ...score(90), hidden: 1 }, "7")).toThrowError("score_required");
    expect(() => publicationFromScore("octocat", { ...score(90), score_version: null }, "7")).toThrowError("score_outdated");
    expect(() => publicationFromScore("octocat", { ...score(90), score_source_collection_version: null }, "7")).toThrowError("score_outdated");
    expect(() => publicationFromScore("octocat", { ...score(90), score_source_snapshot_hash: null }, "7")).toThrowError("score_outdated");
  });
  it("accepts current Go collection provenance but never legacy snapshots without account identity", () => {
    const goScore = { ...score(70), score_source_collection_version: "v5" };
    expect(publicationFromScore("octocat", goScore, "7").score).toBe(70);
    expect(() => publicationFromScore("octocat", { ...goScore, github_user_id: null }, "7")).toThrowError("score_identity_required");
    expect(publicationFromScore("octocat", { ...goScore, score_version: "v15" }, "7").score_version).toBe("v15");
    expect(publicationFromScore("octocat", { ...goScore, score_source_collection_version: "v4" }, "7").score).toBe(70);
  });
  it("distinguishes an unavailable score service from a low score", async () => {
    expect((await publishingCapabilities(actor, async () => { throw new SocialFeedError("score_unavailable", 503); })).reason).toBe("score_unavailable");
    expect((await publishingCapabilities(actor, async () => score(40))).reason).toBe("score_below_minimum");
    expect((await publishingCapabilities(null, async () => { throw new Error("must not read"); })).reason).toBe("authentication_required");
  });
  it("rejects nonfinite/corrupt scores and returns stable provenance", () => {
    expect(() => publicationFromScore("octocat", score(NaN), "7")).toThrowError("score_unavailable");
    expect(() => publicationFromScore("octocat", score(101), "7")).toThrowError("score_unavailable");
    expect(publicationFromScore("octocat", score(70), "7").score_record_id).toContain("a".repeat(64));
  });
});


describe("score ownership from immutable snapshots", () => {
  const snapshot = JSON.stringify({ metrics: { username: "octocat", github_user_id: "7" } });
  const hash = createHash("sha256").update(snapshot).digest("hex");
  it("accepts identity from a matching immutable snapshot, including legacy GitHub avatars", () => {
    expect(githubIdentityFromSnapshot(snapshot, hash, "octocat")).toBe("7");
    expect(githubIdentityFromSnapshot(snapshot, "b".repeat(64), "octocat")).toBeNull();
    expect(githubIdentityFromSnapshot(snapshot, hash, "someone")).toBeNull();
    const old = JSON.stringify({ metrics: { username: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/7" } });
    expect(githubIdentityFromSnapshot(old, createHash("sha256").update(old).digest("hex"), "octocat")).toBe("7");
  });
  it("cannot inherit a previous owner's score by reusing their GitHub handle", () => {
    expect(() => publicationFromScore("octocat", score(90), "8")).toThrowError("score_identity_mismatch");
    expect(() => publicationFromScore("octocat", { ...score(90), github_user_id: null }, "7")).toThrowError("score_identity_required");
  });
});

describe("curated X ingest provenance", () => {
  it("records a current score when present and never rejects curated authors because of score", async () => {
    expect((await xIngestPublication("octocat", "7", async () => score(70))).score_record_id).toContain("a".repeat(64));
    const unscored = [async () => null, async () => score(10), async () => ({ ...score(90), score_version: null }),
      async () => ({ ...score(90), github_user_id: null }), async () => { throw new SocialFeedError("score_unavailable", 503); }];
    for (const read of unscored) {
      expect(await xIngestPublication("OctoCat", "7", read)).toEqual({ score: 60, score_record_id: "x-curated:octocat",
        score_version: "unscored", policy_version: "social-feed-x-curated-v1" });
    }
  });
});

describe("persisted Go score compatibility", () => {
  it("silently authorizes a saved 69-point score for posts and replies without a scan", async () => {
    const snapshot = JSON.stringify({ metrics: { username: "Octocat", avatar_url: "https://avatars.githubusercontent.com/u/7?v=4" } });
    const hash = createHash("sha256").update(snapshot).digest("hex");
    const saved = { ...score(69), github_user_id: githubIdentityFromSnapshot(snapshot, hash, "octocat"),
      score_source_snapshot_hash: hash, score_version: "v12", score_source_collection_version: "v5" };
    const reads: string[] = [];
    expect(await publishingCapabilities(actor, async (login) => { reads.push(login); return saved; }))
      .toMatchObject({ can_publish: true, can_reply: true, reason: null });
    expect(reads).toEqual(["octocat"]);
    expect(publicationFromScore("octocat", saved, "7").score).toBe(69);
    expect(() => publicationFromScore("octocat", saved, "8")).toThrowError("score_identity_mismatch");
    expect((await publishingCapabilities(actor, async () => null)).reason).toBe("score_required");
    expect((await publishingCapabilities(actor, async () => ({ ...saved, final_score: 59 }))).reason).toBe("score_below_minimum");
  });
  it.each([
    "https://evil.test/u/7", "https://avatars.githubusercontent.com.evil.test/u/7",
    "http://avatars.githubusercontent.com/u/7", "https://avatars.githubusercontent.com/user/7",
    "https://avatars.githubusercontent.com/u/0", "https://user@avatars.githubusercontent.com/u/7",
  ])("rejects an untrusted legacy avatar %s", (avatar_url) => {
    const snapshot = JSON.stringify({ metrics: { username: "octocat", avatar_url } });
    expect(githubIdentityFromSnapshot(snapshot, createHash("sha256").update(snapshot).digest("hex"), "octocat")).toBeNull();
  });
  it("does not override an explicit identity with a legacy avatar", () => {
    const snapshot = JSON.stringify({ metrics: { username: "octocat", github_user_id: "8", avatar_url: "https://avatars.githubusercontent.com/u/7" } });
    expect(githubIdentityFromSnapshot(snapshot, createHash("sha256").update(snapshot).digest("hex"), "octocat")).toBe("8");
  });
});
