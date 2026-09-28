/**
 * In-process devscore scan for operator scripts: the same pipeline as the
 * background job (src/lib/devscore-jobs.ts) — display collection, the resumable
 * devscore collector run to completion, then `buildDevscoreScan` — without the
 * job table. The returned ScanResult carries the devscore summary and v11
 * scoring, ready for `publishCompleteQuickScan`.
 */
import { buildDevscoreScan } from "../src/lib/devscore-jobs";
import { startCollect, stepCollect, type CollectEnv } from "../src/lib/devscore/collect";
import { memoryCollectStore } from "../src/lib/devscore-store";
import { githubTokens } from "../src/lib/github";
import { parseDeveloper } from "../src/lib/devscore/model";
import { buildDisplayScan } from "../src/lib/scan-core";
import type { ScanResult } from "../src/lib/types";

const STEP_MS = 30_000;

export async function devscoreScan(login: string): Promise<ScanResult> {
  const display = await buildDisplayScan(login);
  const env: CollectEnv = {
    fetch: (input, init) => fetch(input, init),
    githubTokens: githubTokens(),
    store: memoryCollectStore(),
    now: Date.now,
    log: process.env.VERBOSE ? (msg) => console.log(`devscore.collect ${msg}`) : undefined,
  };
  let state = startCollect(display.metrics.username);
  for (;;) {
    if (state.waitUntil !== null && state.waitUntil > Date.now()) {
      await new Promise((resolve) => setTimeout(resolve, state.waitUntil! - Date.now()));
    }
    const step = await stepCollect(state, env, Date.now() + STEP_MS);
    if (step.done) return buildDevscoreScan(display, parseDeveloper(step.developer));
    state = step.state;
  }
}
