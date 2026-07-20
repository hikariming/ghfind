import { NextRequest } from "next/server";
import { getAccountDetail, recordAccountLookup } from "@/lib/db";
import { getPercentileCached, getRankCached } from "@/lib/rank";
import { normalizeUsername } from "@/lib/username";
import { beatPercent } from "@/lib/percentile";
import { TIER_KEY } from "@/lib/tier";
import { SITE_URL } from "@/lib/site";
import {
  checkPublicScanStatusRateLimit,
  checkRateLimit,
  coalesceScan,
  getCachedScan,
  rateLimitHeaders,
  setCachedScan,
} from "@/lib/redis";
import { buildScanResult, scanErrorResponse } from "@/lib/scan-core";
import {
  getPublicScanStatus,
  publicScanAdmission,
  type PublicScanResolution,
  requiresDurablePublicScan,
  resolvePublicScanFromTrustedQuickScan,
} from "@/lib/public-scan";
import { kickPublicScanDrain } from "@/lib/public-scan-dispatcher";
import { SCORE_CACHE_VERSION } from "@/lib/cache-version";
import type { ScanResult, Tier } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Indexed accounts change rarely — cache hard at the edge.
const RATED_CACHE = "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400";
// Freshly (live) scored accounts: shorter, so they flip to the richer indexed
// payload soon after someone generates a roast for them.
const LIVE_CACHE = "public, max-age=0, s-maxage=600, stale-while-revalidate=3600";
const MISS_CACHE = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "0.0.0.0";
}

function json(
  body: unknown,
  status: number,
  cache: string,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cache,
      ...(extra ?? {}),
    },
  });
}

/** Deterministic global percentile/rank for a score, computed against the scored
 * population WITHOUT requiring the account to be in it. */
async function percentileFor(finalScore: number) {
  const [rank, pct] = await Promise.all([
    getRankCached(finalScore),
    getPercentileCached(finalScore),
  ]);
  return pct
    ? { beat: beatPercent(pct.below, pct.total), total: pct.total, rank: rank?.rank ?? null }
    : null;
}

function durableResponse(
  username: string,
  resolution: Exclude<PublicScanResolution, { status: "complete" }>,
  headers: Record<string, string>,
) {
  if (resolution.status === "pending") {
    return json(
      {
        error: "scan_enrichment_pending",
        username,
        run_id: resolution.run.id,
        retry_after: resolution.retryAfterSeconds,
      },
      202,
      MISS_CACHE,
      { ...headers, "Retry-After": String(resolution.retryAfterSeconds) },
    );
  }
  if (resolution.status === "queue_full" || resolution.status === "admission_limited") {
    return json(
      { error: resolution.status, username, retry_after: resolution.retryAfterSeconds },
      429,
      MISS_CACHE,
      { ...headers, "Retry-After": String(resolution.retryAfterSeconds), "Cache-Control": "no-store" },
    );
  }
  return json(
    {
      error: "durable_scan_unavailable",
      username,
      retry_after: resolution.retryAfterSeconds,
    },
    503,
    MISS_CACHE,
    { ...headers, "Retry-After": String(resolution.retryAfterSeconds) },
  );
}

/**
 * GET /api/score/{username} — public, read-only, deterministic score. No auth,
 * no LLM, no money spent on a model.
 *
 * 1. Indexed hit: return the stored score (tags/roast_line included).
 * 2. Miss: fall through to a LIVE deterministic scan — crawl GitHub + run the
 *    pure scoring engine (same as POST /api/scan, minus the LLM roast). So an
 *    account that simply hasn't been scored yet returns a real score instead of
 *    a 404. Protected by the shared scan cache, per-IP rate limit, and
 *    single-flight coalescing so it can't be used to hammer the GitHub token.
 *
 * The only remaining 404 is a GitHub login that genuinely does not exist.
 */
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

  // 1) Indexed (already roasted / scored) — richest payload, cheapest path.
  const detail = await getAccountDetail(handle);
  if (detail?.score_version === SCORE_CACHE_VERSION) {
    return json(
      {
        source: "indexed",
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
      RATED_CACHE,
    );
  }

  // 2) Not indexed → score it live, deterministically (NO LLM).
  const statusLimit = await checkPublicScanStatusRateLimit(clientIp(req));
  const statusHeaders = rateLimitHeaders(statusLimit);
  if (!statusLimit.success) {
    return json(
      {
        error: statusLimit.unavailable ? "rate_limit_unavailable" : "rate_limited",
        message: statusLimit.unavailable ? "request protection temporarily unavailable" : "too many status requests",
        hint: "retry after the Retry-After interval",
      },
      statusLimit.unavailable ? 503 : 429,
      "no-store",
      statusHeaders,
    );
  }
  const publicStatus = await getPublicScanStatus(handle);
  if (publicStatus?.status === "complete") {
    await setCachedScan(publicStatus.scan.metrics.username, publicStatus.scan);
    const s = publicStatus.scan.scoring;
    const m = publicStatus.scan.metrics;
    const tier = s.tier as Tier;
    return json(
      {
        source: "complete_public",
        cached: true,
        username: m.username,
        display_name: m.name,
        avatar_url: m.avatar_url,
        profile_url: m.profile_url ?? `https://github.com/${m.username}`,
        final_score: s.final_score,
        tier,
        tier_key: TIER_KEY[tier],
        sub_scores: s.sub_scores,
        base_score: s.base_score,
        total_penalty: s.total_penalty,
        red_flags: s.red_flags,
        tags: null,
        roast_line: null,
        percentile: await percentileFor(s.final_score),
        profile: `${SITE_URL}/u/${m.username}`,
      },
      200,
      LIVE_CACHE,
    );
  }
  if (publicStatus) {
    return durableResponse(handle, publicStatus, statusHeaders);
  }
  const cached = await getCachedScan(handle);
  const durableAdmission = publicScanAdmission(`ip:${clientIp(req)}`);
  let rlHeaders: Record<string, string> = {};
  if (!cached) {
    const limit = await checkRateLimit(clientIp(req));
    rlHeaders = rateLimitHeaders(limit);
    if (!limit.success) {
      return json(
        {
          error: limit.unavailable ? "rate_limit_unavailable" : "rate_limited",
          message: limit.unavailable ? "request protection temporarily unavailable" : "too many requests",
          hint: "retry after the Retry-After interval",
        },
        limit.unavailable ? 503 : 429,
        "no-store",
        rlHeaders,
      );
    }
  }

  let result: ScanResult;
  try {
    result = cached ?? (await coalesceScan(handle, () => buildScanResult(handle)));
  } catch (e) {
    const { error, status, retry_after } = scanErrorResponse(e);
    // account_not_found stays a 404 — the GitHub user genuinely doesn't exist.
    return json(
      { error, message: error.replace(/_/g, " "), ...(retry_after ? { retry_after } : {}) },
      status,
      MISS_CACHE,
      { ...rlHeaders, ...(retry_after ? { "Retry-After": String(retry_after) } : {}) },
    );
  }

  if (!cached) {
    await recordAccountLookup(result.metrics.username, clientIp(req));
  }

  if (requiresDurablePublicScan(result)) {
    const durable = await resolvePublicScanFromTrustedQuickScan(
      result.metrics.username,
      result,
      durableAdmission,
    );
    if (durable.status === "complete") {
      result = durable.scan;
    } else {
      if (durable.status === "pending" && durable.shouldDrain) {
        kickPublicScanDrain();
      }
      return durableResponse(result.metrics.username, durable, { ...statusHeaders, ...rlHeaders });
    }
  }

  const s = result.scoring;
  const m = result.metrics;
  const tier = s.tier as Tier;
  return json(
    {
      source: "live",
      cached: Boolean(cached),
      username: m.username,
      display_name: m.name,
      avatar_url: m.avatar_url,
      profile_url: m.profile_url ?? `https://github.com/${m.username}`,
      final_score: s.final_score,
      tier,
      tier_key: TIER_KEY[tier],
      sub_scores: s.sub_scores,
      base_score: s.base_score,
      total_penalty: s.total_penalty,
      red_flags: s.red_flags,
      // Not yet roasted, so no LLM-authored copy.
      tags: null,
      roast_line: null,
      percentile: await percentileFor(s.final_score),
      profile: `${SITE_URL}/u/${m.username}`,
    },
    200,
    LIVE_CACHE,
    rlHeaders,
  );
}
