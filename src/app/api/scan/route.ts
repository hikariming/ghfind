import { NextRequest, NextResponse } from "next/server";
import { campaignSlug, type CampaignSlug } from "@/lib/campaigns";
import {
  ensureCanonicalScoreForPublicRun,
  publishCompleteQuickScan,
  recordAccountLookup,
  recordCampaignParticipant,
} from "@/lib/db";
import {
  checkRateLimit,
  clearCachedScan,
  coalesceScan,
  getCachedScan,
  rateLimitHeaders,
  setCachedScan,
} from "@/lib/redis";
import { apiError } from "@/lib/api-error";
import { machineAuth } from "@/lib/machine-auth";
import { buildScanResult, scanErrorResponse } from "@/lib/scan-core";
import {
  getPublicScanStatus,
  publicScanAdmission,
  type PublicScanResolution,
  requiresDurablePublicScan,
  resolvePublicScanFromTrustedQuickScan,
} from "@/lib/public-scan";
import { kickPublicScanDrain } from "@/lib/public-scan-dispatcher";
import { verifyTurnstile } from "@/lib/turnstile";
import { normalizeUsername } from "@/lib/username";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "0.0.0.0";
}

/** Echo the client's Idempotency-Key so retries are correlatable. Scans are
 *  idempotent per username (shared cache + single-flight), so no storage needed. */
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

async function persistFreshQuickScan(
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
  // Record the lookup for heat/trending counts, but intentionally DON'T bust the
  // leaderboard cache here. Under real traffic this "counted" path fires
  // constantly (first lookup per IP per account per 24h), and clearing all 16
  // board variants each time meant the 5-min cache almost never survived — every
  // /leaderboard visit then ran the heavy 500-row triple JOIN and hammered Turso
  // (slow board + cascading DB timeouts elsewhere). A board that's up to one TTL
  // stale is perfectly fine; natural expiry refreshes it.
  await Promise.all([
    recordAccountLookup(username, ip),
    campaign ? recordCampaignParticipant(campaign, username) : Promise.resolve(),
  ]);
}

function durableStatusResponse(input: {
  username: string;
  resolution: Exclude<PublicScanResolution, { status: "complete" }>;
  headers: Record<string, string>;
}) {
  if (input.resolution.status === "pending") {
    return NextResponse.json(
      {
        error: "scan_enrichment_pending",
        status: "collecting_public_history",
        username: input.username,
        run_id: input.resolution.run.id,
        retry_after: input.resolution.retryAfterSeconds,
      },
      {
        status: 202,
        headers: {
          ...input.headers,
          "Cache-Control": "no-store",
          "Retry-After": String(input.resolution.retryAfterSeconds),
        },
      },
    );
  }
  if (input.resolution.status === "queue_full" || input.resolution.status === "admission_limited") {
    return apiError(input.resolution.status, {
      status: 429,
      headers: {
        ...input.headers,
        "Cache-Control": "no-store",
        "Retry-After": String(input.resolution.retryAfterSeconds),
      },
    });
  }
  return apiError("github_unavailable", {
    status: 503,
    headers: {
      ...input.headers,
      "Retry-After": String(input.resolution.retryAfterSeconds),
    },
  });
}

async function durableResponse(input: {
  username: string;
  scan: import("@/lib/types").ScanResult;
  headers: Record<string, string>;
  admission: ReturnType<typeof publicScanAdmission>;
}) {
  const resolution = await resolvePublicScanFromTrustedQuickScan(
    input.username,
    input.scan,
    input.admission,
  );
  if (resolution.status === "pending" && resolution.headStartJobId) {
    kickPublicScanDrain(resolution.headStartJobId);
  }
  if (resolution.status === "complete") {
    return NextResponse.json(
      { ...resolution.scan, cached: true, coverage: "complete_public" },
      { headers: input.headers },
    );
  }
  return durableStatusResponse({
    username: input.username,
    resolution,
    headers: input.headers,
  });
}

export async function POST(req: NextRequest) {
  const idem = idempotencyHeaders(req);

  // Fields stay `unknown`: scripted clients send numbers/objects here, and the
  // validators must answer with a 400 rather than crash on a type assumption.
  let body: { username?: unknown; turnstileToken?: unknown; campaign?: unknown };
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_body", { status: 400, headers: idem });
  }

  const username = normalizeUsername(body.username);
  if (!username) {
    return apiError("invalid_username", { status: 400, headers: idem });
  }
  const campaign = campaignSlug(body.campaign);
  if (body.campaign !== undefined && !campaign) {
    return apiError("invalid_body", { status: 400, headers: idem });
  }

  const ip = clientIp(req);

  const auth = machineAuth(req);
  if (auth === "invalid") {
    // An Authorization header was sent but the key is wrong — tell agents how to
    // authenticate (spec-shaped WWW-Authenticate is added by apiError on 401).
    return apiError("unauthorized", { status: 401, headers: idem });
  }
  if (auth === "absent") {
    const token = typeof body.turnstileToken === "string" ? body.turnstileToken : null;
    const human = await verifyTurnstile(token, ip);
    if (!human) {
      return apiError("turnstile_failed", { status: 403, headers: idem });
    }
  }
  const durableAdmission = publicScanAdmission(
    auth === "valid" ? `bearer:${req.headers.get("authorization") ?? ""}` : `ip:${ip}`,
  );

  // Rate-limit BEFORE the cache lookup. The cached path used to skip the
  // limiter as "cheap", but it still recorded a lookup per request — a bot
  // burst replaying cached usernames bypassed the limiter entirely and
  // exhausted Turso's connection pool (2026-07 incident).
  const limit = await checkRateLimit(ip);
  const rlHeaders = rateLimitHeaders(limit);
  if (!limit.success) {
    return apiError(limit.unavailable ? "rate_limit_unavailable" : "rate_limited", {
      status: limit.unavailable ? 503 : 429,
      headers: { ...idem, ...rlHeaders, "Cache-Control": "no-store" },
    });
  }

  // A cache entry is readable only when Turso has the matching complete run and
  // canonical score. Pre-deployment quick cache entries have neither a trusted
  // scan time nor provenance, so they are discarded and collected afresh.
  const cached = await getCachedScan(username);
  const status = await getPublicScanStatus(username);
  if (status?.status === "complete") {
    const scoreWrite = await ensureCanonicalScoreForPublicRun(status.run);
    if (!scoreWrite) return scorePersistenceUnavailable({ ...idem, ...rlHeaders });
    await setCachedScan(status.scan.metrics.username, status.scan);
    await recordSuccessfulLookup(status.scan.metrics.username, ip, campaign);
    return NextResponse.json(
      { ...status.scan, cached: true, coverage: "complete_public" },
      { headers: { ...idem, ...rlHeaders } },
    );
  }
  if (status) {
    await recordSuccessfulLookup(username, ip, campaign);
    return durableStatusResponse({
      username,
      resolution: status,
      headers: { ...idem, ...rlHeaders },
    });
  }
  if (cached) await clearCachedScan(cached.metrics.username);

  try {
    const result = await coalesceScan(username, async () => {
      const freshScanStartedAt = Date.now();
      const freshResult = await buildScanResult(username);
      if (
        !requiresDurablePublicScan(freshResult) &&
        !(await persistFreshQuickScan(freshResult, freshScanStartedAt))
      ) {
        throw new ScorePersistenceError();
      }
      return freshResult;
    });
    await recordSuccessfulLookup(result.metrics.username, ip, campaign);
    if (requiresDurablePublicScan(result)) {
      return durableResponse({
        username: result.metrics.username,
        scan: result,
        headers: { ...idem, ...rlHeaders },
        admission: durableAdmission,
      });
    }
    return NextResponse.json(
      { ...result, cached: false },
      { headers: { ...idem, ...rlHeaders } },
    );
  } catch (e) {
    if (e instanceof ScorePersistenceError) {
      return scorePersistenceUnavailable({ ...idem, ...rlHeaders });
    }
    const { error, status, retry_after } = scanErrorResponse(e);
    return apiError(error as Parameters<typeof apiError>[0], {
      status,
      headers: {
        ...idem,
        ...rlHeaders,
        ...(retry_after ? { "Retry-After": String(retry_after) } : {}),
      },
    });
  }
}
