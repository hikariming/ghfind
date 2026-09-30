import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/scan/route";
import { GET as status } from "@/app/api/scan/status/[username]/route";
import { GET as score } from "@/app/api/score/[username]/route";
import type { Developer } from "@/lib/devscore/model";
import * as db from "../db";
import { SCORE_CACHE_VERSION } from "../cache-version";
import * as jobs from "../devscore-jobs";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "../scan-run-types";
import { score as scoreMetrics } from "../score";
import { fixtureDeveloper, fixtureDisplayScan } from "./devscore-fixture";

/**
 * Background devscore scoring end to end against a real (file) libSQL
 * database, with a fake collector: job storage invariants, the runner, and
 * POST /api/scan → 202 → status polls → published score → GET /api/score.
 */

interface FakeState {
  v: 1;
  login: string;
  runId: string;
  startedAt: number;
  phase: string;
  progress: number;
  waitUntil: number | null;
  steps: number;
  calls: Record<string, number>;
}

const fake = vi.hoisted(() => ({
  stepsToFinish: 3,
  failWith: null as Error | null,
  developer: null as unknown,
  stepCalls: 0,
}));

vi.mock("@/lib/devscore/collect", () => ({
  startCollect: (login: string): FakeState => ({
    v: 1, login, runId: "run", startedAt: 0, phase: "user", progress: 0, waitUntil: null, steps: 0,
    calls: { rest: 0, graphql: 0, eco: 0, ch: 0, cacheHits: 0 },
  }),
  // One collector step per call: each poll persists exactly one step.
  stepCollect: async (state: FakeState) => {
    fake.stepCalls += 1;
    if (fake.failWith) throw fake.failWith;
    const steps = state.steps + 1;
    if (steps >= fake.stepsToFinish) return { done: true, developer: fake.developer };
    return {
      done: false,
      state: { ...state, steps, phase: ["user", "contribs", "merged_prs"][steps] ?? "assemble", progress: steps / 17, waitUntil: Date.now() + 60_000 },
    };
  },
}));
vi.mock("@/lib/scan-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scan-core")>()),
  buildDisplayScan: vi.fn(async (username: string) => fixtureDisplayScan(username)),
}));
vi.mock("@/lib/redis", () => ({
  checkRateLimit: vi.fn(async () => ({ success: true })),
  checkScanNetworkRateLimit: vi.fn(async () => ({ success: true })),
  rateLimitHeaders: vi.fn(() => ({})),
  getCachedScan: vi.fn(async () => null),
  setCachedScan: vi.fn(async () => undefined),
  getCachedScoreDetail: (_handle: string, load: () => unknown) => load(),
  tryAcquireLookupGate: vi.fn(async () => true),
  releaseLookupGate: vi.fn(async () => undefined),
}));
vi.mock("@/lib/rank", () => ({
  getPercentileCached: vi.fn(async () => null),
  getRankCached: vi.fn(async () => null),
}));

// The database client reads TURSO_DATABASE_URL lazily on first use.
let tmpDir: string;

function raw() {
  return createClient({ url: process.env.TURSO_DATABASE_URL! });
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ghfind-devscore-"));
  process.env.TURSO_DATABASE_URL = `file:${join(tmpDir, "test.db")}`;
  process.env.GITHUB_ROAST_CLI_API_KEY = "test-key";
  delete process.env.TURSO_AUTH_TOKEN;
});

afterAll(() => {
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.GITHUB_ROAST_CLI_API_KEY;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fake.stepsToFinish = 3;
  fake.failWith = null;
  fake.stepCalls = 0;
});

function developer(login: string): Developer {
  const dev = fixtureDeveloper(login);
  fake.developer = dev;
  return dev;
}

/** Let the collector's rate-limit wait elapse (the fake sets one after each step). */
async function makeDue(username: string) {
  const job = await db.getDevscoreJob(username);
  const checkpoint = JSON.parse(job!.collectState!);
  checkpoint.collect.waitUntil = null;
  await raw().execute({
    sql: "UPDATE devscore_jobs SET next_run_at = 0, collect_state = ? WHERE username = ?",
    args: [JSON.stringify(checkpoint), username.toLowerCase()],
  });
}

describe("devscore job storage", () => {
  it("keeps one active job per user: enqueue is idempotent", async () => {
    const a = await db.enqueueDevscoreJob("Idem-User", { now: 1_000 });
    const b = await db.enqueueDevscoreJob("idem-user", { now: 2_000, resetDone: true });
    expect(a?.state).toBe("queued");
    expect(b?.runId).toBe(a?.runId);
    const rows = await raw().execute({ sql: "SELECT COUNT(*) AS n FROM devscore_jobs WHERE username = 'idem-user'" });
    expect(Number(rows.rows[0].n)).toBe(1);
  });

  it("lets only one runner hold the lease and reclaims an expired one", async () => {
    await db.enqueueDevscoreJob("lease-user", { now: 1_000 });
    const first = await db.claimDevscoreJob("lease-user", { now: 1_000, leaseMs: 60_000 });
    expect(first?.leaseToken).toBeTruthy();
    expect(await db.claimDevscoreJob("lease-user", { now: 30_000, leaseMs: 60_000 })).toBeNull();
    const reclaimed = await db.claimDevscoreJob("lease-user", { now: 61_001, leaseMs: 60_000 });
    expect(reclaimed?.leaseToken).toBeTruthy();
    expect(reclaimed?.leaseToken).not.toBe(first?.leaseToken);
    // The abandoned runner can no longer write.
    const stale = await db.saveDevscoreJobProgress(first!, {
      collectState: "{}", phase: "x", progress: 0.5, nextRunAt: 0, now: 61_002, release: true,
    });
    expect(stale).toBe(false);
  });

  it("backs off after a failure and gives up after the attempt budget", async () => {
    await db.enqueueDevscoreJob("flaky-user", { now: 1_000 });
    let now = 1_000;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = await db.claimDevscoreJob("flaky-user", { now, leaseMs: 60_000 });
      expect(job).not.toBeNull();
      const failed = await db.failDevscoreJobAttempt(job!, {
        error: "scan_failed", now, retryAt: now + 30_000, maxAttempts: 3, terminal: false,
      });
      expect(failed?.attempts).toBe(attempt);
      expect(failed?.state).toBe(attempt < 3 ? "queued" : "failed");
      // Backing off: not claimable before retryAt.
      expect(await db.claimDevscoreJob("flaky-user", { now: now + 1, leaseMs: 60_000 })).toBeNull();
      now += 30_000;
    }
    const final = await db.getDevscoreJob("flaky-user");
    expect(final).toMatchObject({ state: "failed", lastError: "scan_failed", attempts: 3 });
    // A failed job is not reset by ordinary requests inside its cooldown.
    const again = await db.enqueueDevscoreJob("flaky-user", { now: now + 1 });
    expect(again?.state).toBe("failed");
    const retried = await db.enqueueDevscoreJob("flaky-user", { now: now + 1, resetFailed: true });
    expect(retried).toMatchObject({ state: "queued", attempts: 0, lastError: null });
  });
});

describe("devscore backfill", () => {
  async function insertScore(username: string, finalScore: number, scoreVersion = SCORE_CACHE_VERSION) {
    await raw().execute({
      sql: `INSERT INTO scores (username, final_score, tier, score_version, scanned_at)
            VALUES (?, ?, 'NPC', ?, 1000)`,
      args: [username, finalScore, scoreVersion],
    });
  }

  it("enqueues scored accounts that have no job, best score first, within the active cap", async () => {
    await db.enqueueDevscoreJob("backfill-seed", { now: 1_000 }); // creates the schema
    await raw().execute({ sql: "DELETE FROM devscore_jobs" });
    await raw().execute({ sql: "DELETE FROM scores" });
    await insertScore("bf-low", 40);
    await insertScore("bf-high", 90);
    await insertScore("bf-mid", 60);
    await insertScore("bf-hasjob", 95);
    await insertScore("bf-old-release", 99, "v9");
    await db.enqueueDevscoreJob("bf-hasjob", { now: 1_000 });

    const first = await db.enqueueDevscoreBackfill({ limit: 2, activeCap: 50, now: 2_000 });
    expect(first).toEqual({ enqueued: 2, active: 3 });
    const queued = (await raw().execute({
      sql: "SELECT username FROM devscore_jobs WHERE username LIKE 'bf-%' ORDER BY username",
    })).rows.map((row) => String(row.username));
    expect(queued).toEqual(["bf-hasjob", "bf-high", "bf-mid"]);

    // The active cap bounds the queue even when more accounts are waiting.
    expect(await db.enqueueDevscoreBackfill({ limit: 10, activeCap: 3, now: 3_000 })).toEqual({ enqueued: 0, active: 3 });
    const rest = await db.enqueueDevscoreBackfill({ limit: 10, activeCap: 50, now: 3_000 });
    expect(rest.enqueued).toBe(1);
    // Accounts that already have a job (any state) are never selected again.
    expect((await db.enqueueDevscoreBackfill({ limit: 10, activeCap: 50, now: 4_000 })).enqueued).toBe(0);
  });
});

describe("advanceDevscoreJob", () => {
  it("persists collector steps across polls, then publishes the score with the devscore summary", async () => {
    developer("step-user");
    await db.enqueueDevscoreJob("step-user");

    const first = await jobs.advanceDevscoreJob("step-user", Date.now() + 5_000);
    expect(first?.status).toMatchObject({ state: "running", phase: "contribs" });
    expect(fake.stepCalls).toBe(1);
    const checkpoint = JSON.parse((await db.getDevscoreJob("step-user"))!.collectState!);
    expect(checkpoint).toMatchObject({ stage: "collect", collect: { steps: 1 } });

    await makeDue("step-user");
    const second = await jobs.advanceDevscoreJob("step-user", Date.now() + 5_000);
    expect(second?.status).toMatchObject({ state: "running", phase: "merged_prs" });
    expect(fake.stepCalls).toBe(2);

    await makeDue("step-user");
    const done = await jobs.advanceDevscoreJob("step-user", Date.now() + 5_000);
    expect(done?.status.state).toBe("done");
    expect(done?.result?.devscore?.version).toBe("v11");

    const row = (await raw().execute({
      sql: `SELECT score_version, score_source_collection_version, sub_scores, final_score
            FROM scores WHERE username = 'step-user'`,
    })).rows[0];
    expect(row).toMatchObject({
      score_version: SCORE_CACHE_VERSION,
      score_source_collection_version: PUBLIC_SCAN_COLLECTION_VERSION,
    });
    expect(Object.keys(JSON.parse(String(row.sub_scores))).sort()).toEqual([
      "account_maturity", "activity_authenticity", "community_influence",
      "contribution_quality", "ecosystem_impact", "original_project_quality",
    ]);
    expect(Number(row.final_score)).toBe(done?.result?.scoring.final_score);
    // The snapshot stores the devscore summary; the score still rates the display metrics.
    expect(done?.result?.scoring).toEqual(scoreMetrics(fixtureDisplayScan("step-user").metrics));
    expect((await db.getDevscoreJob("step-user"))?.state).toBe("done");
  });

  it("records a missing account as a terminal failure", async () => {
    await db.enqueueDevscoreJob("ghost-user");
    fake.failWith = new Error("user ghost-user not found");
    const result = await jobs.advanceDevscoreJob("ghost-user", Date.now() + 5_000);
    expect(result?.status).toEqual({ state: "failed", error: "account_not_found" });
  });
});

describe("202 flow: POST /api/scan → status polls → GET /api/score", () => {
  it("queues, advances on each poll, publishes the score and then serves it", async () => {
    developer("FlowUser");
    fake.stepsToFinish = 2;
    const params = { params: Promise.resolve({ username: "FlowUser" }) };

    const scoreMiss = await score(new NextRequest("https://example.test/api/score/FlowUser"), params);
    expect(scoreMiss.status).toBe(202);
    expect(scoreMiss.headers.get("location")).toBe("/api/scan/status/FlowUser");

    const queued = await POST(new NextRequest("https://example.test/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key", "idempotency-key": "k1" },
      body: JSON.stringify({ username: "FlowUser" }),
    }));
    expect(queued.status).toBe(202);
    expect(queued.headers.get("location")).toBe("/api/scan/status/FlowUser");
    expect(queued.headers.get("idempotency-key")).toBe("k1");
    await expect(queued.json()).resolves.toMatchObject({ status: { state: "queued" } });

    const poll1 = await status(new NextRequest("https://example.test/api/scan/status/FlowUser"), params);
    expect(poll1.status).toBe(202);
    await expect(poll1.json()).resolves.toMatchObject({ status: { state: "running" } });

    await makeDue("FlowUser");
    const poll2 = await status(new NextRequest("https://example.test/api/scan/status/FlowUser"), params);
    expect(poll2.status).toBe(200);
    const finished = await poll2.json();
    expect(finished.status.state).toBe("done");
    expect(finished.result.metrics.username).toBe("FlowUser");

    const indexed = await score(new NextRequest("https://example.test/api/score/FlowUser"), params);
    expect(indexed.status).toBe(200);
    await expect(indexed.json()).resolves.toMatchObject({
      source: "indexed",
      final_score: finished.result.scoring.final_score,
      tier: finished.result.scoring.tier,
      sub_scores: finished.result.scoring.sub_scores,
    });

    // A published score replays inline instead of queueing again.
    const replay = await POST(new NextRequest("https://example.test/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({ username: "FlowUser" }),
    }));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ cached: true, scoring: { final_score: finished.result.scoring.final_score } });
  });

  it("returns 404 from the status route when no job exists", async () => {
    const response = await status(new NextRequest("https://example.test/api/scan/status/nobody-here"), {
      params: Promise.resolve({ username: "nobody-here" }),
    });
    expect(response.status).toBe(404);
  });
});
