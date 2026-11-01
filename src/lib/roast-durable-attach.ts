/**
 * Attach a foreground roast request to the one durable v13 job for this
 * profile and language. Generation itself runs on the RoastJob alarm; this
 * loop only relays progress and the persisted report. Past the interactive
 * attach budget the job is abandoned and the caller falls back to v12; the
 * Durable Object chain may still finish in the background under the longer
 * chain budget.
 */
import type { Lang } from "./lang";
import type { RoastMeta, Tags, Tier } from "./types";
import type { RoastLine } from "./types";

const FRAME = "\x1f";

export interface DurableJob {
  claim(username: string, lang: string): Promise<{
    job: { startedAt: number; stage: string; state: string };
    started: boolean;
    binding: boolean;
  }> | {
    job: { startedAt: number; stage: string; state: string };
    started: boolean;
    binding: boolean;
  };
  status(): Promise<{ state: string; stage: string; fallback: "v12" | null; reason?: string } | null> | {
    state: string;
    stage: string;
    fallback: "v12" | null;
    reason?: string;
  } | null;
  abandon(reason: string): Promise<unknown> | unknown;
}

export interface CachedRoastView {
  report: string;
  snapshot_hash?: string;
  final_score?: number;
  tier?: Tier;
  tags?: Tags;
  roast_line?: RoastLine;
}

export type DurableAttach =
  | { kind: "done"; report: string; meta: RoastMeta }
  | { kind: "fallback"; reason: string };

export async function attachDurableRoast(input: {
  job: DurableJob;
  enc: TextEncoder;
  push: (bytes: Uint8Array) => void;
  beat: (label: string, force?: boolean) => void;
  lang: Lang;
  username: string;
  snapshotHash: string;
  deadlineMs: number;
  readCached: (username: string, lang: Lang) => Promise<CachedRoastView | null>;
  metaFor: (
    score: number,
    tier: Tier,
    tags: Tags,
    line: RoastLine,
    lang: Lang,
  ) => Promise<RoastMeta>;
  matchesLang: (report: string, lang: Lang) => boolean;
  sleep?: (ms: number) => Promise<void>;
}): Promise<DurableAttach> {
  const wait = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const claim = await input.job.claim(input.username, input.lang);
  const startedAt = claim.job.startedAt;
  input.push(input.enc.encode(FRAME + "S" + String(Math.floor(startedAt)) + "\n"));
  if (claim.job.stage) input.beat(claim.job.stage, true);
  else input.beat(input.lang === "en" ? "Writing roast…" : "正在撰写锐评…", true);
  if (claim.started && !claim.binding) {
    // Nothing will run the alarm. Drop the record so the next request does not
    // wait out the budget on a job that has no producer.
    await input.job.abandon("no_roast_job_binding");
    return { kind: "fallback", reason: "no_roast_job_binding" };
  }

  const cachedReport = async (): Promise<DurableAttach | null> => {
    const cached = await input.readCached(input.username, input.lang);
    if (!cached?.snapshot_hash || cached.snapshot_hash !== input.snapshotHash) return null;
    if (!input.matchesLang(cached.report, input.lang)) return null;
    if (cached.final_score === undefined || !cached.tier) return null;
    const meta = await input.metaFor(
      cached.final_score,
      cached.tier,
      cached.tags ?? { zh: [], en: [] },
      cached.roast_line ?? { zh: "", en: "" },
      input.lang,
    );
    return { kind: "done", report: cached.report, meta };
  };

  let lastStage = claim.job.stage;
  while (Date.now() < input.deadlineMs) {
    await wait(1_000);
    const status = await input.job.status();
    if (status?.stage && status.stage !== lastStage) {
      lastStage = status.stage;
      input.beat(status.stage, true);
    }
    if (status?.state === "failed" && status.fallback === "v12") {
      return { kind: "fallback", reason: status.reason ?? "v13_abandoned" };
    }
    const ready = await cachedReport();
    if (ready) return ready;
    if (status && status.state !== "running") break;
  }
  const late = await cachedReport();
  if (late) return late;
  await input.job.abandon("v13_budget");
  return { kind: "fallback", reason: "v13_budget" };
}
