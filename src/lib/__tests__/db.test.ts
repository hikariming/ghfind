import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROAST_CACHE_VERSION } from "../cache-version";
import type { ScoreEntry } from "../db";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "../scan-run-types";

let db: typeof import("../db");
let tmpDir: string;

const entry: ScoreEntry = {
  username: "RockChinQ",
  display_name: "Rock",
  avatar_url: null,
  profile_url: "https://github.com/RockChinQ",
  final_score: 95.2,
  tier: "夯",
  tags: { zh: ["开源狠人"], en: ["oss beast"] },
  roast_line: { zh: "强到没法吐槽。", en: "Too good to roast." },
  bot_score: 0,
  sub_scores: {
    account_maturity: 10,
    original_project_quality: 18,
    contribution_quality: 27,
    ecosystem_impact: 20,
    community_influence: 8,
    activity_authenticity: 12.2,
  },
  scanned_at: 1_800_000_000_000,
};

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ghroast-db-"));
  process.env.TURSO_DATABASE_URL = `file:${join(tmpDir, "test.db")}`;
  delete process.env.TURSO_AUTH_TOKEN;
  db = await import("../db");
});

afterAll(() => {
  delete process.env.TURSO_DATABASE_URL;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getArchivedRoast", () => {
  it("replays archived reports by username and language", async () => {
    await db.recordScore(entry);
    await db.updateRoast("RockChinQ", "## 中文报告", "zh");
    await db.updateRoast("RockChinQ", "## English report", "en");

    await expect(db.getArchivedRoast("rockchinq", "zh")).resolves.toMatchObject({
      username: "rockchinq",
      final_score: 95.2,
      tier: "夯",
      tags: entry.tags,
      report: "## 中文报告",
    });
    await expect(db.getArchivedRoast("RockChinQ", "en")).resolves.toMatchObject({
      report: "## English report",
    });
  });

  it("does not replay archived reports from a stale roast version", async () => {
    await db.recordScore({ ...entry, username: "stale-roast" });
    await db.updateRoast("stale-roast", "## stale report", "zh");

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `UPDATE scores SET roast_version = ? WHERE username = ?`,
      args: [`${ROAST_CACHE_VERSION}-old`, "stale-roast"],
    });

    await expect(db.getArchivedRoast("stale-roast", "zh")).resolves.toBeNull();
  });

  it("does not replay archived reports from rows without cache versions", async () => {
    await db.recordScore({ ...entry, username: "legacy-roast" });
    await db.updateRoast("legacy-roast", "## legacy report", "zh");

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `UPDATE scores
            SET score_version = NULL, roast_version = NULL
            WHERE username = ?`,
      args: ["legacy-roast"],
    });

    await expect(db.getArchivedRoast("legacy-roast", "zh")).resolves.toBeNull();
  });
});

describe("score snapshots", () => {
  it("stores one generated-at stub when a completed roast is persisted", async () => {
    const username = "roast-snapshot";
    const before = Date.now();
    await db.recordScore({ ...entry, username, final_score: 90 });
    await db.updateRoast(username, "## first report", "zh");
    await db.recordScore({
      ...entry,
      username,
      final_score: 96.1,
      scanned_at: entry.scanned_at + 2 * 60 * 60 * 1000,
    });
    await db.updateRoast(username, "## second report", "en");
    const after = Date.now();

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    const res = await client.execute({
      sql: `SELECT COUNT(*) AS n,
                   MIN(generated_at) AS first_generated_at,
                   MAX(generated_at) AS last_generated_at,
                   GROUP_CONCAT(roast_lang, ',') AS langs
            FROM score_snapshots
            WHERE username = ?`,
      args: [username],
    });

    expect(Number(res.rows[0]?.n)).toBe(2);
    expect(Number(res.rows[0]?.first_generated_at)).toBeGreaterThanOrEqual(before);
    expect(Number(res.rows[0]?.last_generated_at)).toBeLessThanOrEqual(after);
    expect(String(res.rows[0]?.langs).split(",").sort()).toEqual(["en", "zh"]);
  });
});

describe("durable public scan jobs", () => {
  const versions = { scoreVersion: "test-score-v1", collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION };

  async function enqueue(username: string) {
    const result = await db.enqueuePublicScan(username, versions);
    if (!result || "rejection" in result) {
      throw new Error(`expected durable job for ${username}`);
    }
    return result;
  }

  it("dedupes active work, persists progress, and publishes only with its lease", async () => {
    const first = await enqueue("history-heavy");
    const second = await enqueue("HISTORY-HEAVY");

    expect(first?.created).toBe(true);
    expect(second).toMatchObject({ created: false, run: { id: first?.run.id }, job: { id: first?.job.id } });

    const firstLease = await db.claimPublicScanJob(first?.job.id);
    expect(firstLease).toMatchObject({ job: { phase: "quick", state: "running" } });
    expect(firstLease?.leaseToken).toBeTruthy();

    const sources = {
      quick: "complete",
      original_repos: "pending",
      native_prs: "pending",
      workflow_landings: "pending",
      commit_recovery: "pending",
    } as const;
    await expect(
      db.savePublicScanQuickResult({
        jobId: first!.job.id,
        runId: first!.run.id,
        leaseToken: firstLease!.leaseToken,
        quickScan: '{"metrics":{"username":"history-heavy"}}',
        sourceStatus: sources,
      }),
    ).resolves.toBe(true);
    await expect(
      db.savePublicScanJobProgress({
        jobId: first!.job.id,
        runId: first!.run.id,
        leaseToken: firstLease!.leaseToken,
        phase: "merged_prs",
        payload: '{"after":"cursor-1"}',
        sourceStatus: sources,
      }),
    ).resolves.toBe(true);

    const secondLease = await db.claimPublicScanJob(first!.job.id);
    expect(secondLease).toMatchObject({ job: { phase: "merged_prs" } });
    await expect(
      db.completePublicScanRun({
        jobId: first!.job.id,
        runId: first!.run.id,
        leaseToken: firstLease!.leaseToken,
        coverage: "complete_public",
        sourceStatus: { ...sources, native_prs: "complete", workflow_landings: "complete", commit_recovery: "complete", original_repos: "complete" },
        snapshot: '{"complete":true}',
        snapshotHash: "snapshot-a",
      }),
    ).resolves.toBe(false);
    const snapshot = '{"complete":true}';
    await expect(
      db.completePublicScanRun({
        jobId: first!.job.id,
        runId: first!.run.id,
        leaseToken: secondLease!.leaseToken,
        coverage: "complete_public",
        sourceStatus: sources,
        snapshot,
        snapshotHash: "snapshot-a",
      }),
    ).resolves.toBe(false);
    await expect(
      db.completePublicScanRun({
        jobId: first!.job.id,
        runId: first!.run.id,
        leaseToken: secondLease!.leaseToken,
        coverage: "complete_public",
        sourceStatus: { ...sources, native_prs: "complete", workflow_landings: "complete", commit_recovery: "complete", original_repos: "complete" },
        snapshot,
        snapshotHash: createHash("sha256").update(snapshot).digest("hex"),
      }),
    ).resolves.toBe(true);

    await expect(db.getLatestPublicScanRun("history-heavy", versions)).resolves.toMatchObject({
      id: first!.run.id,
      state: "complete_public",
      coverage: "complete_public",
      snapshotHash: createHash("sha256").update(snapshot).digest("hex"),
      sourceStatus: { native_prs: "complete", commit_recovery: "complete" },
    });
    await expect(
      db.getLatestPublicScanRun("history-heavy", {
        scoreVersion: "future-score-formula",
        collectionVersion: PUBLIC_SCAN_COLLECTION_VERSION,
      }),
    ).resolves.toMatchObject({ id: first!.run.id, state: "complete_public" });
  });

  it("reclaims an expired lease instead of starting a second active job", async () => {
    const queued = await enqueue("expired-lease");
    const lease = await db.claimPublicScanJob(queued?.job.id);
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `UPDATE public_scan_jobs SET lease_expires_at = ? WHERE id = ?`,
      args: [Date.now() - 1, queued!.job.id],
    });

    const recovered = await db.claimPublicScanJob(queued!.job.id);
    expect(recovered?.job.id).toBe(queued?.job.id);
    expect(recovered?.leaseToken).not.toBe(lease?.leaseToken);
    await expect(
      db.failPublicScanJob({
        jobId: queued!.job.id,
        runId: queued!.run.id,
        leaseToken: recovered!.leaseToken,
        error: "test complete",
      }),
    ).resolves.toBe(true);
  });

  it("admits new durable work atomically without charging an existing job", async () => {
    const admission = {
      bucket: "durable-admission-test",
      limit: 1,
      windowMs: 60_000,
      maxActiveJobs: 100,
    };
    const first = await db.enqueuePublicScan("admission-first", { ...versions, admission });
    expect(first && !("rejection" in first) && first.created).toBe(true);

    const duplicate = await db.enqueuePublicScan("admission-first", { ...versions, admission });
    expect(duplicate).toMatchObject({ created: false, run: { id: (first as { run: { id: string } }).run.id } });

    await expect(
      db.enqueuePublicScan("admission-second", { ...versions, admission }),
    ).resolves.toMatchObject({ created: false, rejection: "admission_limited" });
  });

  it("rejects new durable work when the global active-job ceiling is full", async () => {
    const first = await db.enqueuePublicScan("queue-cap-first", {
      ...versions,
      admission: { bucket: "queue-cap-first", limit: 10, windowMs: 60_000, maxActiveJobs: 1_000 },
    });
    expect(first && !("rejection" in first)).toBe(true);

    await expect(
      db.enqueuePublicScan("queue-cap-second", {
        ...versions,
        admission: { bucket: "queue-cap-second", limit: 10, windowMs: 60_000, maxActiveJobs: 1 },
      }),
    ).resolves.toMatchObject({ created: false, rejection: "queue_full" });
  });

  it("uses a Turso execution slot and rate window when Redis is unavailable", async () => {
    const one = await enqueue("slot-one");
    const two = await enqueue("slot-two");
    const leaseOne = await db.claimPublicScanJob(one!.job.id);
    const leaseTwo = await db.claimPublicScanJob(two!.job.id);

    const firstSlot = await db.acquirePublicScanExecutionLease({
      jobId: one!.job.id,
      leaseToken: leaseOne!.leaseToken,
    });
    const blockedSlot = await db.acquirePublicScanExecutionLease({
      jobId: two!.job.id,
      leaseToken: leaseTwo!.leaseToken,
    });
    expect(firstSlot).toBe(1);
    expect(blockedSlot).toBeNull();

    await db.releasePublicScanExecutionLease({
      slot: firstSlot!,
      jobId: one!.job.id,
      leaseToken: leaseOne!.leaseToken,
    });
    await expect(
      db.acquirePublicScanExecutionLease({
        jobId: two!.job.id,
        leaseToken: leaseTwo!.leaseToken,
      }),
    ).resolves.toBe(1);

    await expect(
      db.acquirePublicScanRateWindow({ bucket: "commit-search-test", limit: 2, windowMs: 60_000 }),
    ).resolves.toMatchObject({ granted: true });
    await expect(
      db.acquirePublicScanRateWindow({ bucket: "commit-search-test", limit: 2, windowMs: 60_000 }),
    ).resolves.toMatchObject({ granted: true });
    await expect(
      db.acquirePublicScanRateWindow({ bucket: "commit-search-test", limit: 2, windowMs: 60_000 }),
    ).resolves.toMatchObject({ granted: false });
  });

  it("carries commit-candidate fork metadata through verification and aggregation", async () => {
    const queued = await enqueue("fork-candidate-facts");
    const lease = await db.claimPublicScanJob(queued.job.id);
    const leaseInput = {
      jobId: queued.job.id,
      runId: queued.run.id,
      leaseToken: lease!.leaseToken,
    };
    await expect(
      db.upsertPublicScanCommitCandidates({
        ...leaseInput,
        candidates: [
          {
            sha: "candidate-sha",
            repoKey: "forked/large-project",
            ownerLogin: "forked",
            stars: 20_000,
            isPrivate: false,
            isFork: true,
            authoredAt: "2025-01-01T00:00:00Z",
          },
        ],
      }),
    ).resolves.toBe(true);
    await expect(db.preparePublicScanCommitVerificationWork(leaseInput)).resolves.toBe(true);
    const work = await db.getNextPublicScanCommitVerificationWork(queued.run.id);
    expect(work).toMatchObject({ repoKey: "forked/large-project", isFork: true });
    await expect(
      db.recordPublicScanCommitVerificationPage({
        ...leaseInput,
        work: work!,
        commits: [{ sha: "verified-sha", committedAt: "2025-01-01T00:00:00Z" }],
        complete: true,
      }),
    ).resolves.toBe(true);
    await expect(db.materializePublicScanCommitRepoFacts(leaseInput)).resolves.toBe(true);
    await expect(db.getPublicScanContributionAggregates(queued.run.id)).resolves.toEqual([
      expect.objectContaining({ repo: "forked/large-project", isFork: true, prs: 0, commits: 1 }),
    ]);
  });

  it("aggregates lease-guarded PR and commit facts without double-counting replayed pages", async () => {
    const queued = await enqueue("fact-aggregate");
    const lease = await db.claimPublicScanJob(queued!.job.id);
    const leaseInput = {
      jobId: queued!.job.id,
      runId: queued!.run.id,
      leaseToken: lease!.leaseToken,
    };
    const facts = [
      {
        pullRequestId: "pr-1",
        source: "native_merged" as const,
        repoKey: "big/project",
        ownerLogin: "big",
        stars: 500,
        isPrivate: false,
        isFork: false,
        createdAt: "2024-01-01T00:00:00Z",
        mergedAt: "2024-01-03T00:00:00Z",
        closedAt: "2024-01-03T00:00:00Z",
        title: "core fix",
        additions: 10,
        deletions: 2,
        changedFiles: 2,
        labels: [],
      },
      {
        pullRequestId: "pr-2",
        source: "native_merged" as const,
        repoKey: "big/project",
        ownerLogin: "big",
        stars: 550,
        isPrivate: false,
        isFork: false,
        createdAt: "2025-01-01T00:00:00Z",
        mergedAt: "2025-01-03T00:00:00Z",
        closedAt: "2025-01-03T00:00:00Z",
        title: "second fix",
        additions: 10,
        deletions: 2,
        changedFiles: 2,
        labels: [],
      },
    ];
    await expect(db.upsertPublicScanPrFacts({ ...leaseInput, facts })).resolves.toBe(true);
    await expect(db.upsertPublicScanPrFacts({ ...leaseInput, facts: [facts[0]] })).resolves.toBe(true);
    await expect(
      db.upsertPublicScanCommitRepoFacts({
        ...leaseInput,
        facts: [
          {
            repoKey: "big/project",
            ownerLogin: "big",
            stars: 550,
            isPrivate: false,
            isFork: false,
            commits: 8,
            activeYears: 3,
            firstCommittedAt: "2023-01-01T00:00:00Z",
            lastCommittedAt: "2025-01-01T00:00:00Z",
            source: "default_branch_rest",
            evidenceShas: ["abc"],
          },
        ],
      }),
    ).resolves.toBe(true);
    await expect(
      db.upsertPublicScanCommitRepoFacts({
        ...leaseInput,
        facts: [
          {
            repoKey: "forked/project",
            ownerLogin: "forked",
            stars: 5_000,
            isPrivate: false,
            isFork: true,
            commits: 12,
            activeYears: 2,
            firstCommittedAt: "2024-01-01T00:00:00Z",
            lastCommittedAt: "2025-01-01T00:00:00Z",
            source: "default_branch_rest",
            evidenceShas: ["def"],
          },
        ],
      }),
    ).resolves.toBe(true);
    await expect(db.getPublicScanContributionAggregates(queued!.run.id)).resolves.toEqual([
      {
        repo: "forked/project",
        ownerLogin: "forked",
        stars: 5000,
        isPrivate: false,
        isFork: true,
        commits: 12,
        prs: 0,
        activeYears: 2,
      },
      {
        repo: "big/project",
        ownerLogin: "big",
        stars: 550,
        isPrivate: false,
        isFork: false,
        commits: 8,
        prs: 2,
        activeYears: 3,
      },
    ]);
  });
});

describe("profile comments", () => {
  it("stores anonymous and GitHub comments for a profile", async () => {
    const anonymous = await db.createProfileComment({
      targetUsername: "Torvalds",
      text: "硬核 🔥",
      author: { type: "anonymous" },
    });
    const github = await db.createProfileComment({
      targetUsername: "torvalds",
      text: "Legend status",
      author: {
        type: "github",
        username: "yyx990803",
        avatarUrl: "https://avatars.githubusercontent.com/u/499550",
      },
      authorGithubId: 499550,
    });

    expect(anonymous).toMatchObject({
      targetUsername: "torvalds",
      author: { type: "anonymous" },
      text: "硬核 🔥",
    });
    expect(github).toMatchObject({
      targetUsername: "torvalds",
      author: {
        type: "github",
        username: "yyx990803",
        avatarUrl: "https://avatars.githubusercontent.com/u/499550",
      },
      text: "Legend status",
    });

    await expect(db.getProfileComments("TORVALDS")).resolves.toMatchObject([
      { author: { type: "anonymous" }, text: "硬核 🔥" },
      { author: { type: "github", username: "yyx990803" }, text: "Legend status" },
    ]);
  });
});

describe("profile reactions", () => {
  it("stores one durable reaction per GitHub user and target profile", async () => {
    await db.setProfileReaction({
      targetUsername: "React-Target",
      voterGithubId: 101,
      voterLogin: "alice",
      reaction: "like",
    });
    await db.setProfileReaction({
      targetUsername: "react-target",
      voterGithubId: 202,
      voterLogin: "bob",
      reaction: "poop",
    });

    await expect(db.getProfileReactionState("REACT-TARGET", 101)).resolves.toEqual({
      counts: { like: 1, poop: 1, kick: 0, fire: 0, salute: 0, clown: 0 },
      viewerReaction: "like",
    });
  });

  it("atomically replaces an existing reaction instead of adding another vote", async () => {
    const state = await db.setProfileReaction({
      targetUsername: "react-target",
      voterGithubId: 101,
      voterLogin: "alice-renamed",
      reaction: "fire",
    });

    expect(state).toEqual({
      counts: { like: 0, poop: 1, kick: 0, fire: 1, salute: 0, clown: 0 },
      viewerReaction: "fire",
    });
  });

  it("removes only the authenticated user's reaction", async () => {
    const state = await db.removeProfileReaction({
      targetUsername: "REACT-TARGET",
      voterGithubId: 101,
    });

    expect(state).toEqual({
      counts: { like: 0, poop: 1, kick: 0, fire: 0, salute: 0, clown: 0 },
      viewerReaction: null,
    });
  });
});

describe("getTrendingLeaderboard", () => {
  it("counts unique lookups from the last seven days only", async () => {
    const now = Date.now();
    await db.recordScore({ ...entry, username: "fresh", final_score: 92, scanned_at: now });
    await db.recordScore({ ...entry, username: "stale", final_score: 100, scanned_at: now - 1 });

    await db.recordAccountLookup("fresh", "203.0.113.1");
    await db.recordAccountLookup("fresh", "203.0.113.2");
    await db.recordAccountLookup("fresh", "203.0.113.2"); // same visitor, same 24h window
    await db.recordAccountLookup("stale", "203.0.113.3");

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `UPDATE account_lookup_limits
            SET last_counted_at = ?
            WHERE username = ?`,
      args: [now - 8 * 24 * 60 * 60 * 1000, "stale"],
    });
    await client.execute({
      sql: `UPDATE account_stats
            SET last_lookup_at = ?
            WHERE username = ?`,
      args: [now - 8 * 24 * 60 * 60 * 1000, "stale"],
    });

    const entries = await db.getTrendingLeaderboard(10);
    const fresh = entries.find((e) => e.username === "fresh");
    const stale = entries.find((e) => e.username === "stale");

    expect(fresh?.recent_lookup_count).toBe(2);
    expect(stale?.recent_lookup_count).toBe(0);
    expect(fresh?.trending_score).toBeGreaterThan(0);
    expect(entries[0]?.username).toBe("fresh");
  });
});

describe("getRank", () => {
  it("ranks by score desc over a shared population", async () => {
    await db.recordScore({ ...entry, username: "rank-low", final_score: 11 });
    await db.recordScore({ ...entry, username: "rank-mid", final_score: 22 });
    await db.recordScore({ ...entry, username: "rank-high", final_score: 33 });

    const low = await db.getRank(11);
    const mid = await db.getRank(22);
    const high = await db.getRank(33);
    expect(low && mid && high).toBeTruthy();
    // A higher score earns a smaller (better) rank number.
    expect(high!.rank).toBeLessThan(mid!.rank);
    expect(mid!.rank).toBeLessThan(low!.rank);
    // Every query measures the same population, and `below` tracks the score.
    expect(high!.total).toBe(low!.total);
    expect(high!.total).toBeGreaterThanOrEqual(3);
    expect(high!.below).toBeGreaterThan(mid!.below);
  });

  it("excludes hidden accounts from the ranking", async () => {
    const before = await db.getRank(22);
    await db.recordScore({ ...entry, username: "rank-hidden", final_score: 99 });
    await db.hideUser("rank-hidden");
    const after = await db.getRank(22);
    // A hidden high score neither inflates the total nor worsens the rank.
    expect(after!.total).toBe(before!.total);
    expect(after!.rank).toBe(before!.rank);
  });
});

describe("recordRepoGraph + updateInfluenceStats", () => {
  const raw = () => createClient({ url: process.env.TURSO_DATABASE_URL! });

  it("upserts repos and replaces a developer's edges", async () => {
    await db.recordRepoGraph("Alice", {
      repos: [
        {
          repo_key: "alice/cool",
          name_with_owner: "Alice/Cool",
          owner_login: "alice",
          name: "Cool",
          description: "a cool project",
          stars: 1200,
          forks: 30,
          language: "Rust",
          topics: ["cli"],
        },
      ],
      links: [{ repo_key: "alice/cool", relation: "owner", commits: null, prs: null, weight: 1200 }],
    });

    const client = raw();
    const repo = await client.execute({
      sql: `SELECT name_with_owner, owner_login, stars, language FROM repos WHERE repo_key = ?`,
      args: ["alice/cool"],
    });
    expect(repo.rows[0]).toMatchObject({
      name_with_owner: "Alice/Cool",
      owner_login: "alice",
      stars: 1200,
      language: "Rust",
    });
    const edge = await client.execute({
      sql: `SELECT relation, weight FROM repo_developers WHERE username = ? AND repo_key = ?`,
      args: ["alice", "alice/cool"],
    });
    expect(edge.rows[0]).toMatchObject({ relation: "owner", weight: 1200 });
  });

  it("takes the higher star count and never nulls owner metadata on a later thin scan", async () => {
    // Bob contributes to alice/cool later with sparser metadata but a higher star count.
    await db.recordRepoGraph("Bob", {
      repos: [
        {
          repo_key: "alice/cool",
          name_with_owner: "alice/cool",
          owner_login: "alice",
          name: "cool",
          description: null,
          stars: 1500,
          forks: null,
          language: null,
          topics: [],
        },
      ],
      links: [{ repo_key: "alice/cool", relation: "contributor", commits: 8, prs: 2, weight: 10 }],
    });

    const client = raw();
    const repo = await client.execute({
      sql: `SELECT stars, language, description FROM repos WHERE repo_key = ?`,
      args: ["alice/cool"],
    });
    // Star count moves up; the owner's rich language/description survive.
    expect(repo.rows[0]).toMatchObject({ stars: 1500, language: "Rust", description: "a cool project" });

    // Both developers now have an edge to the shared repo.
    const contributors = await client.execute({
      sql: `SELECT username, relation FROM repo_developers WHERE repo_key = ? ORDER BY username`,
      args: ["alice/cool"],
    });
    expect(contributors.rows.map((r) => r.username)).toEqual(["alice", "bob"]);
  });

  it("lifts followers/total_stars onto an existing scores row", async () => {
    await db.recordScore({ ...entry, username: "vip-user", final_score: 88 });
    await db.updateInfluenceStats("vip-user", 4200, 15000);

    const client = raw();
    const res = await client.execute({
      sql: `SELECT followers, total_stars FROM scores WHERE username = ?`,
      args: ["vip-user"],
    });
    expect(res.rows[0]).toMatchObject({ followers: 4200, total_stars: 15000 });
  });
});

describe("getRepoOverview + filterExistingRepoKeys", () => {
  const node = (over: Partial<import("../repo-graph").RepoNode> = {}) => ({
    repo_key: "acme/widget",
    name_with_owner: "acme/Widget",
    owner_login: "acme",
    name: "Widget",
    description: "a widget",
    stars: 3000,
    forks: 100,
    language: "Go",
    topics: ["cli"],
    ...over,
  });

  it("assembles the repo, its scored owner, and the contributor-quality summary", async () => {
    // Owner "acme" (夯) owns the repo; contributor "beta" (人上人) works on it.
    await db.recordScore({ ...entry, username: "acme", final_score: 96, tier: "夯" });
    await db.recordScore({ ...entry, username: "beta", final_score: 72, tier: "人上人" });
    await db.recordRepoGraph("acme", {
      repos: [node()],
      links: [{ repo_key: "acme/widget", relation: "owner", commits: null, prs: null, weight: 3000 }],
    });
    await db.recordRepoGraph("beta", {
      repos: [node({ language: null, description: null, topics: [] })],
      links: [
        { repo_key: "acme/widget", relation: "contributor", commits: 9, prs: 4, weight: 13 },
      ],
    });

    const overview = await db.getRepoOverview("acme/widget");
    expect(overview).not.toBeNull();
    expect(overview!.repo.name_with_owner).toBe("acme/Widget");
    // Owner resolves from the repo's owner_login → scores row.
    expect(overview!.owner).toMatchObject({ username: "acme", tier: "夯" });
    // Summary spans both edges (owner + contributor).
    expect(overview!.summary.count).toBe(2);
    expect(overview!.summary.avgScore).toBe(84); // (96 + 72) / 2
    expect(overview!.summary.tierCounts).toEqual([
      { tier: "夯", count: 1 },
      { tier: "人上人", count: 1 },
    ]);
  });

  it("returns null for a repo not in the graph", async () => {
    expect(await db.getRepoOverview("nobody/here")).toBeNull();
  });

  it("filters a key set down to repos that exist", async () => {
    const found = await db.filterExistingRepoKeys(["Acme/Widget", "ghost/missing"]);
    expect(found.has("acme/widget")).toBe(true);
    expect(found.has("ghost/missing")).toBe(false);
  });
});

describe("project discovery queries", () => {
  const repo = (
    key: string,
    over: Partial<import("../repo-graph").RepoNode> = {},
  ): import("../repo-graph").RepoNode => {
    const [owner, name] = key.split("/");
    return {
      repo_key: key,
      name_with_owner: `${owner}/${name}`,
      owner_login: owner,
      name,
      description: `${name} project`,
      stars: 100,
      forks: 5,
      language: "TypeScript",
      topics: ["developer-tools"],
      ...over,
    };
  };

  beforeAll(async () => {
    const repos = {
      quality: repo("discover/quality", { stars: 1_000, name: "QualityKit" }),
      related: repo("discover/related", { stars: 900, name: "RelatedKit" }),
      scale: repo("discover/scale", { stars: 800, name: "ScaleKit" }),
      momentum: repo("discover/momentum", { stars: 700, name: "MomentumKit" }),
      stars: repo("discover/stars", {
        stars: 50_000,
        name: "StarKit",
        language: "Rust",
        topics: ["database"],
      }),
      rustPeer: repo("discover/rust-peer", {
        stars: 600,
        name: "RustPeer",
        language: "Rust",
        topics: ["database"],
      }),
    };
    const score = async (username: string, finalScore: number, tier: ScoreEntry["tier"]) =>
      db.recordScore({ ...entry, username, final_score: finalScore, tier });

    await Promise.all([
      score("discover-alice", 96, "夯"),
      score("discover-bob", 90, "顶级"),
      score("discover-carol", 72, "人上人"),
      score("discover-dan", 72, "人上人"),
      score("discover-eve", 72, "人上人"),
      score("discover-hot", 65, "人上人"),
      score("discover-star", 80, "顶级"),
      score("discover-rust", 78, "顶级"),
      score("discover-hidden", 100, "夯"),
      score("discover-low", 50, "NPC"),
    ]);

    await db.recordRepoGraph("discover-alice", {
      repos: [repos.quality, repos.related],
      links: [
        { repo_key: repos.quality.repo_key, relation: "contributor", commits: 5, prs: 2, weight: 7 },
        { repo_key: repos.related.repo_key, relation: "contributor", commits: 3, prs: 1, weight: 4 },
      ],
    });
    await db.recordRepoGraph("discover-bob", {
      repos: [repos.quality, repos.related],
      links: [
        { repo_key: repos.quality.repo_key, relation: "contributor", commits: 4, prs: 1, weight: 5 },
        { repo_key: repos.related.repo_key, relation: "contributor", commits: 2, prs: 1, weight: 3 },
      ],
    });
    for (const username of ["discover-carol", "discover-dan", "discover-eve"]) {
      await db.recordRepoGraph(username, {
        repos: [repos.scale],
        links: [
          { repo_key: repos.scale.repo_key, relation: "contributor", commits: 1, prs: 1, weight: 2 },
        ],
      });
    }
    await db.recordRepoGraph("discover-hot", {
      repos: [repos.momentum],
      links: [
        { repo_key: repos.momentum.repo_key, relation: "contributor", commits: 1, prs: 1, weight: 2 },
      ],
    });
    await db.recordRepoGraph("discover-star", {
      repos: [repos.stars],
      links: [{ repo_key: repos.stars.repo_key, relation: "owner", commits: null, prs: null, weight: 50_000 }],
    });
    await db.recordRepoGraph("discover-rust", {
      repos: [repos.rustPeer],
      links: [
        { repo_key: repos.rustPeer.repo_key, relation: "owner", commits: null, prs: null, weight: 600 },
      ],
    });
    for (const username of ["discover-hidden", "discover-low"]) {
      await db.recordRepoGraph(username, {
        repos: [repos.quality],
        links: [
          { repo_key: repos.quality.repo_key, relation: "contributor", commits: 1, prs: 0, weight: 1 },
        ],
      });
    }
    await db.hideUser("discover-hidden");
    await db.recordAccountLookup("discover-hot", "203.0.113.10");
    await db.recordAccountLookup("discover-hot", "203.0.113.11");
    await db.recordAccountLookup("discover-hot", "203.0.113.12");
  });

  it("orders projects by contributor quality and excludes hidden or low scores", async () => {
    const projects = await db.getProjects({ sort: "quality", limit: 20 });
    const quality = projects.find((p) => p.repo.repo_key === "discover/quality");
    const scale = projects.find((p) => p.repo.repo_key === "discover/scale");

    expect(quality).toMatchObject({ contributorCount: 2, avgScore: 93, eliteCount: 2 });
    expect(quality!.qualityScore).toBeGreaterThan(scale!.qualityScore);
    expect(projects.indexOf(quality!)).toBeLessThan(projects.indexOf(scale!));
    expect(quality!.topContributors.map((c) => c.username)).toEqual([
      "discover-alice",
      "discover-bob",
    ]);
  });

  it("supports momentum, stars, language, and stable pagination", async () => {
    const momentum = await db.getProjects({ sort: "momentum", limit: 20 });
    expect(momentum[0]?.repo.repo_key).toBe("discover/momentum");
    expect(momentum[0]?.momentum).toBeGreaterThan(0);

    const stars = await db.getProjects({ sort: "stars", limit: 20 });
    expect(stars[0]?.repo.repo_key).toBe("discover/stars");

    const rust = await db.getProjects({ sort: "quality", language: "Rust", limit: 20 });
    expect(rust.map((p) => p.repo.repo_key)).toEqual([
      "discover/stars",
      "discover/rust-peer",
    ]);

    const first = await db.getProjects({ sort: "stars", limit: 1, offset: 0 });
    const second = await db.getProjects({ sort: "stars", limit: 1, offset: 1 });
    expect(first[0]?.repo.repo_key).not.toBe(second[0]?.repo.repo_key);
  });

  it("searches repositories by owner/name and bare project name", async () => {
    const byOwner = await db.searchRepos("discover/q", 4);
    expect(byOwner[0]?.repo_key).toBe("discover/quality");

    const byName = await db.searchRepos("quality", 4);
    expect(byName[0]?.name).toBe("QualityKit");
  });

  it("prefers shared contributors for related projects", async () => {
    const related = await db.getRelatedProjects("discover/quality", 4);
    expect(related[0]?.project.repo.repo_key).toBe("discover/related");
    expect(related[0]?.sharedContributorCount).toBe(2);
  });

  it("returns no related projects when contributors do not overlap (language filler lives in project-discovery)", async () => {
    const related = await db.getRelatedProjects("discover/stars", 4);
    expect(related).toEqual([]);
  });

  it("exposes a repo's language for the project-discovery filler", async () => {
    await expect(db.getRepoLanguage("discover/stars")).resolves.toBe("Rust");
    await expect(db.getRepoLanguage("discover/unknown")).resolves.toBeNull();
  });

  it("finds projects shared by two developers", async () => {
    const common = await db.getDeveloperCommonProjects("discover-alice", "discover-bob", 5);
    expect(common.map((project) => project.repo.repo_key)).toEqual([
      "discover/quality",
      "discover/related",
    ]);
  });
});
