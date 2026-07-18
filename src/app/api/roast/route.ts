import { NextRequest, NextResponse } from "next/server";
import { checkBotId } from "botid/server";
import { TIER_LABEL_EN } from "@/lib/badge";
import { machineAuth } from "@/lib/machine-auth";
import { getArchivedRoast, getScoreScannedAt, recordProfileSnapshot, recordScore, updateRoast } from "@/lib/db";
import { getRankCached } from "@/lib/rank";
import { ROAST_FRESH_MS } from "@/lib/freshness";
import { Lang, normLang } from "@/lib/lang";
import {
  ChatAttemptEvent,
  LlmConfig,
  LlmQuotaError,
  LlmTimeoutError,
  chatStreamEventsWithFallback,
  defaultLlmConfig,
  fallbackLlmConfig,
} from "@/lib/llm";
import { beatPercent } from "@/lib/percentile";
import { buildRoastMessages } from "@/lib/prompt";
import { reportMatchesLang } from "@/lib/report";
import { sanitizeIdentityClaims } from "@/lib/identity";
import {
  getPublicScanStatus,
  publicScanAdmission,
  requiresDurablePublicScan,
  resolvePublicScanFromTrustedQuickScan,
  startPublicScan,
} from "@/lib/public-scan";
import { kickPublicScanDrain } from "@/lib/public-scan-dispatcher";
import {
  acquireRoastLock,
  checkRoastRateLimit,
  clearCachedRoast,
  getCachedRoast,
  getCachedScan,
  releaseRoastLock,
  setCachedRoast,
  waitForCachedRoast,
} from "@/lib/redis";
import { clampScore, spamBotScore, tierFor } from "@/lib/score";
import type { RoastLine, RoastMeta, ScanResult, Tags, Tier } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One LLM call performs factual calibration and writes the streamed report. The
// ceiling remains generous for provider failover, while the inner deadline keeps
// failures inside the in-band protocol instead of letting the platform 504.
// The ceiling is 240s (well under Vercel's 300s max) so a stalled primary can
// fail over to DeepSeek and STILL have a fresh budget to finish — the old 120s
// cap physically couldn't fit primary + fallback, so the fallback got ~0s and
// timed out. Fluid Compute bills active CPU,
// not the idle wait on the model, so the higher ceiling costs ~nothing. The LLM
// work is bounded a touch under this (`llmDeadlineMs`) so we fail gracefully here
// (roast_failed) instead of the platform 504'ing. Keep the inner budget below it.
export const maxDuration = 240;

/** Response header carrying the AI-adjusted score (base64'd JSON; it contains CJK). */
export const ROAST_META_HEADER = "X-Roast-Meta";

const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
const EMPTY_ROAST_LINE: RoastLine = { zh: "", en: "" };

interface ByoKey {
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

interface RoastBody {
  scan?: ScanResult;
  /** Bare handle when the client has no scan payload (profile-page live roast).
   * The route then relies on the server-side cached scan (getCachedScan). */
  username?: string;
  byoKey?: ByoKey;
  /** UI locale → report language. Defaults to zh (see {@link normLang}). */
  lang?: string;
  /** Ask to regenerate instead of replaying the cache/archive. Honored only when
   * the server confirms the stored roast is stale (scanned_at older than
   * ROAST_FRESH_MS) — otherwise ignored, so the flag can't burn LLM credit. */
  refresh?: boolean;
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
 *  rows carry the stage (generation|meta|stream) and kind (timeout|quota|
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
  const counts = await getRankCached(score);
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
  // Anchor for the LLM wall-clock budget. Deliberately taken at request start,
  // NOT at stream start: a single-flight follower can spend up to 120s in
  // waitForCachedRoast before falling back to self-generation, and a budget
  // computed from stream start would let wait + generation overrun the 240s
  // function ceiling — the platform then kills the stream mid-roast.
  const reqT0 = Date.now();
  let body: RoastBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const username = body.scan?.metrics?.username ?? body.username;
  if (!username || !USERNAME_RE.test(username)) {
    return NextResponse.json({ error: "missing_scan" }, { status: 400 });
  }

  // Human/agent gate, before any cache or LLM work — but ONLY for the paths that
  // spend the operator's LLM credit. Anonymous agents keep two open lanes: byoKey
  // (their own model, their own bill) and the Bearer key. Verified
  // crawlers/assistants (googlebot, chatgpt-user, claude…) pass as agents;
  // browsers must pass BotID's invisible human check. Only the impersonator
  // remainder — headless farms on rotating proxies — is refused, and the refusal
  // advertises the documented agent surface instead.
  const auth = machineAuth(req);
  if (auth === "invalid") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const lang = normLang(body.lang);

  const resolved = resolveConfig(body.byoKey);
  if (!resolved) {
    return NextResponse.json({ error: "no_llm_configured", useByoKey: true }, { status: 400 });
  }
  const { config, isDefault } = resolved;

  // The gate keys on the RESOLVED config, not on whether a byoKey field was
  // sent: an empty/partial byoKey (e.g. `byoKey: {}`) falls back to the
  // default config in resolveConfig, so checking `body.byoKey` here would let
  // it skip BotID and burn the operator's credit anyway.
  if (auth === "absent" && isDefault) {
    const verification = await checkBotId();
    if (verification.isBot && !verification.isVerifiedBot) {
      return NextResponse.json(
        {
          error: "bot_detected",
          hint: "Automated clients are welcome: use the documented API and MCP server at https://ghfind.com/docs (free, no headless browser required).",
        },
        { status: 403 },
      );
    }
  }
  // Default path fails over to the operator's fallback provider (DeepSeek) when
  // the primary drops/queues the connection before any answer text. BYO keys
  // never fail over — the user supplied a single key and pays their own way.
  const fallback = isDefault ? fallbackLlmConfig() : null;
  const llmConfigs = fallback ? [config, fallback] : [config];
  const path = isDefault ? "default" : "byo";
  // Single-flight: set once we hold the roast lock, so the stream/error paths
  // know to release it. Only the default model coalesces (BYO keys self-serve).
  let isLeader = false;
  let lockWaitMs = 0;
  let generationPath: "leader" | "follower_fallback" | "byo" = isDefault ? "leader" : "byo";

  // Prefer a durable/current server snapshot. The request body remains a
  // compatibility fallback for an immediate BYO roast, but it is never allowed
  // to seed durable facts or a future public-history scan.
  const [publicStatus, cachedScan] = await Promise.all([
    getPublicScanStatus(username),
    getCachedScan(username),
  ]);
  const completedPublicScan = publicStatus?.status === "complete" ? publicStatus.scan : null;
  const serverScan = completedPublicScan ?? cachedScan;
  let scan = serverScan ?? (body.scan ? sanitizeScan(body.scan) : null);
  if (!scan?.metrics || !scan.scoring) {
    return NextResponse.json({ error: "missing_scan" }, { status: 400 });
  }

  // A large public history cannot be truthfully represented by the quick
  // sample. Never spend LLM credit or persist a leaderboard row from it: start
  // (or resume) the durable collector and require its complete snapshot.
  if (!completedPublicScan && (publicStatus || requiresDurablePublicScan(scan))) {
    const durableAdmission = publicScanAdmission(
      auth === "valid"
        ? `bearer:${req.headers.get("authorization") ?? ""}`
        : `ip:${clientIp(req)}`,
    );
    const resolution = publicStatus && publicStatus.status !== "complete"
      ? publicStatus
      : serverScan
        ? await resolvePublicScanFromTrustedQuickScan(username, serverScan, durableAdmission)
        : await startPublicScan(username, durableAdmission);
    if (resolution.status === "complete") {
      scan = resolution.scan;
    } else {
      if (resolution.status === "pending") kickPublicScanDrain();
      const retryAfterSeconds = resolution.retryAfterSeconds;
      const busy = resolution.status === "queue_full" || resolution.status === "admission_limited";
      return NextResponse.json(
        {
          error: busy ? resolution.status : "scan_enrichment_pending",
          username,
          ...(resolution.status === "pending" ? { run_id: resolution.run.id } : {}),
          retry_after: retryAfterSeconds,
        },
        {
          status: busy ? 429 : 409,
          headers: { "Retry-After": String(retryAfterSeconds), "Cache-Control": "no-store" },
        },
      );
    }
  }

  // Default-model protections: serve a cached roast for free, else rate-limit the
  // (credit-spending) LLM call. BYO keys skip both — it's the user's own credit.
  if (isDefault) {
    // A validated `refresh` (homepage handoff onto a stale profile, or the
    // owner's rescan) skips both replay paths below and regenerates. Server-
    // checked against the row's scanned_at — without this, the DB archive
    // replays a version-matched roast forever, no matter its age.
    let refreshHonored = false;
    if (body.refresh === true) {
      const scannedAt = await getScoreScannedAt(username);
      refreshHonored = scannedAt == null || Date.now() - scannedAt > ROAST_FRESH_MS;
    }

    if (!refreshHonored) {
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
        logRoastSummary({
          u: username, lang, path, ok: true, source: "redis_cache",
          requestTotalMs: Date.now() - reqT0,
        });
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
        logRoastSummary({
          u: username, lang, path, ok: true, source: "archive",
          requestTotalMs: Date.now() - reqT0,
        });
        return roastResponse(archivedRoast.report, meta);
      }
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
    if (isLeader) {
      // Regeneration leader: drop the (possibly archive-re-warmed) cached roast
      // so single-flight followers wait for the NEW report, not the old one.
      if (refreshHonored) await clearCachedRoast(username, lang);
    } else {
      const lockWaitStartedAt = Date.now();
      const shared = await waitForCachedRoast(username, lang);
      lockWaitMs = Date.now() - lockWaitStartedAt;
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
        logRoastSummary({
          u: username, lang, path, ok: true, source: "singleflight_shared",
          lockWaitMs, requestTotalMs: Date.now() - reqT0,
        });
        return roastResponse(shared.report, meta);
      }
      // Leader failed or timed out — self-generate (we hold no lock).
      generationPath = "follower_fallback";
    }
  }

  // One model stream performs factual calibration and writes the report. Progress
  // frames keep the client alive while the reasoning model prepares its controls.
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
      // Overall hard wall-clock ceiling for ALL LLM work, kept ~20s under the
      // 240s function ceiling (leaving room for meta DB writes + caching + margin).
      // The default reasoning model streams chain-of-thought continuously, so the
      // per-token idle timeout never fires on a long think; this caps everything
      // combined so a slow account fails gracefully here (roast_failed) instead of
      // the platform 504'ing the whole function. Anchored to reqT0 (request
      // start), not t0: a follower that waited out the single-flight window has
      // already spent that time against the same 240s function ceiling.
      const llmDeadlineMs = reqT0 + 220_000;
      const GENERATION_ATTEMPT_MS = 95_000;
      const attempts: ChatAttemptEvent[] = [];
      let firstEventMs: number | null = null;
      let firstContentMs: number | null = null;
      let metaMs: number | null = null;
      let lastBeat = 0;
      const beat = (label: string, force = false) => {
        const now = Date.now();
        if (!force && now - lastBeat < 1500) return;
        lastBeat = now;
        const secs = Math.round((now - t0) / 1000);
        push(thinkingFrame(enc, `${label} (${secs}s)`));
      };
      const generating = lang === "en" ? "Calibrating and writing…" : "正在校准并撰写锐评…";
      const summaryFields = () => ({
        u: username,
        lang,
        path,
        source: "generate",
        generationPath,
        lockWaitMs,
        streamMs: Date.now() - t0,
        requestTotalMs: Date.now() - reqT0,
        firstEventMs,
        firstContentMs,
        metaMs,
        attempts,
      });
      const failAndClose = async (obj: unknown, fields: Record<string, unknown>) => {
        // Release the single-flight lock so waiting requests aren't stalled for
        // the full lock TTL by a generation that died early.
        if (isLeader) await releaseRoastLock(username, lang);
        logRoastSummary({ ...summaryFields(), ok: false, ...fields });
        push(errorFrame(enc, obj));
        close();
      };

      beat(generating, true);
      const events = chatStreamEventsWithFallback(llmConfigs, buildRoastMessages(scan, lang), {
        deadlineMs: llmDeadlineMs,
        attemptBudgetMs: GENERATION_ATTEMPT_MS,
        onAttempt(event) {
          attempts.push(event);
          if (event.phase === "first_event" && firstEventMs === null) {
            firstEventMs = Date.now() - reqT0;
          }
          if (event.phase === "first_content" && firstContentMs === null) {
            firstContentMs = Date.now() - reqT0;
          }
        },
      });
      let head = "";
      try {
        while (!/(^|\n)\s*##\s/.test(head) && head.length < 2000) {
          const { done, value } = await events.next();
          if (done) break;
          if (value.type === "content") head += value.text;
          else beat(generating);
        }
      } catch (e) {
        if (e instanceof LlmQuotaError) {
          return failAndClose(
            { error: "llm_quota", useByoKey: true, status: e.status },
            { stage: "generation", kind: "quota", head: head.slice(0, 200) },
          );
        }
        console.error("roast failed:", e);
        return failAndClose(
          { error: "roast_failed" },
          { stage: "generation", kind: classifyLlmError(e), head: head.slice(0, 200) },
        );
      }

      const delta = parseDelta(head);
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
        metaMs = Date.now() - reqT0;
      } catch (e) {
        console.error("roast meta failed:", e);
        return failAndClose(
          { error: "roast_failed" },
          { stage: "meta", kind: classifyLlmError(e) },
        );
      }

      // End of control phase: ship the AI-adjusted meta, then the report body.
      push(metaFrame(enc, meta));

      let full = report;
      try {
        if (report) push(enc.encode(report));
        // Drain the rest of the generation (resumes where head-reading left off).
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
          ...summaryFields(), ok: true,
          score: meta.final_score, delta, chars: full.length,
        });
      } catch (e) {
        logRoastSummary({
          ...summaryFields(), ok: false, stage: "stream",
          kind: classifyLlmError(e), chars: full.length,
        });
        console.error("roast stream error:", e);
        push(errorFrame(enc, { error: "roast_failed" }));
      } finally {
        if (isLeader) await releaseRoastLock(username, lang);
        close();
      }
    },
  });

  return roastResponse(stream, deterministicMeta(scan, lang));
}
