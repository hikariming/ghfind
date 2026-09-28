/**
 * `ghfind/local` — LOCAL devscore scoring (Node ≥ 22: the collector uses `Promise.withResolvers`).
 *
 * Bundles the website's own devscore collector and engine (`src/lib/devscore`)
 * plus its mapping to ghfind's `Scoring` (`src/lib/devscore-scoring.ts`), so
 * the score is computed exactly as the site computes it, on your machine, with
 * your GitHub token, without calling the ghfind server. No LLM is involved.
 *
 * devscore collects across GitHub (GraphQL + REST), ecosyste.ms and ClickHouse's
 * public GH Archive: minutes and thousands of GitHub calls for a large account.
 * Collected at a different moment than the site's snapshot, the numbers can
 * drift slightly from ghfind.com as the underlying data changes.
 *
 *   import { collectAndScore } from "@hikariming/ghfind/local";
 *   const r = await collectAndScore("torvalds", { token: process.env.GITHUB_TOKEN });
 *   console.log(r.scoring.final_score, r.devscore.v3.tier);
 *
 * Import it only when you want local scoring — the main entry stays a tiny
 * dependency-free remote client and never pulls this in.
 */

import {
  startCollect,
  stepCollect,
  type CollectPhase,
  type CollectStore,
} from "../../../src/lib/devscore/collect";
import { rateDeveloper } from "../../../src/lib/devscore/engine";
import { parseDeveloper } from "../../../src/lib/devscore/model";
import { devscoreSummary, scoringFromDevscore } from "../../../src/lib/devscore-scoring";
import { GhFindError } from "./client.js";
import type { DevscoreSummary, Scoring } from "./types.js";

/** Work budget of one collector step: a GitHub rate limit that resets later pauses the run. */
const STEP_MS = 30_000;

export interface LocalScore {
  /** Canonical GitHub login. */
  username: string;
  /** The devscore result behind `scoring` (v3 score/tier/flags, curve and engine factors). */
  devscore: DevscoreSummary;
  /** ghfind v11 scoring: `final_score` is the devscore v3 score; six display sub-scores. */
  scoring: Scoring;
}

export interface LocalProgress {
  /** Collector phase about to run ("user", "contribs", …, "assemble"). */
  phase: CollectPhase;
  /** Share of phases done, 0..1. */
  progress: number;
  /** Set while every token is rate-limited: epoch ms the run resumes at. */
  waitUntil: number | null;
}

export interface LocalScanOptions {
  /** GitHub token(s) for the crawl; a comma-separated pool rotates. Falls back to
   * `process.env.GITHUB_TOKEN`. Required: the collector makes many authenticated calls. */
  token?: string;
  /** Called before each collector step. */
  onProgress?: (p: LocalProgress) => void;
  /** Collector diagnostics (HTTP retries, rate limits, phase timings). */
  log?: (msg: string) => void;
  /** Custom fetch (tests / proxies). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Rate a devscore contract-v15 developer JSON (e.g. from the devscore collector). Pure; no I/O. */
export function scoreDeveloper(developer: unknown): LocalScore {
  const dev = parseDeveloper(developer);
  const summary = devscoreSummary(dev, rateDeveloper(dev));
  return { username: dev.login, devscore: summary, scoring: scoringFromDevscore(summary) };
}

/** A process-local store: HTTP answers and phase outputs of this run. */
function memoryStore(): CollectStore {
  const entries = new Map<string, string>();
  return {
    async get<T>(key: string): Promise<T | null> {
      const raw = entries.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    async put(key: string, value: unknown): Promise<void> {
      entries.set(key, JSON.stringify(value));
    },
  };
}

/**
 * Collect the account with the devscore collector and score it locally.
 * Throws {@link GhFindError} with code `github_token_required` without a token
 * and `account_not_found` for a nonexistent login.
 */
export async function collectAndScore(username: string, opts: LocalScanOptions = {}): Promise<LocalScore> {
  const tokens = (opts.token ?? process.env.GITHUB_TOKEN ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new GhFindError(
      "collectAndScore needs a GitHub token: pass { token } or set GITHUB_TOKEN. " +
        "devscore makes many authenticated GitHub API calls.",
      { code: "github_token_required" },
    );
  }
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const env = {
    fetch: ((input, init) => fetchImpl(input, init)) as typeof fetch,
    githubTokens: tokens,
    store: memoryStore(),
    now: Date.now,
    log: opts.log,
  };
  let state = startCollect(username);
  for (;;) {
    opts.onProgress?.({ phase: state.phase, progress: state.progress, waitUntil: state.waitUntil });
    if (state.waitUntil !== null && state.waitUntil > Date.now()) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, state.waitUntil - Date.now());
      await promise;
    }
    let step;
    try {
      step = await stepCollect(state, env, Date.now() + STEP_MS);
    } catch (error) {
      if (error instanceof Error && /^user .+ not found$/i.test(error.message)) {
        throw new GhFindError(`GitHub user "${username}" does not exist`, { status: 404, code: "account_not_found" });
      }
      throw error;
    }
    if (step.done) return scoreDeveloper(step.developer);
    state = step.state;
  }
}
