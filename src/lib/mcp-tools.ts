/**
 * Shared logic for the MCP tools (src/app/api/[transport]/route.ts). Each function
 * calls the internal libs directly — never an HTTP self-call — and returns a plain
 * JS object. Deterministic, read-only, and routed through the same caches the REST
 * endpoints use, so an agent looping over these can't amplify GitHub/DB load.
 */
import { getAccountDetail, searchScoredUsers } from "@/lib/db";
import { getPercentileCached, getRankCached } from "@/lib/rank";
import { getLeaderboardCached } from "@/lib/leaderboard";
import type { LeaderboardCacheView } from "@/lib/redis";
import type { LeaderboardWindow } from "@/lib/db";
import { coalesceScan, getCachedScan } from "@/lib/redis";
import { buildScanResult, scanErrorResponse } from "@/lib/scan-core";
import {
  getPublicScanStatus,
  publicScanAdmission,
  requiresDurablePublicScan,
  resolvePublicScanFromTrustedQuickScan,
} from "@/lib/public-scan";
import { SCORE_CACHE_VERSION } from "@/lib/cache-version";
import { normalizeUsername } from "@/lib/username";
import { beatPercent } from "@/lib/percentile";
import { TIER_KEY } from "@/lib/tier";
import { SITE_URL } from "@/lib/site";
import type { ScanResult, Tier } from "@/lib/types";

export type ToolError = { error: string; message: string };

async function percentileFor(finalScore: number) {
  const [rank, pct] = await Promise.all([
    getRankCached(finalScore),
    getPercentileCached(finalScore),
  ]);
  return pct
    ? { beat: beatPercent(pct.below, pct.total), total: pct.total, rank: rank?.rank ?? null }
    : null;
}

/** Deterministic score for one account (indexed hit, else a live scan). */
export async function scoreUser(
  rawUsername: string,
  options?: { durablePrincipal?: string },
): Promise<Record<string, unknown> | ToolError> {
  const handle = normalizeUsername(rawUsername ?? "");
  if (!handle) {
    return { error: "invalid_username", message: "username must be a valid GitHub login" };
  }

  const detail = await getAccountDetail(handle);
  if (detail?.score_version === SCORE_CACHE_VERSION) {
    return {
      source: "indexed",
      username: detail.username,
      display_name: detail.display_name,
      final_score: detail.final_score,
      tier: detail.tier,
      tier_key: TIER_KEY[detail.tier],
      sub_scores: detail.sub_scores,
      percentile: await percentileFor(detail.final_score),
      scanned_at: detail.scanned_at,
      profile: `${SITE_URL}/u/${detail.username}`,
    };
  }

  let result: ScanResult;
  try {
    const status = await getPublicScanStatus(handle);
    if (status?.status === "complete") {
      result = status.scan;
    } else {
      if (status) {
        return {
          error: "scan_enrichment_pending",
          message: `durable public-history scan for ${handle} is ${status.status}; retry after ${status.retryAfterSeconds}s`,
        };
      }
      const cached = await getCachedScan(handle);
      result = cached ?? (await coalesceScan(handle, () => buildScanResult(handle)));
    }
  } catch (e) {
    const { error } = scanErrorResponse(e);
    return { error, message: `could not score ${handle}` };
  }

  if (requiresDurablePublicScan(result)) {
    const durable = await resolvePublicScanFromTrustedQuickScan(
      result.metrics.username,
      result,
      options?.durablePrincipal ? publicScanAdmission(options.durablePrincipal) : undefined,
    );
    if (durable.status === "complete") {
      result = durable.scan;
    } else {
      return {
        error: "scan_enrichment_pending",
        message: `durable public-history scan for ${result.metrics.username} is ${durable.status}; retry after ${durable.retryAfterSeconds}s`,
      };
    }
  }

  const s = result.scoring;
  const m = result.metrics;
  const tier = s.tier as Tier;
  return {
    source: "live",
    username: m.username,
    display_name: m.name,
    final_score: s.final_score,
    tier,
    tier_key: TIER_KEY[tier],
    sub_scores: s.sub_scores,
    red_flags: s.red_flags,
    percentile: await percentileFor(s.final_score),
    profile: `${SITE_URL}/u/${m.username}`,
  };
}

/** Full deterministic scan payload for one account. */
export async function scanUser(
  rawUsername: string,
  options?: { durablePrincipal?: string },
): Promise<ScanResult | ToolError> {
  const handle = normalizeUsername(rawUsername ?? "");
  if (!handle) {
    return { error: "invalid_username", message: "username must be a valid GitHub login" };
  }
  try {
    const status = await getPublicScanStatus(handle);
    if (status?.status === "complete") return status.scan;
    if (status) {
      return {
        error: "scan_enrichment_pending",
        message: `durable public-history scan for ${handle} is ${status.status}; retry after ${status.retryAfterSeconds}s`,
      };
    }
    const cached = await getCachedScan(handle);
    const scan = cached ?? (await coalesceScan(handle, () => buildScanResult(handle)));
    if (requiresDurablePublicScan(scan)) {
      const durable = await resolvePublicScanFromTrustedQuickScan(
        scan.metrics.username,
        scan,
        options?.durablePrincipal ? publicScanAdmission(options.durablePrincipal) : undefined,
      );
      if (durable.status === "complete") return durable.scan;
      return {
        error: "scan_enrichment_pending",
        message: `durable public-history scan for ${scan.metrics.username} is ${durable.status}; retry after ${durable.retryAfterSeconds}s`,
      };
    }
    return scan;
  } catch (e) {
    const { error } = scanErrorResponse(e);
    return { error, message: `could not scan ${handle}` };
  }
}

/** Head-to-head: two deterministic scores side by side (no LLM verdict). */
export async function compareUsers(
  rawA: string,
  rawB: string,
  options?: { durablePrincipal?: string },
): Promise<Record<string, unknown> | ToolError> {
  const [a, b] = await Promise.all([scoreUser(rawA, options), scoreUser(rawB, options)]);
  if ("error" in a) return a;
  if ("error" in b) return b;
  const sa = a.final_score as number;
  const sb = b.final_score as number;
  const gap = Math.abs(sa - sb);
  return {
    a,
    b,
    winner: gap === 0 ? null : sa > sb ? a.username : b.username,
    gap: Number(gap.toFixed(2)),
    note: "Deterministic comparison. For a savage bilingual verdict, POST /api/vs-verdict.",
  };
}

/** Ranked developers. `limit` keeps the payload agent-sized (the full board is 500). */
export async function getLeaderboard(
  view: LeaderboardCacheView = "trending",
  window: LeaderboardWindow = "all",
  limit = 50,
): Promise<Record<string, unknown>> {
  const { entries, cached } = await getLeaderboardCached(view, window);
  const page = entries.slice(0, Math.max(1, Math.min(limit, 100)));
  return { view, window, cached, count: page.length, total: entries.length, entries: page };
}

/** Prefix search over scored accounts. */
export async function searchUsers(q: string): Promise<Record<string, unknown>> {
  const query = (q ?? "").trim();
  if (query.length < 1) return { query, users: [] };
  const users = await searchScoredUsers(query, 6);
  return { query, users };
}
