/**
 * Approximate roast progress while the report is still generating.
 *
 * p(t) = cap * (1 - exp(-t / τ)), then a slow creep once the curve saturates,
 * and a short ramp to 100% when the report arrives. The displayed percent is
 * floored and never decreases. Backend T-frames may only raise a stage floor.
 *
 * τ is chosen so 80% of the capped curve (p = 0.80 × 0.92) lands on the
 * expected wall time:
 *   τ = median_ms / -ln(0.2)
 * v12 median 56.0s (n=30, v12grok batch) → τ ≈ 34.8s.
 * v13 foreground budget is 7 minutes (the durable chain may run that long
 * before falling back). τ ≈ 260.9s so the ring is still moving near the end
 * instead of sitting on the 92% cap. The older 230.5s median used τ ≈ 143.2s.
 * Until the response names a generator, use the longer v13 constant so a
 * chain run does not sit on the cap early.
 */

export type RoastGenerator = "v12" | "v13";

export const ROAST_PROGRESS_CAP = 0.92;
export const ROAST_PROGRESS_CREEP_MAX = 0.97;
/** v12 single-call median 56.0s. */
export const ROAST_PROGRESS_TAU_V12_MS = 34_800;
/**
 * v13 foreground budget is 7 minutes. τ = 420_000 / -ln(0.2) ≈ 260_857,
 * rounded to 260_900. Also the default until the generator is known.
 */
export const ROAST_PROGRESS_TAU_V13_MS = 260_900;
/** @deprecated Use {@link roastProgressTauMs}. Kept as the v13 default. */
export const ROAST_PROGRESS_TAU_MS = ROAST_PROGRESS_TAU_V13_MS;

export function roastProgressTauMs(generator?: RoastGenerator | null): number {
  return generator === "v12" ? ROAST_PROGRESS_TAU_V12_MS : ROAST_PROGRESS_TAU_V13_MS;
}
/** Hold at the cap this long before the slow creep toward 97%. */
export const ROAST_PROGRESS_CREEP_DELAY_MS = 8_000;
/** Creep from cap to 97% over this window, then stay. */
export const ROAST_PROGRESS_CREEP_WINDOW_MS = 40_000;
/** Animate the ring to 100% over this long once the roast arrives. */
export const ROAST_PROGRESS_COMPLETE_MS = 300;
/** Cross-fade from the card into the report after the ring hits 100%. */
export const ROAST_PROGRESS_FADE_MS = 250;

/** Stage lines advance with progress and never cycle backward. */
export const ROAST_PROGRESS_STAGE_COUNT = 5;

/**
 * Conservative floors for server T-frame labels. Matching a later stage only
 * raises progress; an earlier or unknown label never pulls it back.
 */
export const ROAST_STAGE_FLOORS = [
  { match: /读取|扫描|reading scan|reading the scan/i, floor: 0.08 },
  { match: /挑|事实|angles|sharpest|值得写/i, floor: 0.22 },
  { match: /起草|撰写|笑点|writing roast|writer/i, floor: 0.4 },
  { match: /核对|数字|仓库|fact-check|editor/i, floor: 0.62 },
  { match: /排版|收尾|polish|layout/i, floor: 0.78 },
] as const;

export interface RoastProgressInput {
  /** Milliseconds since generation started (already elapsed, including a resumed job). */
  elapsedMs: number;
  /** True once report text or roast meta is ready to reveal. */
  complete?: boolean;
  /** Milliseconds since `complete` flipped true. Ignored while incomplete. */
  completeElapsedMs?: number;
  /** Highest stage floor observed from T-frames, in 0..1. */
  stageFloor?: number;
  /** When true, the displayed percent moves in 5-point steps. */
  reducedMotion?: boolean;
  /** Copy chain for this roast. Unknown uses the longer v13 τ. */
  generator?: RoastGenerator | null;
  /**
   * Optional τ override (harness / tests only). When set, ignores `generator`.
   * Production callers should leave this unset and pass `generator` instead.
   */
  tauMs?: number;
}

export interface RoastProgressSnapshot {
  /** 0..1, monotonic in elapsed time for a fixed stage floor. */
  ratio: number;
  /** Integer percent, floored, 0..100. */
  percent: number;
  /** 0-based stage index. Advances with progress and completion; never decreases. */
  stageIndex: number;
  /** True once the complete animation has reached 100%. */
  settled: boolean;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Exponential approach to `cap`, before creep or completion. */
export function roastApproachRatio(
  elapsedMs: number,
  tauMs = ROAST_PROGRESS_TAU_V13_MS,
): number {
  const t = Math.max(0, elapsedMs);
  const tau = tauMs > 0 ? tauMs : ROAST_PROGRESS_TAU_V13_MS;
  return ROAST_PROGRESS_CAP * (1 - Math.exp(-t / tau));
}

/**
 * Running ratio: exponential curve, then a slow creep from the cap toward 97%
 * that stays there. Never exceeds the creep ceiling while incomplete.
 */
export function roastRunningRatio(elapsedMs: number, tauMs = ROAST_PROGRESS_TAU_V13_MS): number {
  const approach = roastApproachRatio(elapsedMs, tauMs);
  const t = Math.max(0, elapsedMs);
  const tau = tauMs > 0 ? tauMs : ROAST_PROGRESS_TAU_V13_MS;
  // Creep begins once the exponential is within ~0.5pt of the cap, then
  // pauses a fixed beat. The creep window stays absolute so a long v13 run
  // still leaves the cap instead of stretching the pause with τ.
  const nearCapMs = -tau * Math.log(0.005 / ROAST_PROGRESS_CAP);
  const creepStart = nearCapMs + ROAST_PROGRESS_CREEP_DELAY_MS;
  if (t <= creepStart) return approach;
  const creepT = Math.min(1, (t - creepStart) / ROAST_PROGRESS_CREEP_WINDOW_MS);
  const crept = ROAST_PROGRESS_CAP + (ROAST_PROGRESS_CREEP_MAX - ROAST_PROGRESS_CAP) * creepT;
  return Math.max(approach, Math.min(ROAST_PROGRESS_CREEP_MAX, crept));
}

/** Map a T-frame label to a forward-only floor. Unknown labels return 0. */
export function stageFloorForLabel(label: string): number {
  const text = label.trim();
  if (!text) return 0;
  let floor = 0;
  for (const stage of ROAST_STAGE_FLOORS) {
    if (stage.match.test(text)) floor = Math.max(floor, stage.floor);
  }
  return floor;
}

/** Merge a new stage signal without ever moving the floor backward. */
export function nextStageFloor(current: number, incoming: number): number {
  const base = Number.isFinite(current) ? current : 0;
  const next = Number.isFinite(incoming) ? incoming : 0;
  return clamp01(Math.max(base, next));
}

function stageIndexForRatio(ratio: number, complete: boolean): number {
  if (complete || ratio >= 0.78) return 4;
  if (ratio >= 0.58) return 3;
  if (ratio >= 0.38) return 2;
  if (ratio >= 0.18) return 1;
  return 0;
}

/**
 * Displayed progress. `stageFloor` can only raise the ratio. Completion eases
 * from the in-flight value to 1 over {@link ROAST_PROGRESS_COMPLETE_MS}.
 */
export function roastProgress(input: RoastProgressInput): RoastProgressSnapshot {
  // Negative / non-finite elapsed (clock skew, bad resume) must not NaN the ring.
  const elapsedMs = Math.max(0, Number.isFinite(input.elapsedMs) ? input.elapsedMs : 0);
  const floor = clamp01(input.stageFloor ?? 0);
  const tau =
    input.tauMs != null && Number.isFinite(input.tauMs) && input.tauMs > 0
      ? input.tauMs
      : roastProgressTauMs(input.generator);
  const running = Math.max(roastRunningRatio(elapsedMs, tau), floor);
  const complete = input.complete === true;
  let ratio = running;
  if (complete) {
    const dt = Math.max(0, input.completeElapsedMs ?? 0);
    const u = Math.min(1, dt / ROAST_PROGRESS_COMPLETE_MS);
    // Smoothstep so the last stretch does not jump.
    const eased = u * u * (3 - 2 * u);
    ratio = running + (1 - running) * eased;
  }
  ratio = clamp01(ratio);
  let percent = Math.floor(ratio * 100 + 1e-9);
  if (input.reducedMotion) {
    const done = complete && (input.completeElapsedMs ?? 0) >= ROAST_PROGRESS_COMPLETE_MS;
    percent = done ? 100 : Math.min(complete ? 100 : 97, Math.floor(percent / 5) * 5);
    ratio = percent / 100;
  }
  if (complete && (input.completeElapsedMs ?? 0) >= ROAST_PROGRESS_COMPLETE_MS) {
    ratio = 1;
    percent = 100;
  }
  percent = Math.min(100, Math.max(0, percent));
  return {
    ratio,
    percent,
    stageIndex: stageIndexForRatio(percent / 100, complete && percent >= 100),
    settled: complete && percent >= 100,
  };
}

/**
 * Seed a non-zero elapsed time when a roast is already in flight but this
 * view has no start timestamp — avoids flashing 0% on refresh.
 *
 * A future `startedAtMs` (client/server clock skew) returns 0 so callers can
 * re-anchor; prefer {@link resolveStartedAtMs} in the hook.
 */
export function seedElapsedMs(startedAtMs: number | null | undefined, nowMs: number): number {
  if (startedAtMs == null || !Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return 4_000;
  const elapsed = nowMs - startedAtMs;
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return elapsed;
}

/** A resumed job may already have been running for the 7-minute budget plus margin. */
const DEFAULT_START_MAX_AGE_MS = 15 * 60_000;

/**
 * Pick a wall-clock start for the progress curve. Future or stale stored
 * timestamps are ignored so a skewed clock cannot pin the ring at 0%.
 */
export function resolveStartedAtMs(
  stored: number | null | undefined,
  nowMs: number,
  options?: { resume?: boolean; maxAgeMs?: number },
): number {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const maxAge = options?.maxAgeMs ?? DEFAULT_START_MAX_AGE_MS;
  if (
    stored != null &&
    Number.isFinite(stored) &&
    now >= stored &&
    now - stored < maxAge
  ) {
    return stored;
  }
  const seeded = options?.resume ? seedElapsedMs(null, now) : 0;
  return now - seeded;
}

/**
 * Keep displayed progress from walking backward when τ lengthens mid-stream
 * (e.g. X-Roast-Generator arrives late and switches the curve).
 */
export function holdProgress(
  previous: { percent: number; stageIndex: number },
  next: RoastProgressSnapshot,
): RoastProgressSnapshot {
  const percent = Math.max(
    Number.isFinite(previous.percent) ? previous.percent : 0,
    next.percent,
  );
  const stageIndex = Math.max(
    Number.isFinite(previous.stageIndex) ? previous.stageIndex : 0,
    next.stageIndex,
  );
  return {
    ...next,
    percent: Math.min(100, percent),
    stageIndex: Math.min(ROAST_PROGRESS_STAGE_COUNT - 1, stageIndex),
    settled: next.settled || percent >= 100,
  };
}

const START_KEY_PREFIX = "ghfind:roast-progress:";

export function roastProgressStorageKey(username: string, lang: string): string {
  return `${START_KEY_PREFIX}${username.trim().toLowerCase()}:${lang}`;
}

/** Persist the moment generation started so a refresh can resume the curve. */
export function rememberRoastStart(username: string, lang: string, startedAtMs: number): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(roastProgressStorageKey(username, lang), String(Math.floor(startedAtMs)));
  } catch {
    /* private mode / quota */
  }
}

export function readRoastStart(username: string, lang: string): number | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(roastProgressStorageKey(username, lang));
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function clearRoastStart(username: string, lang: string): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(roastProgressStorageKey(username, lang));
  } catch {
    /* ignore */
  }
}
