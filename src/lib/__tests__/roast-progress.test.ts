import { describe, expect, it } from "vitest";
import {
  ROAST_PROGRESS_CAP,
  ROAST_PROGRESS_COMPLETE_MS,
  ROAST_PROGRESS_CREEP_MAX,
  ROAST_PROGRESS_TAU_V12_MS,
  ROAST_PROGRESS_TAU_V13_MS,
  holdProgress,
  nextStageFloor,
  resolveStartedAtMs,
  roastApproachRatio,
  roastProgress,
  roastProgressTauMs,
  roastRunningRatio,
  seedElapsedMs,
  stageFloorForLabel,
} from "../roast-progress";

describe("roast progress curve", () => {
  it("follows p(t) = cap * (1 - exp(-t/τ)) and stays under the cap", () => {
    const samples = [0, 1_000, 8_000, 28_000, 60_000];
    for (const t of samples) {
      const expected = ROAST_PROGRESS_CAP * (1 - Math.exp(-t / ROAST_PROGRESS_TAU_V13_MS));
      expect(roastApproachRatio(t)).toBeCloseTo(expected, 8);
      expect(roastApproachRatio(t)).toBeLessThanOrEqual(ROAST_PROGRESS_CAP);
    }
    expect(roastApproachRatio(0)).toBe(0);
  });

  it("puts about 80% of the capped curve on each measured median", () => {
    const v12 = roastApproachRatio(56_000, ROAST_PROGRESS_TAU_V12_MS);
    const v13 = roastApproachRatio(7 * 60_000, ROAST_PROGRESS_TAU_V13_MS);
    expect(v12 / ROAST_PROGRESS_CAP).toBeCloseTo(0.8, 2);
    expect(v13 / ROAST_PROGRESS_CAP).toBeCloseTo(0.8, 2);
    expect(roastProgressTauMs("v12")).toBe(ROAST_PROGRESS_TAU_V12_MS);
    expect(roastProgressTauMs("v13")).toBe(ROAST_PROGRESS_TAU_V13_MS);
    expect(roastProgressTauMs(null)).toBe(ROAST_PROGRESS_TAU_V13_MS);
    const atTwelve = roastProgress({ elapsedMs: 12_000, generator: "v12" });
    const unknown = roastProgress({ elapsedMs: 12_000 });
    expect(atTwelve.percent).toBeGreaterThan(unknown.percent);
  });

  it("is monotonic, floors the percent, and never walks backward", () => {
    let prev = -1;
    for (let t = 0; t <= 500_000; t += 1_000) {
      const snap = roastProgress({ elapsedMs: t });
      expect(snap.percent).toBeGreaterThanOrEqual(prev);
      expect(snap.percent).toBe(Math.floor(snap.ratio * 100 + 1e-9));
      expect(snap.percent).toBeLessThanOrEqual(97);
      prev = snap.percent;
    }
  });

  it("creeps from the cap toward 97% and then stays", () => {
    const early = roastRunningRatio(20_000);
    expect(early).toBeLessThan(ROAST_PROGRESS_CAP);
    const creeping = roastRunningRatio(1_400_000);
    expect(creeping).toBeGreaterThan(ROAST_PROGRESS_CAP);
    expect(creeping).toBeLessThanOrEqual(ROAST_PROGRESS_CREEP_MAX);
    const late = roastRunningRatio(30 * 60_000);
    expect(late).toBeCloseTo(ROAST_PROGRESS_CREEP_MAX, 5);
    expect(roastProgress({ elapsedMs: 30 * 60_000 }).percent).toBe(97);
  });

  it("ramps to 100% across the complete window and settles", () => {
    const start = roastProgress({ elapsedMs: 12_000, complete: true, completeElapsedMs: 0 });
    const mid = roastProgress({
      elapsedMs: 12_000,
      complete: true,
      completeElapsedMs: ROAST_PROGRESS_COMPLETE_MS / 2,
    });
    const done = roastProgress({
      elapsedMs: 12_000,
      complete: true,
      completeElapsedMs: ROAST_PROGRESS_COMPLETE_MS,
    });
    expect(mid.percent).toBeGreaterThan(start.percent);
    expect(done.percent).toBe(100);
    expect(done.settled).toBe(true);
    expect(done.stageIndex).toBe(4);
  });

  it("steps the reduced-motion percent by 5 and still reaches 100 when complete", () => {
    const stepped = roastProgress({ elapsedMs: 40_000, reducedMotion: true });
    expect(stepped.percent % 5).toBe(0);
    const raw = roastProgress({ elapsedMs: 40_000 });
    expect(stepped.percent).toBeLessThanOrEqual(raw.percent);
    expect(stepped.percent).toBeGreaterThan(0);
    const done = roastProgress({
      elapsedMs: 12_000,
      complete: true,
      completeElapsedMs: ROAST_PROGRESS_COMPLETE_MS,
      reducedMotion: true,
    });
    expect(done.percent).toBe(100);
  });

  it("only raises progress to the stage floor", () => {
    expect(stageFloorForLabel("正在撰写锐评… (8s)")).toBeGreaterThanOrEqual(0.4);
    expect(stageFloorForLabel("正在挑选扎心事实…")).toBeGreaterThanOrEqual(0.22);
    expect(stageFloorForLabel("")).toBe(0);
    const floor = nextStageFloor(0.4, stageFloorForLabel("读取扫描结果"));
    expect(floor).toBe(0.4);
    const raised = nextStageFloor(floor, stageFloorForLabel("正在逐句核对事实…"));
    expect(raised).toBeGreaterThanOrEqual(0.62);
    const held = roastProgress({ elapsedMs: 1_000, stageFloor: raised });
    const plain = roastProgress({ elapsedMs: 1_000 });
    expect(held.percent).toBeGreaterThanOrEqual(plain.percent);
    expect(held.percent).toBeGreaterThanOrEqual(62);
    expect(nextStageFloor(raised, 0.1)).toBe(raised);
  });

  it("seeds a non-zero elapsed time when a job is already running", () => {
    expect(seedElapsedMs(null, 1_000)).toBeGreaterThan(0);
    expect(seedElapsedMs(5_000, 9_000)).toBe(4_000);
    expect(seedElapsedMs(9_000, 5_000)).toBe(0);
  });

  it("advances the stage index with progress and never cycles within one snapshot", () => {
    const early = roastProgress({ elapsedMs: 500 });
    const mid = roastProgress({ elapsedMs: 80_000 });
    const late = roastProgress({ elapsedMs: 280_000 });
    expect(early.stageIndex).toBe(0);
    expect(mid.stageIndex).toBeGreaterThan(early.stageIndex);
    expect(late.stageIndex).toBeGreaterThanOrEqual(mid.stageIndex);
    expect(late.stageIndex).toBeLessThanOrEqual(4);
  });

  it("clamps negative or non-finite elapsed time to 0% instead of NaN", () => {
    for (const elapsedMs of [-5_000, Number.NaN, Number.NEGATIVE_INFINITY]) {
      const snap = roastProgress({ elapsedMs });
      expect(snap.percent).toBe(0);
      expect(snap.stageIndex).toBe(0);
      expect(Number.isFinite(snap.ratio)).toBe(true);
    }
  });

  it("keeps reduced-motion steps advancing the stage line", () => {
    const early = roastProgress({ elapsedMs: 2_000, reducedMotion: true, generator: "v12" });
    const mid = roastProgress({ elapsedMs: 20_000, reducedMotion: true, generator: "v12" });
    const late = roastProgress({ elapsedMs: 90_000, reducedMotion: true, generator: "v12" });
    expect(early.percent % 5).toBe(0);
    expect(mid.percent).toBeGreaterThan(early.percent);
    expect(mid.stageIndex).toBeGreaterThan(0);
    expect(late.stageIndex).toBeGreaterThan(mid.stageIndex);
    expect(late.percent % 5).toBe(0);
  });

  it("accepts a harness-only tauMs override without touching generator defaults", () => {
    const compressed = roastProgress({ elapsedMs: 8_000, tauMs: 5_000 });
    const production = roastProgress({ elapsedMs: 8_000, generator: "v13" });
    expect(compressed.percent).toBeGreaterThan(production.percent);
    expect(compressed.percent).toBeGreaterThan(40);
    expect(roastProgressTauMs("v13")).toBe(ROAST_PROGRESS_TAU_V13_MS);
  });

  it("holdProgress prevents a mid-stream generator header from walking the ring backward", () => {
    const withV12 = roastProgress({ elapsedMs: 40_000, generator: "v12" });
    const withV13 = roastProgress({ elapsedMs: 40_000, generator: "v13" });
    expect(withV13.percent).toBeLessThan(withV12.percent);
    const held = holdProgress(
      { percent: withV12.percent, stageIndex: withV12.stageIndex },
      withV13,
    );
    expect(held.percent).toBe(withV12.percent);
    expect(held.stageIndex).toBeGreaterThanOrEqual(withV12.stageIndex);
  });

  it("resolveStartedAtMs ignores future or stale stored starts", () => {
    const now = 1_000_000;
    expect(resolveStartedAtMs(now + 5_000, now)).toBe(now);
    expect(resolveStartedAtMs(now - 20 * 60_000, now)).toBe(now);
    expect(resolveStartedAtMs(now - 12 * 60_000, now)).toBe(now - 12 * 60_000);
    expect(resolveStartedAtMs(now - 3_000, now)).toBe(now - 3_000);
    expect(resolveStartedAtMs(null, now, { resume: true })).toBeLessThan(now);
  });

});
