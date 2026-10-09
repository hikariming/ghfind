/**
 * devscore collector contract: a resumable, step-wise port of collector/collect.py for the
 * Worker runtime. `stepCollect` runs phases until the step deadline; each finished phase's
 * output is written to the store under `run:<runId>:<phase>` and the small `CollectState`
 * only records where to resume.
 */

/** Durable key/value for HTTP answers and phase outputs; JSON values up to a few MB. */
export interface CollectStore {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
}

export interface CollectEnv {
  fetch: typeof fetch;
  /** GitHub PATs; calls rotate across them and a rate-limited token hands over to the next. */
  githubTokens: string[];
  store: CollectStore;
  now: () => number;
  log?: (msg: string) => void;
}

/** Phases in execution order (the job runner and the i18n `scoreJob.phase` keys use these names). */
export const COLLECT_PHASES = [
  "user",
  "contribs",
  "maintainer",
  "gap_fill",
  "merged_prs",
  "repo_meta",
  "pr_samples",
  "pr_details",
  "mutual_mergers",
  "histories",
  "signals",
  "per_repo",
  "owner_types",
  "star_history",
  "rejected",
  "ext_prs",
  "assemble",
] as const;

export type CollectPhase = (typeof COLLECT_PHASES)[number];

export interface CollectState {
  /** Run id: scopes this run's phase outputs in the store. */
  runId: string;
  /** The requested login; the canonical login comes from the `user` phase. */
  login: string;
  /** Collection start (ISO, UTC): the `collected_at` of the result and the clock for "recent" windows. */
  startedAt: string;
  /** The next phase to run. */
  phase: CollectPhase;
  /** Share of phases done, in [0, 1). */
  progress: number;
  /** Rate-limited: do not step again before this epoch ms. null: ready. */
  waitUntil: number | null;
  /** Per-phase resumable cursor (a phase that pages or iterates many repos saves its position here). */
  cursor: unknown;
}

/** `developer`: the collector's JSON (CollectedDeveloper, e.g. null ext_prs sizes); parseDeveloper reads it. */
export type CollectStep = { done: false; state: CollectState } | { done: true; developer: unknown };

/** How long phase outputs stay in the store (a run finishes within hours; retries within days). */
export const PHASE_TTL_SECONDS = 3 * 24 * 3600;

export function phaseKey(state: CollectState, phase: CollectPhase): string {
  return `run:${state.runId}:${phase}`;
}
