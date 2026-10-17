import { NextRequest, NextResponse, after } from "next/server";
import { notifyCampaignCardGenerated } from "@/lib/campaign-notify";
import { campaignSlug, type CampaignSlug } from "@/lib/campaigns";
import {
  hasLegacyReadFallbackProfile,
  getCurrentCanonicalQuickScan,
  getLatestVerifiedCanonicalScan,
  getLegacyReadFallbackScan,
  publishCompleteQuickScan,
  recordAccountLookup,
  recordCampaignParticipant,
} from "@/lib/db";
import {
  checkRateLimit,
  checkScanNetworkRateLimit,
  coalesceScan,
  getCachedScan,
  getStaleCachedScan,
  isScanPending,
  rateLimitHeaders,
  tryAcquireScanRefresh,
} from "@/lib/redis";
import { GitHubDataUnavailableError } from "@/lib/github";
import { SCAN_PENDING_RETRY_AFTER_SECONDS, ScanBusyError, ScanPendingError } from "@/lib/scan-protection";
import { SCORE_CACHE_VERSION } from "@/lib/cache-version";
import type { ScanResult } from "@/lib/types";
import {
  attachAnonymousSession,
  establishAnonymousSession,
  type AnonymousSession,
} from "@/lib/anonymous-session";
import { apiError } from "@/lib/api-error";
import { machineAuth } from "@/lib/machine-auth";
import { buildScanResult, logFreshScanFailure, scanErrorResponse } from "@/lib/scan-core";
import { LEGACY_READ_FALLBACK, RUNTIME_RELEASE_VERSIONS } from "@/lib/release-versions";
import { verifyTurnstile } from "@/lib/turnstile";
import { normalizeUsername } from "@/lib/username";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("cf-connecting-ip")?.trim() ||
    req.headers.get("x-vercel-forwarded-for")?.split(",").at(-1)?.trim() ||
    req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ||
    "0.0.0.0"
  );
}

function idempotencyHeaders(req: NextRequest): Record<string, string> {
  const key = req.headers.get("idempotency-key");
  return key ? { "Idempotency-Key": key } : {};
}

function scorePersistenceUnavailable(headers: Record<string, string>) {
  return apiError("scan_failed", {
    status: 503,
    message: "score persistence is temporarily unavailable",
    hint: "Retry later; no incomplete score was published.",
    headers: {
      ...headers,
      "Cache-Control": "no-store",
      "Retry-After": "5",
    },
  });
}

class ScorePersistenceError extends Error {}

async function persistQuickScan(
  scan: ScanResult,
  scannedAt: number,
): Promise<boolean> {
  try {
    return Boolean(await publishCompleteQuickScan(scan, scannedAt));
  } catch {
    console.error("publishCompleteQuickScan failed");
    return false;
  }
}

async function recordSuccessfulLookup(
  username: string,
  ip: string,
  campaign: CampaignSlug | null,
): Promise<void> {
  const [, newlyJoined] = await Promise.all([
    recordAccountLookup(username, ip),
    campaign ? recordCampaignParticipant(campaign, username) : Promise.resolve(false),
  ]);
  if (campaign && newlyJoined) {
    // Operator mail rides after the response; a slow SMTP hop must not add
    // latency to the scan result the participant is staring at.
    after(() => notifyCampaignCardGenerated(campaign, username));
  }
}

/**
 * A verified previous-release profile is only an emergency read fallback. Successful
 * current quick scans always win and immediately refresh the v10 profile.
 */
function scanTimestamp(scan: ScanResult): number | undefined {
  const value = (scan as ScanResult & { scanned_at?: unknown }).scanned_at;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isEmergencyFallbackError(error: unknown): boolean {
  return error instanceof ScanBusyError || error instanceof GitHubDataUnavailableError;
}

async function produceFreshScan(username: string): Promise<ScanResult> {
  const scannedAt = Date.now();
  const quickScan = await buildScanResult(username);
  if (!(await persistQuickScan(quickScan, scannedAt))) throw new ScorePersistenceError();
  return Object.assign(quickScan, { scanned_at: scannedAt });
}

async function refreshScanInBackground(username: string): Promise<void> {
  if (!(await tryAcquireScanRefresh(username))) return;
  try {
    await coalesceScan(username, () => produceFreshScan(username), { background: true });
  } catch (error) {
    logFreshScanFailure(error, {
      route: "scan",
      username,
      persistenceFailure: error instanceof ScorePersistenceError,
    });
  }
}

function scheduleBackgroundRefresh(username: string): void {
  after(() => refreshScanInBackground(username));
}

async function staleReadResponse(input: {
  scan: ScanResult;
  headers: Record<string, string>;
  coverage: "quick" | "legacy";
  servedScoreVersion: string;
  scannedAt?: number;
  legacy?: boolean;
}) {
  const scannedAt = input.scannedAt ?? scanTimestamp(input.scan);
  return NextResponse.json(
    {
      ...input.scan,
      cached: true,
      coverage: input.coverage,
      stale: true,
      served_score_version: input.servedScoreVersion,
      served_collection_version:
        input.coverage === "legacy"
          ? LEGACY_READ_FALLBACK.collection
          : RUNTIME_RELEASE_VERSIONS.collection,
      target_score_version: RUNTIME_RELEASE_VERSIONS.score,
      target_collection_version: RUNTIME_RELEASE_VERSIONS.collection,
      ...(scannedAt ? { scanned_at: scannedAt } : {}),
      ...(input.legacy
        ? {
            legacy_read_fallback: true,
            served_roast_version: LEGACY_READ_FALLBACK.roast,
            target_roast_version: RUNTIME_RELEASE_VERSIONS.roast,
          }
        : {}),
    },
    { headers: { ...input.headers, "Cache-Control": "no-store" } },
  );
}

async function legacyReadFallbackResponse(input: {
  scan: ScanResult;
  headers: Record<string, string>;
}) {
  return staleReadResponse({
    scan: input.scan,
    headers: input.headers,
    coverage: "legacy",
    servedScoreVersion: LEGACY_READ_FALLBACK.score,
    legacy: true,
  });
}

async function legacyReadFallbackProfileResponse(input: {
  username: string;
  headers: Record<string, string>;
}) {
  return NextResponse.json(
    {
      username: input.username,
      cached: true,
      stale: true,
      legacy_read_fallback: true,
      legacy_profile: true,
      served_score_version: LEGACY_READ_FALLBACK.score,
      served_roast_version: LEGACY_READ_FALLBACK.roast,
      served_collection_version: LEGACY_READ_FALLBACK.collection,
      target_score_version: RUNTIME_RELEASE_VERSIONS.score,
      target_roast_version: RUNTIME_RELEASE_VERSIONS.roast,
      target_collection_version: RUNTIME_RELEASE_VERSIONS.collection,
    },
    { headers: { ...input.headers, "Cache-Control": "no-store" } },
  );
}

export function scanPendingResponse(username: string, headers: Record<string, string>) {
  const path = `/api/scan?username=${encodeURIComponent(username)}`;
  return NextResponse.json(
    {
      error: "scan_pending",
      scan_pending: true,
      message: "scan pending",
      hint: "Large-account GitHub collection is still running. Poll GET /api/scan?username=… until 200.",
      username,
      poll: { method: "GET", path, interval_seconds: SCAN_PENDING_RETRY_AFTER_SECONDS },
      status: { state: "running" },
    },
    {
      status: 202,
      headers: {
        ...headers,
        "Retry-After": String(SCAN_PENDING_RETRY_AFTER_SECONDS),
        Location: path,
        "Cache-Control": "no-store",
      },
    },
  );
}

function immediateResponse(input: {
  scan: ScanResult;
  cached: boolean;
  headers: Record<string, string>;
  scannedAt?: number;
}) {
  const scannedAt = input.scannedAt ?? scanTimestamp(input.scan);
  return NextResponse.json(
    {
      ...input.scan,
      cached: input.cached,
      // The bounded collector is the product contract. It never waits for a
      // second full-history pass before scoring or roasting the account.
      coverage: "quick",
      ...(scannedAt ? { scanned_at: scannedAt } : {}),
    },
    { headers: input.headers },
  );
}

export async function POST(req: NextRequest) {
  const idem = idempotencyHeaders(req);
  let body: { username?: unknown; turnstileToken?: unknown; campaign?: unknown };
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_body", { status: 400, headers: idem });
  }

  const username = normalizeUsername(body.username);
  if (!username) return apiError("invalid_username", { status: 400, headers: idem });

  const campaign = campaignSlug(body.campaign);
  if (body.campaign !== undefined && !campaign) {
    return apiError("invalid_body", { status: 400, headers: idem });
  }

  const ip = clientIp(req);
  const auth = await machineAuth(req);
  if (auth === "invalid") return apiError("unauthorized", { status: 401, headers: idem });
  let anonymousSession: AnonymousSession | null = null;
  if (auth === "absent") {
    const token = typeof body.turnstileToken === "string" ? body.turnstileToken : null;
    if (!(await verifyTurnstile(token, ip))) {
      return apiError("turnstile_failed", { status: 403, headers: idem });
    }
    anonymousSession = establishAnonymousSession(req);
  }

  const isMachineCaller = auth === "valid";
  const principal = isMachineCaller
    ? ip
    : anonymousSession
      ? `anon:${anonymousSession.id}`
      : ip;
  // A verified, signed browser session is the interactive path. If Turnstile
  // is unavailable/misconfigured and no session can be issued, retain the IP
  // guard as a fail-safe rather than making the scan route unlimited.
  const limit = isMachineCaller || !anonymousSession
    ? await checkRateLimit(principal)
    : { success: true };
  const rlHeaders = rateLimitHeaders(limit);
  if (!limit.success) {
    const legacyScan = await getLegacyReadFallbackScan(username);
    if (legacyScan) {
      return attachAnonymousSession(
        await legacyReadFallbackResponse({ scan: legacyScan, headers: { ...idem, ...rlHeaders } }),
        anonymousSession,
      );
    }
    if (await hasLegacyReadFallbackProfile(username)) {
      return attachAnonymousSession(
        await legacyReadFallbackProfileResponse({ username, headers: { ...idem, ...rlHeaders } }),
        anonymousSession,
      );
    }
    return apiError(limit.unavailable ? "rate_limit_unavailable" : "rate_limited", {
      status: limit.unavailable ? 503 : 429,
      headers: { ...idem, ...rlHeaders, "Cache-Control": "no-store" },
    });
  }
  // `?force=1` (RescanButton) bypasses the cache read so a rescan reflects the
  // fresh snapshot immediately; admission/rate limits above still apply.
  const force = req.nextUrl.searchParams.get("force") === "1";
  const cached = force ? null : await getCachedScan(username);
  if (cached) {
    // The cached snapshot was persisted by its producing quick scan. Replaying
    // it must remain read-only: publishing it again with Date.now() would make
    // an old score look freshly scanned and reset the UI's rescan cooldown.
    await recordSuccessfulLookup(cached.metrics.username, ip, campaign);
    return attachAnonymousSession(
      immediateResponse({ scan: cached, cached: true, headers: { ...idem, ...rlHeaders } }),
      anonymousSession,
    );
  }
  if (!force) {
    const indexed = await getCurrentCanonicalQuickScan(username);
    if (indexed) {
      await recordSuccessfulLookup(indexed.scan.metrics.username, ip, campaign);
      return attachAnonymousSession(
        immediateResponse({
          scan: indexed.scan,
          cached: true,
          headers: { ...idem, ...rlHeaders },
          scannedAt: indexed.scannedAt,
        }),
        anonymousSession,
      );
    }
  }

  try {
    const result = await coalesceScan(username, () => produceFreshScan(username), {
      force,
      continueOnDeadline: true,
    });
    await recordSuccessfulLookup(result.metrics.username, ip, campaign);
    return attachAnonymousSession(
      immediateResponse({ scan: result, cached: false, headers: { ...idem, ...rlHeaders } }),
      anonymousSession,
    );
  } catch (error) {
    if (error instanceof ScanPendingError) {
      return attachAnonymousSession(
        scanPendingResponse(username, { ...idem, ...rlHeaders }),
        anonymousSession,
      );
    }
    logFreshScanFailure(error, {
      route: "scan",
      username: username,
      persistenceFailure: error instanceof ScorePersistenceError,
    });
    const fallbackHeaders = { ...idem, ...rlHeaders };
    if (isEmergencyFallbackError(error)) {
      const staleCached = await getStaleCachedScan(username);
      if (staleCached) {
        scheduleBackgroundRefresh(username);
        await recordSuccessfulLookup(staleCached.metrics.username, ip, campaign);
        return attachAnonymousSession(
          await staleReadResponse({
            scan: staleCached,
            headers: fallbackHeaders,
            coverage: "quick",
            servedScoreVersion: SCORE_CACHE_VERSION,
          }),
          anonymousSession,
        );
      }
      const verified = await getLatestVerifiedCanonicalScan(username);
      if (verified) {
        scheduleBackgroundRefresh(username);
        await recordSuccessfulLookup(verified.scan.metrics.username, ip, campaign);
        return attachAnonymousSession(
          await staleReadResponse({
            scan: verified.scan,
            headers: fallbackHeaders,
            coverage: "quick",
            servedScoreVersion: SCORE_CACHE_VERSION,
            scannedAt: verified.scannedAt,
          }),
          anonymousSession,
        );
      }
    }
    const legacyScan = await getLegacyReadFallbackScan(username);
    if (legacyScan) {
      if (isEmergencyFallbackError(error)) scheduleBackgroundRefresh(username);
      return attachAnonymousSession(
        await legacyReadFallbackResponse({ scan: legacyScan, headers: fallbackHeaders }),
        anonymousSession,
      );
    }
    if (await hasLegacyReadFallbackProfile(username)) {
      if (isEmergencyFallbackError(error)) scheduleBackgroundRefresh(username);
      return attachAnonymousSession(
        await legacyReadFallbackProfileResponse({ username, headers: fallbackHeaders }),
        anonymousSession,
      );
    }
    if (error instanceof ScorePersistenceError) {
      return scorePersistenceUnavailable(fallbackHeaders);
    }
    const { error: code, status, retry_after } = scanErrorResponse(error);
    return apiError(code as Parameters<typeof apiError>[0], {
      status,
      headers: {
        ...fallbackHeaders,
        ...(retry_after ? { "Retry-After": String(retry_after) } : {}),
      },
    });
  }
}

/** Read-only poll for a deferred collect. Never starts a new GitHub crawl. */
export async function GET(req: NextRequest) {
  const username = normalizeUsername(req.nextUrl.searchParams.get("username"));
  if (!username) return apiError("invalid_username", { status: 400 });

  const ip = clientIp(req);
  // Read-only poll: 60/60s so a 5s Retry-After loop cannot burn the 10/60s
  // GitHub-produce budget.
  const limit = await checkScanNetworkRateLimit(ip);
  const rlHeaders = rateLimitHeaders(limit);
  if (!limit.success) {
    return apiError(limit.unavailable ? "rate_limit_unavailable" : "rate_limited", {
      status: limit.unavailable ? 503 : 429,
      headers: { ...rlHeaders, "Cache-Control": "no-store" },
    });
  }

  const pollHeaders = { ...rlHeaders, "Cache-Control": "no-store" };
  const cached = await getCachedScan(username);
  if (cached) {
    return immediateResponse({ scan: cached, cached: true, headers: pollHeaders });
  }
  const indexed = await getCurrentCanonicalQuickScan(username);
  if (indexed) {
    return immediateResponse({
      scan: indexed.scan,
      cached: true,
      headers: pollHeaders,
      scannedAt: indexed.scannedAt,
    });
  }
  if (await isScanPending(username)) {
    return scanPendingResponse(username, pollHeaders);
  }
  return apiError("not_scored", {
    status: 404,
    headers: pollHeaders,
  });
}
