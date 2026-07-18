import { NextRequest, NextResponse } from "next/server";
import { checkBotId } from "botid/server";
import { getAccountDetail, recordMatchup, bumpMatchupView } from "@/lib/db";
import { verdict } from "@/lib/verdict";
import { normalizeUsername } from "@/lib/username";
import { VS_MIN_SCORE } from "@/lib/site";
import { buildPkVerdictMessages, parsePkVerdict } from "@/lib/prompt";
import { defaultLlmConfig, fallbackLlmConfig, getCompletionWithFallback } from "@/lib/llm";
import type { LlmConfig } from "@/lib/llm";
import {
  acquireVerdictLock,
  checkVerdictRateLimit,
  getCachedVerdict,
  releaseVerdictLock,
  setCachedVerdict,
  waitForCachedVerdict,
  type CachedVerdict,
} from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
}

/** Normalize + canonicalize (lowercased, dictionary order) a pair, or null. */
function canonicalize(a: string, b: string): { a: string; b: string } | null {
  const na = normalizeUsername(a);
  const nb = normalizeUsername(b);
  if (!na || !nb || na.toLowerCase() === nb.toLowerCase()) return null;
  const [x, y] = [na.toLowerCase(), nb.toLowerCase()].sort();
  return { a: x, b: y };
}

/**
 * Generate (or return the cached) bilingual LLM PK verdict + self-improvement
 * advice for a matchup. Auto-fired by the /vs page on mount, so crawlers that
 * run JS reach it too — BotID gates them before anything is written or spent
 * (mirrors /api/roast: verified crawlers pass, headless farms are refused).
 * Guardrails: both sides must clear VS_MIN_SCORE, per-IP rate limit,
 * single-flight lock, and a ~5-day cache — so one pair costs at most one LLM
 * call per window. The matchup row + view count are written only after the bot
 * and floor gates: probe traffic and junk pairs used to cost two Turso writes
 * per request before either check ran.
 */
export async function POST(req: NextRequest) {
  let body: { a?: string; b?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const pair = canonicalize(body.a ?? "", body.b ?? "");
  if (!pair) return NextResponse.json({ error: "invalid_pair" }, { status: 400 });
  const { a, b } = pair;

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

  const [da, db] = await Promise.all([getAccountDetail(a), getAccountDetail(b)]);
  if (!da || !db) {
    return NextResponse.json({ error: "need_both", verdict: null }, { status: 404 });
  }

  const v = verdict(da, db);
  const winner = v.winner === "tie" ? null : v.winner === "a" ? da.username : db.username;
  const base = {
    a,
    b,
    winner,
    bucket: v.bucket,
    gap: v.gap,
    scoreA: da.final_score,
    scoreB: db.final_score,
  };

  // Floor gate: below VS_MIN_SCORE we don't spend the model — page keeps the
  // deterministic template line. Runs before the writes so junk pairs no longer
  // mint matchup rows or view counts.
  if (da.final_score < VS_MIN_SCORE || db.final_score < VS_MIN_SCORE) {
    return NextResponse.json({ verdict: null, reason: "below_floor" });
  }

  // Ensure a row exists (deterministic result) + count the human view. Never
  // overwrites an existing LLM verdict (recordMatchup COALESCEs).
  await recordMatchup({ ...base, source: "template" });
  await bumpMatchupView(a, b);

  // Cache hit → no LLM.
  const cached = await getCachedVerdict(a, b);
  if (cached) {
    return NextResponse.json({
      verdict: cached.verdict,
      advice: cached.advice,
      winner: cached.winner,
      bucket: cached.bucket,
    });
  }

  const configs = [defaultLlmConfig(), fallbackLlmConfig()].filter(
    (c): c is LlmConfig => c !== null,
  );
  if (!configs.length) return NextResponse.json({ verdict: null, reason: "no_llm" });

  const { success } = await checkVerdictRateLimit(clientIp(req));
  if (!success) return NextResponse.json({ verdict: null, reason: "rate_limited" });

  // Single-flight: only the leader spends the LLM; others wait for its result.
  const leader = await acquireVerdictLock(a, b);
  if (!leader) {
    const waited = await waitForCachedVerdict(a, b);
    if (waited) {
      return NextResponse.json({
        verdict: waited.verdict,
        advice: waited.advice,
        winner: waited.winner,
        bucket: waited.bucket,
      });
    }
    // Fall through and generate ourselves rather than starve.
  }

  try {
    const messages = buildPkVerdictMessages(da, db, v);
    const raw = await getCompletionWithFallback(configs, messages, {
      deadlineMs: Date.now() + 100_000,
      // Fresh per-provider window so a stalled primary leaves the DeepSeek
      // fallback a real budget instead of the shared-deadline scraps.
      attemptBudgetMs: 45_000,
    });
    const { verdict: verdictLine, advice } = parsePkVerdict(raw);
    if (!verdictLine.zh && !verdictLine.en) {
      return NextResponse.json({ verdict: null, reason: "empty" });
    }
    const value: CachedVerdict = { verdict: verdictLine, advice, winner, bucket: v.bucket };
    await setCachedVerdict(a, b, value);
    await recordMatchup({ ...base, verdict: verdictLine, advice, source: "llm" });
    return NextResponse.json({ verdict: verdictLine, advice, winner, bucket: v.bucket });
  } catch (e) {
    console.error("vs-verdict failed:", e);
    return NextResponse.json({ verdict: null, reason: "failed" });
  } finally {
    if (leader) await releaseVerdictLock(a, b);
  }
}
