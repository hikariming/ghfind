import { NextRequest } from "next/server";
import {
  getAccountDetail,
  publishCompleteQuickScan,
  recordAccountLookup,
} from "@/lib/db";
import { getPercentileCached, getRankCached } from "@/lib/rank";
import { normalizeUsername } from "@/lib/username";
import { beatPercent } from "@/lib/percentile";
import { TIER_KEY } from "@/lib/tier";
import { SITE_URL } from "@/lib/site";
import {
  checkRateLimit,
  coalesceScan,
  getCachedScan,
  rateLimitHeaders,
} from "@/lib/redis";
import { buildScanResult, scanErrorResponse } from "@/lib/scan-core";
import { SCORE_CACHE_VERSION } from "@/lib/cache-version";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "@/lib/scan-run-types";
import type { ScanResult, Tier } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RATED_CACHE = "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400";
const LIVE_CACHE = "public, max-age=0, s-maxage=600, stale-while-revalidate=3600";
const MISS_CACHE = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "0.0.0.0";
}

function json(body: unknown, status: number, cache: string, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cache,
      ...(extra ?? {}),
    },
  });
}

function scorePersistenceUnavailable(headers: Record<string, string>): Response {
  return json(
    {
      error: "scan_failed",
      message: "score persistence is temporarily unavailable",
      hint: "Retry later; no incomplete score was published.",
    },
    503,
    "no-store",
    { ...headers, "Retry-After": "5" },
  );
}

class ScorePersistenceError extends Error {}

async function persistQuickScan(scan: ScanResult, scannedAt: number): Promise<boolean> {
  try {
    return Boolean(await publishCompleteQuickScan(scan, scannedAt));
  } catch {
    console.error("publishCompleteQuickScan failed");
    return false;
  }
}

async function percentileFor(finalScore: number) {
  const [rank, pct] = await Promise.all([
    getRankCached(finalScore),
    getPercentileCached(finalScore),
  ]);
  return pct
    ? { beat: beatPercent(pct.below, pct.total), total: pct.total, rank: rank?.rank ?? null }
    : null;
}

async function liveScoreResponse(scan: ScanResult, cached: boolean, headers: Record<string, string>) {
  const scoring = scan.scoring;
  const metrics = scan.metrics;
  const tier = scoring.tier as Tier;
  return json(
    {
      source: "quick",
      coverage: "quick",
      cached,
      username: metrics.username,
      display_name: metrics.name,
      avatar_url: metrics.avatar_url,
      profile_url: metrics.profile_url ?? `https://github.com/${metrics.username}`,
      final_score: scoring.final_score,
      tier,
      tier_key: TIER_KEY[tier],
      sub_scores: scoring.sub_scores,
      base_score: scoring.base_score,
      total_penalty: scoring.total_penalty,
      red_flags: scoring.red_flags,
      tags: null,
      roast_line: null,
      percentile: await percentileFor(scoring.final_score),
      profile: `${SITE_URL}/u/${metrics.username}`,
    },
    200,
    LIVE_CACHE,
    headers,
  );
}

/** Public deterministic score: bounded quick collection only, never queue work. */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ username: string }> },
) {
  const { username } = await ctx.params;
  const handle = normalizeUsername(decodeURIComponent(username ?? ""));
  if (!handle) {
    return json(
      {
        error: "invalid_username",
        message: "username must be a valid GitHub login",
        hint: "pass a login like /api/score/octocat",
      },
      400,
      MISS_CACHE,
    );
  }

  const detail = await getAccountDetail(handle);
  if (detail) {
    const currentScore =
      detail.score_version === SCORE_CACHE_VERSION &&
      detail.score_source_collection_version === PUBLIC_SCAN_COLLECTION_VERSION &&
      typeof detail.score_source_snapshot_hash === "string" &&
      /^[a-f0-9]{64}$/.test(detail.score_source_snapshot_hash);
    return json(
      {
        source: "indexed",
        coverage: "quick",
        stale: !currentScore,
        username: detail.username,
        display_name: detail.display_name,
        avatar_url: detail.avatar_url,
        profile_url: detail.profile_url ?? `https://github.com/${detail.username}`,
        final_score: detail.final_score,
        tier: detail.tier,
        tier_key: TIER_KEY[detail.tier],
        sub_scores: detail.sub_scores,
        tags: detail.tags,
        roast_line: detail.roast_line,
        percentile: await percentileFor(detail.final_score),
        scanned_at: detail.scanned_at,
        profile: `${SITE_URL}/u/${detail.username}`,
      },
      200,
      currentScore ? RATED_CACHE : LIVE_CACHE,
    );
  }

  const limit = await checkRateLimit(clientIp(req));
  const headers = rateLimitHeaders(limit);
  if (!limit.success) {
    return json(
      {
        error: limit.unavailable ? "rate_limit_unavailable" : "rate_limited",
        message: limit.unavailable ? "request protection temporarily unavailable" : "too many requests",
        hint: "retry after the Retry-After interval",
      },
      limit.unavailable ? 503 : 429,
      "no-store",
      headers,
    );
  }

  const cached = await getCachedScan(handle);
  let result: ScanResult;
  try {
    if (cached) {
      if (!(await persistQuickScan(cached, Date.now()))) throw new ScorePersistenceError();
      result = cached;
    } else {
      result = await coalesceScan(handle, async () => {
      const scannedAt = Date.now();
      const quickScan = await buildScanResult(handle);
      if (!(await persistQuickScan(quickScan, scannedAt))) throw new ScorePersistenceError();
      return quickScan;
      });
    }
  } catch (error) {
    if (error instanceof ScorePersistenceError) return scorePersistenceUnavailable(headers);
    const { error: code, status, retry_after } = scanErrorResponse(error);
    return json(
      { error: code, message: code.replace(/_/g, " "), ...(retry_after ? { retry_after } : {}) },
      status,
      MISS_CACHE,
      { ...headers, ...(retry_after ? { "Retry-After": String(retry_after) } : {}) },
    );
  }

  if (!cached) await recordAccountLookup(result.metrics.username, clientIp(req));
  return liveScoreResponse(result, Boolean(cached), headers);
}
