/**
 * Durable v13 generation. RoastJob's alarm calls this through
 * RoastContinueEntrypoint. The browser request only attaches, so closing the
 * page does not cancel the chain. The report is written with the same
 * persistence path as an interactive roast.
 */
import { createHash, randomUUID } from "node:crypto";
import { ROAST_CACHE_VERSION } from "./cache-version";
import {
  getCanonicalScoreWriteIdentity,
  getCurrentCanonicalQuickScan,
} from "./db";
import { normLang, type Lang } from "./lang";
import { defaultLlmConfig, fallbackLlmConfig, LlmQuotaError } from "./llm";
import { getCachedScan } from "./redis";
import { roastJob } from "./roast-job";
import { runV13Chain, V13_CHAIN_BUDGET_MS } from "./roast-handler";
import type { ScanResult } from "./types";

export type RoastContinueStatus =
  | "persisted"
  | "owner_mismatch"
  | "already_finished"
  | "no_job"
  | "no_scan"
  | "no_llm"
  | "failed";

function scanOf(canonical: { scan: ScanResult } | null, cached: ScanResult | null): ScanResult | null {
  return canonical?.scan ?? cached;
}

export async function continueRoastJob(
  username: string,
  langRaw: string,
  owner: string,
): Promise<{ ok: boolean; status: RoastContinueStatus }> {
  const lang: Lang = normLang(langRaw);
  const job = roastJob(username, lang);
  if (!job) return { ok: false, status: "no_job" };
  const currentOwner = await job.owner();
  if (!currentOwner || currentOwner !== owner) return { ok: false, status: "owner_mismatch" };
  const record = await job.status();
  if (!record || record.state !== "running") return { ok: true, status: "already_finished" };

  const [canonical, cached] = await Promise.all([
    getCurrentCanonicalQuickScan(username),
    getCachedScan(username),
  ]);
  const scan = scanOf(canonical, cached);
  if (!scan?.metrics || !scan.scoring) {
    await job.finish(false, "missing_scan").catch(() => {});
    return { ok: false, status: "no_scan" };
  }
  const snapshotHash =
    canonical?.snapshotHash ?? createHash("sha256").update(JSON.stringify(scan)).digest("hex");
  const scoreIdentity = await getCanonicalScoreWriteIdentity(username, snapshotHash).catch(() => null);
  const config = defaultLlmConfig();
  if (!config) {
    await job.finish(false, "no_llm").catch(() => {});
    return { ok: false, status: "no_llm" };
  }
  const fallback = fallbackLlmConfig();
  const startedAt = record.startedAt;
  try {
    await runV13Chain({
      scan,
      lang,
      username,
      snapshotHash,
      scoreIdentity,
      llmConfigs: fallback ? [config, fallback] : [config],
      deadlineMs: startedAt + V13_CHAIN_BUDGET_MS,
      requestId: randomUUID(),
      onStage: (label) => {
        void job.note(label).catch(() => {});
      },
    });
    await job.finish(true).catch(() => {});
    return { ok: true, status: "persisted" };
  } catch (error) {
    if (error instanceof LlmQuotaError) {
      await job.finish(false, "quota").catch(() => {});
      return { ok: false, status: "failed" };
    }
    // The attached request falls back to v12. Do not start another v13 chain.
    await job.abandon("v13_failed").catch(() => {});
    return { ok: false, status: "failed" };
  }
}

/** Exposed so a log line can name the roast release this continuation writes. */
export const roastContinueRelease = ROAST_CACHE_VERSION;
