import { NextRequest, NextResponse } from "next/server";
import { TIER_LABEL_EN } from "@/lib/badge";
import { getArchivedRoast, getPercentile, recordScore, updateRoast } from "@/lib/db";
import { Lang, normLang } from "@/lib/lang";
import { LlmConfig, LlmQuotaError, chatStream, defaultLlmConfig } from "@/lib/llm";
import { beatPercent } from "@/lib/percentile";
import { buildRoastMessages } from "@/lib/prompt";
import { reportMatchesLang } from "@/lib/report";
import {
  acquireRoastLock,
  checkRoastRateLimit,
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
  byoKey?: ByoKey;
  /** UI locale → report language. Defaults to zh (see {@link normLang}). */
  lang?: string;
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
    top_repos: (scan.top_repos ?? []).slice(0, 10).map((r) => ({
      ...r,
      description: r.description?.slice(0, 300) ?? null,
      readme_excerpt: r.readme_excerpt?.slice(0, 500) ?? null,
    })),
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
  if (record) {
    await recordScore({
      username: scan.metrics.username,
      display_name: scan.metrics.name,
      avatar_url: scan.metrics.avatar_url,
      profile_url: scan.metrics.profile_url,
      final_score: adjusted,
      tier,
      tags,
      roast_line: roastLine,
      bot_score: spamBotScore(scan.metrics),
      sub_scores: scan.scoring.sub_scores,
      scanned_at: Date.now(),
    });
  }
  const percentile = await percentileFor(adjusted);
  return { final_score: adjusted, tier, tier_label, delta: effectiveDelta, percentile, tags, roast_line: roastLine };
}

async function percentileFor(score: number): Promise<RoastMeta["percentile"]> {
  const counts = await getPercentile(score);
  return counts
    ? { beat: beatPercent(counts.below, counts.total), total: counts.total }
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

  const generator = chatStream(config, buildRoastMessages(scan, lang));

  // Read the leading control lines (`@@ADJUST@@` + `@@TAGS@@` + `@@ROAST@@`)
  // before streaming — i.e. up to the report heading. Pulling tokens up-front also
  // surfaces quota/auth failures as a JSON status code. The cap is generous since
  // @@ROAST@@ now carries a full bilingual sentence ahead of the heading.
  let head = "";
  try {
    while (!/(^|\n)\s*##\s/.test(head) && head.length < 2000) {
      const { done, value } = await generator.next();
      if (done) break;
      head += value;
    }
  } catch (e) {
    // Release the single-flight lock so waiting requests aren't stalled for the
    // full lock TTL by a generation that died before it ever streamed.
    if (isLeader) await releaseRoastLock(username, lang);
    if (e instanceof LlmQuotaError) {
      return NextResponse.json(
        { error: "llm_quota", useByoKey: true, status: e.status },
        { status: 402 },
      );
    }
    console.error("roast failed:", e);
    return NextResponse.json({ error: "roast_failed" }, { status: 502 });
  }

  const delta = parseDelta(head);
  const tags = parseTags(head);
  const roastLine = parseRoast(head);
  const report = extractReport(head);

  const meta = await computeMeta(scan, delta, tags, roastLine, isDefault, lang);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = report;
      let clientGone = false;
      // If the client disconnects mid-stream, enqueue throws. Swallow it and keep
      // draining the generator so the (already in-flight, already paid-for) roast
      // still lands in cache — otherwise the next viewer re-spends LLM credit.
      const push = (bytes: Uint8Array) => {
        if (clientGone) return;
        try {
          controller.enqueue(bytes);
        } catch {
          clientGone = true;
        }
      };
      try {
        if (report) push(encoder.encode(report));
        for await (const chunk of generator) {
          full += chunk;
          push(encoder.encode(chunk));
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
      } catch (e) {
        console.error("roast stream error:", e);
      } finally {
        if (isLeader) await releaseRoastLock(username, lang);
        try {
          controller.close();
        } catch {
          // already closed (client gone)
        }
      }
    },
  });

  return roastResponse(stream, meta);
}
