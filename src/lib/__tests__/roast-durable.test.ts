import { afterEach, describe, expect, it, vi } from "vitest";
import { roastProgress } from "../roast-progress";

/** Matches V13_CHAIN_BUDGET_MS in roast-handler. Kept local so this file does not load Next. */
const CHAIN_BUDGET_MS = 7 * 60_000;
/** Matches V13_ATTACH_BUDGET_MS — interactive attach wait before v12 fallback. */
const ATTACH_BUDGET_MS = 100_000;

/**
 * In-memory RoastJob. Mirrors apps/coord/src/roast-job.ts: one record per
 * profile, a second claim attaches, and the alarm is the only thing that
 * runs generation. Tests drive the alarm themselves so they do not wait on
 * the platform.
 */
interface Job {
  state: "running" | "done" | "failed";
  username: string;
  lang: string;
  startedAt: number;
  updatedAt: number;
  stage: string;
  fallback: "v12" | null;
  reason?: string;
}

function memoryJob(now: () => number) {
  let job: Job | null = null;
  let owner: string | null = null;
  let alarms = 0;
  let inflight = false;
  const api = {
    runs: [] as { username: string; lang: string; owner: string }[],
    async run(username: string, lang: string, token: string) {
      api.runs.push({ username, lang, owner: token });
    },
  };
  const stub = {
    claim(username: string, lang: string) {
      if (job && job.state === "running") return { job, started: false, binding: true };
      const t = now();
      job = { state: "running", username, lang, startedAt: t, updatedAt: t, stage: "", fallback: null };
      owner = `owner-${alarms + 1}`;
      alarms += 1;
      return { job, started: true, binding: true };
    },
    status: () => job,
    owner: () => owner,
    note(stage: string) {
      if (!job || job.state !== "running") return job;
      if (stage.trim()) job.stage = stage.trim();
      job.updatedAt = now();
      return job;
    },
    finish(ok: boolean, reason?: string) {
      if (!job) return null;
      job.state = ok ? "done" : "failed";
      job.reason = reason;
      job.updatedAt = now();
      return job;
    },
    abandon(reason: string) {
      if (!job || job.state !== "running") return job;
      job.state = "failed";
      job.fallback = "v12";
      job.reason = reason;
      job.updatedAt = now();
      return job;
    },
    async alarm() {
      if (!job || job.state !== "running" || !owner || inflight) return;
      inflight = true;
      try {
        await api.run(job.username, job.lang, owner);
      } catch (error) {
        inflight = false;
        throw error;
      }
    },
  };
  return { stub, api, alarms: () => alarms };
}

/** Percent samples a returning page would paint, from the job's stored start. */
function ringPercents(startedAt: number, samples: number[]): number[] {
  let previous = 0;
  return samples.map((now) => {
    const snap = roastProgress({ elapsedMs: Math.max(0, now - startedAt), generator: "v13" });
    const percent = Math.max(previous, snap.percent);
    previous = percent;
    return percent;
  });
}

describe("durable v13 roast job", () => {
  it("reattaches a returning page to the same job and keeps the ring monotonic", async () => {
    let clock = 1_000_000;
    const job = memoryJob(() => clock);
    const first = job.stub.claim("FixtureDev", "zh");
    expect(first.started).toBe(true);
    await job.stub.alarm();
    expect(job.api.runs).toHaveLength(1);

    clock += 90_000;
    job.stub.note("正在撰写锐评…");
    const leftAt = ringPercents(first.job.startedAt, [clock])[0];

    // The page was closed. Coming back reads the same startedAt.
    clock += 30_000;
    const again = job.stub.claim("fixturedev", "zh");
    expect(again.started).toBe(false);
    expect(again.job.startedAt).toBe(first.job.startedAt);
    expect(job.alarms()).toBe(1);
    await job.stub.alarm();
    expect(job.api.runs).toHaveLength(1);

    const resumed = ringPercents(again.job.startedAt, [clock, clock + 20_000, clock + 40_000]);
    expect(resumed[0]).toBeGreaterThanOrEqual(leftAt);
    expect(resumed[1]).toBeGreaterThanOrEqual(resumed[0]);
    expect(resumed[2]).toBeGreaterThanOrEqual(resumed[1]);
    // Two minutes in, the 7-minute curve is still well below the cap.
    expect(resumed[0]).toBeGreaterThan(20);
    expect(resumed[0]).toBeLessThan(60);
  });

  it("dedupes a second request onto the same job", () => {
    const job = memoryJob(() => 5_000);
    const leader = job.stub.claim("FixtureDev", "en");
    const follower = job.stub.claim("FixtureDev", "en");
    expect(leader.started).toBe(true);
    expect(follower.started).toBe(false);
    expect(follower.job.startedAt).toBe(leader.job.startedAt);
    expect(job.alarms()).toBe(1);
    // Another language is a different job, matching the auto re-roast key.
    const other = memoryJob(() => 5_000);
    expect(other.stub.claim("FixtureDev", "zh").started).toBe(true);
  });

  it("falls back to v12 after the interactive attach budget and does not start a second chain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const job = memoryJob(() => Date.now());
    const frames: string[] = [];
    const enc = new TextEncoder();
    const { attachDurableRoast } = await import("../roast-durable-attach");
    const result = await attachDurableRoast({
      job: job.stub,
      enc,
      push: (bytes) => frames.push(new TextDecoder().decode(bytes)),
      beat: () => {},
      lang: "zh",
      username: "FixtureDev",
      snapshotHash: "a".repeat(64),
      // Interactive path uses the attach budget, not the full 7-minute chain budget.
      deadlineMs: ATTACH_BUDGET_MS,
      readCached: async () => null,
      metaFor: async () => {
        throw new Error("no cached roast");
      },
      matchesLang: () => true,
      // Each wait is one second of the attach budget, with no real delay.
      sleep: async (ms) => {
        vi.setSystemTime(Date.now() + ms);
      },
    });
    expect(result).toEqual({ kind: "fallback", reason: "v13_budget" });
    expect(job.stub.status()?.fallback).toBe("v12");
    expect(job.alarms()).toBe(1);
    expect(frames[0]?.startsWith("\x1fS")).toBe(true);
    // Attach must not wait the full chain budget or the Worker dies first.
    expect(Date.now()).toBeLessThanOrEqual(ATTACH_BUDGET_MS + 2_000);
    expect(Date.now()).toBeLessThan(CHAIN_BUDGET_MS / 2);
    vi.unstubAllGlobals();
  });

  it("never decreases the displayed percent across a long v13 wait", () => {
    const startedAt = 0;
    let previous = 0;
    for (let t = 0; t <= 8 * 60_000; t += 5_000) {
      const [percent] = ringPercents(startedAt, [t]);
      expect(percent).toBeGreaterThanOrEqual(previous);
      previous = percent;
    }
    const atBudget = roastProgress({ elapsedMs: 7 * 60_000, generator: "v13" });
    expect(atBudget.percent).toBeGreaterThanOrEqual(70);
    expect(atBudget.percent).toBeLessThan(97);
  });
});

describe("roast progress reattach", () => {
  it("a later startedAt cannot pull an in-flight percent backward", () => {
    const early = roastProgress({ elapsedMs: 120_000, generator: "v13" });
    const late = roastProgress({ elapsedMs: 1_000, generator: "v13" });
    expect(late.percent).toBeLessThan(early.percent);
    const shown = Math.max(early.percent, late.percent);
    expect(shown).toBe(early.percent);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
