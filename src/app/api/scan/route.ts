import { NextRequest, NextResponse } from "next/server";
import { campaignSlug, type CampaignSlug } from "@/lib/campaigns";
import {
  hasLegacyReadFallbackProfile,
  getLegacyReadFallbackScan,
  publishCompleteQuickScan,
  recordAccountLookup,
  recordCampaignParticipant,
} from "@/lib/db";
import {
  checkRateLimit,
  coalesceScan,
  getCachedScan,
  rateLimitHeaders,
} from "@/lib/redis";
import { apiError } from "@/lib/api-error";
import { machineAuth } from "@/lib/machine-auth";
import { buildScanResult, scanErrorResponse } from "@/lib/scan-core";
import { LEGACY_READ_FALLBACK, RUNTIME_RELEASE_VERSIONS } from "@/lib/release-versions";
import { verifyTurnstile } from "@/lib/turnstile";
import { normalizeUsername } from "@/lib/username";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "0.0.0.0";
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
  scan: import("@/lib/types").ScanResult,
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
  await Promise.all([
    recordAccountLookup(username, ip),
    campaign ? recordCampaignParticipant(campaign, username) : Promise.resolve(),
  ]);
}

/**
 * A verified v5/v5/v3 profile is only an emergency read fallback. Successful
 * current quick scans always win and immediately refresh the v9 profile.
 */
async function legacyReadFallbackResponse(input: {
  scan: import("@/lib/types").ScanResult;
  headers: Record<string, string>;
}) {
  return NextResponse.json(
    {
      ...input.scan,
      cached: true,
      coverage: "legacy",
      stale: true,
      legacy_read_fallback: true,
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

function immediateResponse(input: {
  scan: import("@/lib/types").ScanResult;
  cached: boolean;
  headers: Record<string, string>;
}) {
  return NextResponse.json(
    {
      ...input.scan,
      cached: input.cached,
      // The bounded collector is the product contract. It never waits for a
      // second full-history pass before scoring or roasting the account.
      coverage: "quick",
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
  const auth = machineAuth(req);
  if (auth === "invalid") return apiError("unauthorized", { status: 401, headers: idem });
  if (auth === "absent") {
    const token = typeof body.turnstileToken === "string" ? body.turnstileToken : null;
    if (!(await verifyTurnstile(token, ip))) {
      return apiError("turnstile_failed", { status: 403, headers: idem });
    }
  }

  const limit = await checkRateLimit(ip);
  const rlHeaders = rateLimitHeaders(limit);
  if (!limit.success) {
    return apiError(limit.unavailable ? "rate_limit_unavailable" : "rate_limited", {
      status: limit.unavailable ? 503 : 429,
      headers: { ...idem, ...rlHeaders, "Cache-Control": "no-store" },
    });
  }

  const cached = await getCachedScan(username);
  if (cached) {
    if (!(await persistQuickScan(cached, Date.now()))) {
      return scorePersistenceUnavailable({ ...idem, ...rlHeaders });
    }
    await recordSuccessfulLookup(cached.metrics.username, ip, campaign);
    return immediateResponse({ scan: cached, cached: true, headers: { ...idem, ...rlHeaders } });
  }

  try {
    const result = await coalesceScan(username, async () => {
      const scannedAt = Date.now();
      const quickScan = await buildScanResult(username);
      if (!(await persistQuickScan(quickScan, scannedAt))) throw new ScorePersistenceError();
      return quickScan;
    });
    await recordSuccessfulLookup(result.metrics.username, ip, campaign);
    return immediateResponse({ scan: result, cached: false, headers: { ...idem, ...rlHeaders } });
  } catch (error) {
    if (error instanceof ScorePersistenceError) {
      return scorePersistenceUnavailable({ ...idem, ...rlHeaders });
    }
    const legacyScan = await getLegacyReadFallbackScan(username);
    if (legacyScan) {
      return legacyReadFallbackResponse({ scan: legacyScan, headers: { ...idem, ...rlHeaders } });
    }
    if (await hasLegacyReadFallbackProfile(username)) {
      return legacyReadFallbackProfileResponse({ username, headers: { ...idem, ...rlHeaders } });
    }
    const { error: code, status, retry_after } = scanErrorResponse(error);
    return apiError(code as Parameters<typeof apiError>[0], {
      status,
      headers: {
        ...idem,
        ...rlHeaders,
        ...(retry_after ? { "Retry-After": String(retry_after) } : {}),
      },
    });
  }
}
