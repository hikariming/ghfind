/**
 * devscore collector entry: `startCollect` / `stepCollect` (port of collect.py `collect()`).
 * Each phase is a function of the earlier phases' stored outputs; `stepCollect` runs phases
 * in order until the step deadline, persisting each output, and returns the state to resume
 * from. A phase interrupted by the deadline or a rate limit reruns from its start (or from
 * its saved cursor) in the next step: every HTTP answer it already got is served from the
 * cache, so rerunning is cheap and gives the same result.
 */
import { CollectPause, Http } from "./http";
import { PHASE_RUNNERS } from "./phases";
import {
  COLLECT_PHASES,
  PHASE_TTL_SECONDS,
  phaseKey,
  type CollectEnv,
  type CollectPhase,
  type CollectState,
  type CollectStep,
} from "./types";

export type { CollectEnv, CollectPhase, CollectState, CollectStep, CollectStore } from "./types";
export { COLLECT_PHASES } from "./types";
export { ApiError, CollectPause } from "./http";

/** Context a phase runs with: transport, run state and access to earlier phases' outputs. */
export interface PhaseContext {
  http: Http;
  state: CollectState;
  /** Output of an earlier phase (throws if it is missing: phases run in order). */
  get<T>(phase: CollectPhase): Promise<T>;
  /** Saves a phase-local cursor; persisted with the state if the step stops inside the phase. */
  saveCursor(cursor: unknown): void;
  log(msg: string): void;
}

export type PhaseRunner = (ctx: PhaseContext) => Promise<unknown>;

export function startCollect(login: string, now: number = Date.now()): CollectState {
  return {
    runId: `${login.toLowerCase()}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    login,
    startedAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
    phase: COLLECT_PHASES[0],
    progress: 0,
    waitUntil: null,
    cursor: null,
  };
}

export async function stepCollect(state: CollectState, env: CollectEnv, deadlineMs: number): Promise<CollectStep> {
  const http = new Http(env, deadlineMs);
  let current: CollectState = { ...state, waitUntil: null };
  const log = (msg: string) => env.log?.(`[${current.login}] ${msg}`);
  const outputs = new Map<CollectPhase, unknown>();
  const get = async <T>(phase: CollectPhase): Promise<T> => {
    if (outputs.has(phase)) return outputs.get(phase) as T;
    const value = await env.store.get<{ v: T }>(phaseKey(current, phase));
    if (!value) throw new Error(`devscore collect: phase ${phase} output missing for run ${current.runId}`);
    outputs.set(phase, value.v);
    return value.v;
  };
  while (true) {
    const index = COLLECT_PHASES.indexOf(current.phase);
    const phase = current.phase;
    let cursor = current.cursor;
    const ctx: PhaseContext = {
      http,
      state: current,
      get,
      saveCursor: (c) => {
        cursor = c;
      },
      log,
    };
    let output: unknown;
    try {
      http.checkDeadline();
      output = await PHASE_RUNNERS[phase](ctx);
    } catch (error) {
      if (!(error instanceof CollectPause)) throw error;
      const paused = error.until > deadlineMs ? error.until : null;
      return { done: false, state: { ...current, cursor, waitUntil: paused } };
    }
    if (phase === "assemble") return { done: true, developer: output };
    // wrapped so a phase that legitimately outputs null is still distinguishable from "missing"
    await env.store.put(phaseKey(current, phase), { v: output }, PHASE_TTL_SECONDS);
    outputs.set(phase, output);
    current = {
      ...current,
      phase: COLLECT_PHASES[index + 1],
      progress: (index + 1) / COLLECT_PHASES.length,
      cursor: null,
    };
    log(`phase ${phase} done (http ${JSON.stringify(http.calls)})`);
  }
}
