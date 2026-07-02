import { NextRequest, NextResponse } from "next/server";
import { TIER_EN, TIER_LABEL_EN } from "@/lib/badge";
import { getArchivedRoast, getRank, recordProfileSnapshot, recordScore, updateRoast } from "@/lib/db";
import { Lang, normLang } from "@/lib/lang";
import {
  LlmConfig,
  LlmQuotaError,
  LlmTimeoutError,
  chatStreamEventsWithFallback,
  defaultLlmConfig,
  fallbackLlmConfig,
} from "@/lib/llm";
import { beatPercent } from "@/lib/percentile";
import { buildRoastJudgeMessages, buildRoastMessages } from "@/lib/prompt";
import { reportMatchesLang } from "@/lib/report";
import { sanitizeIdentityClaims } from "@/lib/identity";
import {
  acquireRoastLock,
  checkRoastRateLimit,
  getCachedRoast,
  getCachedRoastJudge,
  getCachedScan,
  releaseRoastLock,
  setCachedRoast,
  setCachedRoastJudge,
  waitForCachedRoast,
} from "@/lib/redis";
import { clampScore, spamBotScore, tierFor } from "@/lib/score";
import type { RoastJudgeResult, RoastLine, RoastMeta, ScanResult, Tags, Tier } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Two sequential LLM calls (judge → roast) plus the streamed report. The default
// model is a reasoning model that spends 10–25s on chain-of-thought before any
// visible content, and a heavy account's two passes legitimately run ~60–120s.
// We cap the function at 120s (fail-fast: a genuinely stuck roast releases its
// slot quickly instead of hogging it) and bound the LLM passes a touch under
// that (`llmDeadlineMs`) so we fail gracefully here (roast_failed) instead of the
// platform 504'ing. Keep the two in sync: the inner budget MUST stay below this.
export const maxDuration = 120;

/** Response header carrying the AI-adjusted score (base64'd JSON; it contains CJK). */
const ROAST_META_HEADER = "X-Roast-Meta";

const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
const EMPTY_ROAST_LINE: RoastLine = { zh: "", en: "" };
const DEFAULT_JUDGE_LANG: Lang = "zh";

interface ByoKey {
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

interface RoastBody {
  scan?: ScanResult;
  byoKey?: ByoKey;
  /** UI locale → report language. Defaults to zh (see {@link normLang}). */
  lang?: string;
}

/** Map a thrown LLM error to a coarse failure kind for the triage log. */
function classifyLlmError(e: unknown): "timeout" | "quota" | "upstream" | "other" {
  if (e instanceof LlmTimeoutError) return "timeout";
  if (e instanceof LlmQuotaError) return "quota";
  const msg = e instanceof Error ? e.message : String(e);
  if (/^LLM (error \d|request failed)/.test(msg)) return "upstream";
  return "other";
}

/** One structured line per roast (success or failure) for prod triage. Failure
 *  rows carry the stage (judge|writer|meta|stream) and kind (timeout|quota|
 *  upstream|other) so we can tell a slow-LLM timeout from an upstream 5xx from a
 *  parse miss without reading code. Never let logging throw into the roast path. */
function logRoastSummary(fields: Record<string, unknown>): void {
  try {
    console.log("roast.summary", JSON.stringify(fields));
  } catch {
    /* ignore */
  }
}

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
}

function resolveConfig(byo?: ByoKey): { config: LlmConfig; isDefault: boolean } | null {
  if (byo?.apiKey && byo.baseURL && byo.model) {
    return { config: { baseURL: byo.baseURL, apiKey: byo.apiKey, model: byo.model }, isDefault: false };
  }
  const config = defaultLlmConfig();
  return config ? { config, isDefault: true } : null;
}

/** Parse `@@ADJUST <int>@@` from the model's leading line; clamp to [-10, 10]. */
function parseDelta(head: string): number {
  const m = head.match(/@@ADJUST\s*([+-]?\d+(?:\.\d+)?)\s*@@/);
  if (!m) return 0;
  const n = Math.round(parseFloat(m[1]));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-10, Math.min(10, n));
}

/** Parse the `@@TAGS zh=...|en=...@@` control line into clean, capped tag lists. */
function parseTags(head: string): Tags {
  const m = head.match(/@@TAGS\s*([^@]*?)@@/);
  if (!m) return { zh: [], en: [] };
  const body = m[1];
  const grab = (key: string): string[] => {
    const mm = body.match(new RegExp(`${key}=([^|@]+)`));
    if (!mm) return [];
    return mm[1].split(/[,，、]/).map((t) => t.trim());
  };
  const clean = (arr: string[], maxLen: number): string[] =>
    Array.from(
      new Set(
        arr
          .map((t) => t.replace(/[#@]/g, "").trim())
          .filter(Boolean)
          .map((t) => t.slice(0, maxLen)),
      ),
    ).slice(0, 5);
  return { zh: clean(grab("zh"), 10), en: clean(grab("en"), 24) };
}

/**
 * Parse the `@@ROAST zh=...|en=...@@` control line into the bilingual one-liner.
 * Unlike {@link parseTags} this must NOT split on commas — a roast sentence
 * contains commas and CJK punctuation. `zh` runs up to the `|`; `en` to the end.
 */
function parseRoast(head: string): RoastLine {
  const m = head.match(/@@ROAST\s*([\s\S]*?)@@/);
  if (!m) return { zh: "", en: "" };
  const body = m[1];
  const grab = (key: string): string => {
    const mm = body.match(new RegExp(`${key}=([\\s\\S]*?)(?=\\||$)`));
    return (mm?.[1] ?? "").trim().slice(0, 200);
  };
  return { zh: grab("zh"), en: grab("en") };
}

/** Strip the leading control lines so they never reach the rendered report. */
function extractReport(head: string): string {
  const lines = head.split("\n");
  const idx = lines.findIndex((l) => /^\s*##\s/.test(l));
  if (idx >= 0) return lines.slice(idx).join("\n");
  // No heading found (model ignored format) — just drop any control lines.
  return lines.filter((l) => !/@@(ADJUST|TAGS|ROAST)/.test(l)).join("\n").replace(/^\n+/, "");
}

function parseJudgeResult(raw: string, scan: ScanResult, lang: Lang): RoastJudgeResult {
  const fallback: RoastJudgeResult = {
    delta: 0,
    reason: lang === "en" ? "Judge output was not parseable." : "judge 输出无法解析。",
    verdict: lang === "en" ? "normal" : "正常",
    risk_notes: [],
  };
  const scoreSummary = (delta: number) => {
    const summary = adjustedScoreSummary(scan, delta, lang);
    return {
      ...summary,
      tier: lang === "en" ? TIER_EN[summary.tier] : summary.tier,
    };
  };
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) return { ...fallback, ...scoreSummary(0) };

  try {
    const parsed = JSON.parse(jsonText) as Partial<RoastJudgeResult>;
    const n = Math.round(Number(parsed.delta ?? 0));
    const delta = Number.isFinite(n) ? Math.max(-10, Math.min(10, n)) : 0;
    const summary = scoreSummary(delta);
    return {
      delta: summary.delta,
      reason: String(parsed.reason ?? fallback.reason).slice(0, 500),
      verdict: String(parsed.verdict ?? fallback.verdict).slice(0, 120),
      risk_notes: Array.isArray(parsed.risk_notes)
        ? parsed.risk_notes.map((n) => String(n).slice(0, 240)).slice(0, 6)
        : [],
      final_score: summary.final_score,
      tier: summary.tier,
      tier_label: summary.tier_label,
    };
  } catch {
    return { ...fallback, ...scoreSummary(0) };
  }
}

function localizeJudgeResult(judge: RoastJudgeResult, scan: ScanResult, lang: Lang): RoastJudgeResult {
  const summary = adjustedScoreSummary(scan, judge.delta, lang);
  return {
    ...judge,
    delta: summary.delta,
    final_score: summary.final_score,
    tier: lang === "en" ? TIER_EN[summary.tier] : summary.tier,
    tier_label: summary.tier_label,
  };
}

/** Bound a client-supplied scan so a fabricated payload can't bloat the prompt. */
function sanitizeScan(scan: ScanResult): ScanResult {
  return {
    metrics: scan.metrics,
    top_repos: (scan.top_repos ?? []).slice(0, 10).map((r) => {
      const promptSummary = r.readme?.features?.prompt_summary;
      return {
        ...r,
        description: r.description?.slice(0, 300) ?? null,
        readme_excerpt: r.readme_excerpt?.slice(0, 1500) ?? null,
        readme:
          typeof promptSummary === "string" && r.readme
            ? {
                ...r.readme,
                features: {
                  ...r.readme.features,
                  prompt_summary: promptSummary.slice(0, 1500),
                },
              }
            : undefined,
      };
    }),
    recent_prs: (scan.recent_prs ?? []).slice(0, 50).map((p) => ({
      ...p,
      title: p.title?.slice(0, 200) ?? null,
      files: (p.files ?? []).slice(0, 20).map((f) => f.slice(0, 200)),
    })),
    flood_pr_titles: (scan.flood_pr_titles ?? []).slice(0, 5).map((t) => t.slice(0, 200)),
    impact_repos: (scan.impact_repos ?? []).slice(0, 8),
    verified_impact_prs: (scan.verified_impact_prs ?? []).slice(0, 12).map((p) => ({
      ...p,
      title: p.title?.slice(0, 200) ?? null,
      files: (p.files ?? []).slice(0, 20).map((f) => f.slice(0, 200)),
    })),
    scoring: scan.scoring,
  };
}

function metaHeader(meta: RoastMeta): string {
  return Buffer.from(JSON.stringify(meta), "utf-8").toString("base64");
}

function roastResponse(body: ReadableStream<Uint8Array> | string, meta: RoastMeta): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      [ROAST_META_HEADER]: metaHeader(meta),
    },
  });
}

/** Deterministic (pre-LLM) meta for the streaming response's header. The header
 *  must be sent before the body, but the AI-adjusted score/tags/roast aren't
 *  known until after generation — so the header carries the script's own score
 *  (a safe fallback) and the real values arrive later as an in-band M-frame. */
function deterministicMeta(scan: ScanResult, lang: Lang): RoastMeta {
  const { tier, tier_label: zhLabel } = tierFor(scan.scoring.final_score);
  const tier_label = lang === "en" ? TIER_LABEL_EN[tier] : zhLabel;
  return {
    final_score: scan.scoring.final_score,
    tier,
    tier_label,
    delta: 0,
    percentile: null,
    tags: { zh: [], en: [] },
    roast_line: EMPTY_ROAST_LINE,
  };
}

// In-band control protocol for the streamed generate path. Frames are single
// lines prefixed with US (\x1f, never produced by the model/markdown) and end
// with \n: `T`=thinking/progress label, `M`=base64 RoastMeta (ends the control
// phase; everything after is report markdown), `E`=JSON error. The cached/replay
// fast paths send plain report bytes with no frames, which the client also handles.
const FRAME = "\x1f";
function thinkingFrame(enc: TextEncoder, text: string): Uint8Array {
  return enc.encode(FRAME + "T" + text.replace(/\s+/g, " ").trim().slice(0, 80) + "\n");
}
function metaFrame(enc: TextEncoder, meta: RoastMeta): Uint8Array {
  return enc.encode(FRAME + "M" + metaHeader(meta) + "\n");
}
function errorFrame(enc: TextEncoder, obj: unknown): Uint8Array {
  return enc.encode(FRAME + "E" + JSON.stringify(obj) + "\n");
}

function adjustedScoreSummary(
  scan: ScanResult,
  delta: number,
  lang: Lang,
): Pick<RoastMeta, "final_score" | "tier" | "tier_label" | "delta"> {
  const requested = clampScore(scan.scoring.final_score + delta);
  const cap = adjustedScoreCap(scan);
  const adjusted = clampScore(
    cap !== null && delta > 0 && requested > cap
      ? Math.max(scan.scoring.final_score, cap)
      : requested,
  );
  const effectiveDelta = Math.round((adjusted - scan.scoring.final_score) * 100) / 100;
  const { tier, tier_label: zhLabel } = tierFor(adjusted);
  const tier_label = lang === "en" ? TIER_LABEL_EN[tier] : zhLabel;
  return { final_score: adjusted, tier, tier_label, delta: effectiveDelta };
}

function adjustedScoreCap(scan: ScanResult): number | null {
  if (
    scan.metrics.impact_quality_cap !== undefined &&
    scan.metrics.impact_quality_cap <= 4 &&
    scan.metrics.impact_pr_count >= 10
  ) {
    return 60;
  }
  return null;
}

/** Adjusted score + tier + fresh percentile. Records to the leaderboard only on a
 * fresh (non-replayed) default-model roast. */
async function computeMeta(
  scan: ScanResult,
  delta: number,
  tags: Tags,
  roastLine: RoastLine,
  record: boolean,
  lang: Lang,
): Promise<RoastMeta> {
  const summary = adjustedScoreSummary(scan, delta, lang);
  if (record) {
    await recordScore({
      username: scan.metrics.username,
      display_name: scan.metrics.name,
      avatar_url: scan.metrics.avatar_url,
      profile_url: scan.metrics.profile_url,
      final_score: summary.final_score,
      tier: summary.tier,
      tags,
      roast_line: roastLine,
      bot_score: spamBotScore(scan.metrics),
      sub_scores: scan.scoring.sub_scores,
      scanned_at: Date.now(),
    });
    // Sediment the raw developer profile (the data moat) alongside the score.
    // Fire-and-forget inside recordProfileSnapshot; never blocks the roast.
    await recordProfileSnapshot(scan);
  }
  const percentile = await percentileFor(summary.final_score);
  return { ...summary, percentile, tags, roast_line: roastLine };
}

async function percentileFor(score: number): Promise<RoastMeta["percentile"]> {
  const counts = await getRank(score);
  return counts
    ? { beat: beatPercent(counts.below, counts.total), total: counts.total, rank: counts.rank }
    : null;
}

/** Meta for a replayed (stored) roast — score/tier come from storage, not a fresh
 * scan, so percentile is the only DB read. */
async function metaForStoredRoast(
  finalScore: number,
  tier: Tier,
  tags: Tags,
  roastLine: RoastLine,
  delta: number,
  lang: Lang,
): Promise<RoastMeta> {
  const { tier_label: zhLabel } = tierFor(finalScore);
  const tier_label = lang === "en" ? TIER_LABEL_EN[tier] : zhLabel;
  const percentile = await percentileFor(finalScore);
  return { final_score: finalScore, tier, tier_label, delta, percentile, tags, roast_line: roastLine };
}

function inferredDelta(scan: ScanResult, finalScore: number): number {
  return Math.round((finalScore - scan.scoring.final_score) * 100) / 100;
}

async function cacheRoastReplay(
  username: string,
  lang: Lang,
  report: string,
  delta: number,
  tags: Tags,
  roastLine: RoastLine,
  finalScore: number,
  tier: Tier,
): Promise<void> {
  await setCachedRoast(username, lang, {
    report,
    delta,
    tags,
    roast_line: roastLine,
    final_score: finalScore,
    tier,
  });
}

export async function POST(req: NextRequest) {
  let body: RoastBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const username = body.scan?.metrics?.username;
  if (!username || !USERNAME_RE.test(username)) {
    return NextResponse.json({ error: "missing_scan" }, { status: 400 });
  }

  const lang = normLang(body.lang);

  const resolved = resolveConfig(body.byoKey);
  if (!resolved) {
    return NextResponse.json({ error: "no_llm_configured", useByoKey: true }, { status: 400 });
  }
  const { config, isDefault } = resolved;
  // Default path fails over to the operator's fallback provider (DeepSeek) when
  // the primary drops/queues the connection before any answer text. BYO keys
  // never fail over — the user supplied a single key and pays their own way.
  const fallback = isDefault ? fallbackLlmConfig() : null;
  const llmConfigs = fallback ? [config, fallback] : [config];
  // Single-flight: set once we hold the roast lock, so the stream/error paths
  // know to release it. Only the default model coalesces (BYO keys self-serve).
  let isLeader = false;

  // Prefer the server's cached scan (authoritative — the client cannot fabricate
  // metrics to inflate the prompt or the score). Fall back to the sanitized
  // client scan when there is no cache (e.g. Redis unconfigured).
  const cachedScan = await getCachedScan(username);
  const scan = cachedScan ?? (body.scan ? sanitizeScan(body.scan) : null);
  if (!scan?.metrics || !scan.scoring) {
    return NextResponse.json({ error: "missing_scan" }, { status: 400 });
  }

  // Default-model protections: serve a cached roast for free, else rate-limit the
  // (credit-spending) LLM call. BYO keys skip both — it's the user's own credit.
  if (isDefault) {
    const cachedRoast = await getCachedRoast(username, lang);
    if (cachedRoast && reportMatchesLang(cachedRoast.report, lang)) {
      const tags = cachedRoast.tags ?? { zh: [], en: [] };
      const roastLine = cachedRoast.roast_line ?? EMPTY_ROAST_LINE;
      const meta =
        cachedRoast.final_score !== undefined && cachedRoast.tier
          ? await metaForStoredRoast(
              cachedRoast.final_score,
              cachedRoast.tier,
              tags,
              roastLine,
              cachedRoast.delta,
              lang,
            )
          : await computeMeta(scan, cachedRoast.delta, tags, roastLine, false, lang);
      return roastResponse(cachedRoast.report, meta);
    }

    const archivedRoast = await getArchivedRoast(username, lang);
    if (archivedRoast && reportMatchesLang(archivedRoast.report, lang)) {
      const delta = inferredDelta(scan, archivedRoast.final_score);
      const meta = await metaForStoredRoast(
        archivedRoast.final_score,
        archivedRoast.tier,
        archivedRoast.tags,
        archivedRoast.roast_line,
        delta,
        lang,
      );
      await cacheRoastReplay(
        username,
        lang,
        archivedRoast.report,
        delta,
        archivedRoast.tags,
        archivedRoast.roast_line,
        archivedRoast.final_score,
        archivedRoast.tier,
      );
      return roastResponse(archivedRoast.report, meta);
    }

    const { success } = await checkRoastRateLimit(clientIp(req));
    if (!success) {
      return NextResponse.json(
        { error: "rate_limited", useByoKey: true },
        { status: 429 },
      );
    }
    // Single-flight: become the lone generator, or wait for whoever already is.
    // Collapses a viral account's concurrent cold-cache requests into ONE LLM call.
    isLeader = await acquireRoastLock(username, lang);
    if (!isLeader) {
      const shared = await waitForCachedRoast(username, lang);
      if (shared && reportMatchesLang(shared.report, lang)) {
        const tags = shared.tags ?? { zh: [], en: [] };
        const roastLine = shared.roast_line ?? EMPTY_ROAST_LINE;
        const meta =
          shared.final_score !== undefined && shared.tier
            ? await metaForStoredRoast(
                shared.final_score,
                shared.tier,
                tags,
                roastLine,
                shared.delta,
                lang,
              )
            : await computeMeta(scan, shared.delta, tags, roastLine, false, lang);
        return roastResponse(shared.report, meta);
      }
      // Leader failed or timed out — self-generate (we hold no lock).
    }
  }

  // Stream from the very first byte. The default model is a reasoning model that
  // spends 10–25s "thinking" before any visible content, and we run TWO passes
  // (cold judge → savage writer); the old code awaited both fully before sending
  // anything, so the user stared at a frozen spinner the whole time. Now we open
  // the response immediately and push live progress (T-frames) during the wait,
  // then the AI-adjusted meta (M-frame), then the report — same two-pass logic,
  // same quality, no frozen wait.
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let clientGone = false;
      const push = (bytes: Uint8Array) => {
        if (clientGone) return;
        try {
          controller.enqueue(bytes);
        } catch {
          clientGone = true;
        }
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          // already closed (client gone)
        }
      };
      // Surface "still working" without leaking the model's chain-of-thought:
      // a curated stage label plus elapsed seconds, throttled so reasoning's
      // hundreds of deltas don't spam the wire.
      const t0 = Date.now();
      // Hard wall-clock budget for the LLM passes, kept ~15s under the 120s
      // function ceiling (leaving room for meta compute + caching + margin). The
      // default reasoning model streams chain-of-thought continuously, so the
      // per-token idle timeout never fires on a long think; this caps the TWO
      // passes combined so a slow account fails gracefully here (roast_failed)
      // instead of the platform 504'ing the whole function.
      const llmDeadlineMs = t0 + 105_000;
      // Per-stage timings for the structured triage log (see logRoastSummary).
      const path = isDefault ? "default" : "byo";
      let judgeMs = 0;
      let writerStart = 0;
      let lastBeat = 0;
      const beat = (label: string, force = false) => {
        const now = Date.now();
        if (!force && now - lastBeat < 1500) return;
        lastBeat = now;
        const secs = Math.round((now - t0) / 1000);
        push(thinkingFrame(enc, `${label} (${secs}s)`));
      };
      const calibrating = lang === "en" ? "Calibrating score…" : "正在校准评分…";
      const writing = lang === "en" ? "Writing the roast…" : "正在撰写锐评…";
      const failAndClose = async (obj: unknown) => {
        // Release the single-flight lock so waiting requests aren't stalled for
        // the full lock TTL by a generation that died early.
        if (isLeader) await releaseRoastLock(username, lang);
        push(errorFrame(enc, obj));
        close();
      };

      // 1) Cold judge pass (score calibration). Reasoning → calibrating heartbeat.
      let judge: RoastJudgeResult;
      try {
        const cachedJudge = isDefault ? await getCachedRoastJudge(username) : null;
        if (cachedJudge && cachedJudge.base_score === scan.scoring.final_score) {
          judge = localizeJudgeResult(cachedJudge.judge, scan, lang);
        } else {
          beat(calibrating, true);
          const judgeLang = isDefault ? DEFAULT_JUDGE_LANG : lang;
          let judgeText = "";
          for await (const ev of chatStreamEventsWithFallback(llmConfigs, buildRoastJudgeMessages(scan, judgeLang), {
            deadlineMs: llmDeadlineMs,
          })) {
            if (ev.type === "content") {
              judgeText += ev.text;
              if (judgeText.length >= 12000) break;
            } else {
              beat(calibrating);
            }
          }
          judge = parseJudgeResult(judgeText, scan, lang);
          if (isDefault) {
            await setCachedRoastJudge(username, {
              base_score: scan.scoring.final_score,
              judge,
            });
          }
        }
        judgeMs = Date.now() - t0;
      } catch (e) {
        logRoastSummary({
          u: username, lang, path, ok: false, stage: "judge",
          kind: classifyLlmError(e), judgeMs: Date.now() - t0,
        });
        if (e instanceof LlmQuotaError) {
          return failAndClose({ error: "llm_quota", useByoKey: true, status: e.status });
        }
        console.error("roast judge failed:", e);
        return failAndClose({ error: "roast_failed" });
      }

      // 2) Savage writer pass. Read the leading control lines (@@ADJUST@@ /
      // @@TAGS@@ / @@ROAST@@) up to the report heading; reasoning → writing beat.
      beat(writing, true);
      writerStart = Date.now();
      const events = chatStreamEventsWithFallback(llmConfigs, buildRoastMessages(scan, lang, judge), {
        deadlineMs: llmDeadlineMs,
      });
      let head = "";
      try {
        while (!/(^|\n)\s*##\s/.test(head) && head.length < 2000) {
          const { done, value } = await events.next();
          if (done) break;
          if (value.type === "content") head += value.text;
          else beat(writing);
        }
      } catch (e) {
        logRoastSummary({
          u: username, lang, path, ok: false, stage: "writer",
          kind: classifyLlmError(e), judgeMs, writerMs: Date.now() - writerStart,
          head: head.slice(0, 200),
        });
        if (e instanceof LlmQuotaError) {
          return failAndClose({ error: "llm_quota", useByoKey: true, status: e.status });
        }
        console.error("roast failed:", e);
        return failAndClose({ error: "roast_failed" });
      }

      const parsedDelta = parseDelta(head);
      const delta = parsedDelta === judge.delta ? parsedDelta : judge.delta;
      const parsedTags = parseTags(head);
      const parsedRoastLine = parseRoast(head);
      const parsedReport = extractReport(head);
      const { tags, roastLine, report } = sanitizeIdentityClaims(
        scan,
        parsedTags,
        parsedRoastLine,
        parsedReport,
      );

      let meta: RoastMeta;
      try {
        meta = await computeMeta(scan, delta, tags, roastLine, isDefault, lang);
      } catch (e) {
        logRoastSummary({
          u: username, lang, path, ok: false, stage: "meta",
          judgeMs, writerMs: Date.now() - writerStart,
        });
        console.error("roast meta failed:", e);
        return failAndClose({ error: "roast_failed" });
      }

      // End of control phase: ship the AI-adjusted meta, then the report body.
      push(metaFrame(enc, meta));

      let full = report;
      try {
        if (report) push(enc.encode(report));
        // Drain the rest of the writer (resumes where head-reading left off).
        for await (const ev of events) {
          if (ev.type !== "content") continue;
          full += ev.text;
          push(enc.encode(ev.text));
        }
        // Cache the finished roast so repeat views don't re-spend LLM credit,
        // and persist it to the account row for the leaderboard detail view.
        if (isDefault && reportMatchesLang(full, lang)) {
          await cacheRoastReplay(
            username,
            lang,
            full,
            delta,
            tags,
            roastLine,
            meta.final_score,
            meta.tier,
          );
          await updateRoast(username, full, lang);
        }
        logRoastSummary({
          u: username, lang, path, ok: true,
          judgeMs, writerMs: Date.now() - writerStart, totalMs: Date.now() - t0,
          score: meta.final_score, delta, chars: full.length,
        });
      } catch (e) {
        logRoastSummary({
          u: username, lang, path, ok: false, stage: "stream",
          kind: classifyLlmError(e), judgeMs, writerMs: Date.now() - writerStart,
        });
        console.error("roast stream error:", e);
      } finally {
        if (isLeader) await releaseRoastLock(username, lang);
        close();
      }
    },
  });

  return roastResponse(stream, deterministicMeta(scan, lang));
}
