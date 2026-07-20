import { NextRequest, NextResponse } from "next/server";
import { campaignSlug, type CampaignSlug } from "@/lib/campaigns";
import {
  ensureCanonicalScoreForPublicRun,
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

async function staleSnapshotResponse(input: {
  status: Extract<PublicScanResolution, { status: "stale" }>;
  headers: Record<string, string>;
}) {
  return NextResponse.json(
    {
      ...input.status.scan,
      cached: true,
      coverage: "complete_public",
      stale: true,
      refresh_pending: input.status.refreshPending,
      served_collection_version: input.status.servedCollectionVersion,
      target_collection_version: input.status.targetCollectionVersion,
      ...(input.status.refreshRun ? { run_id: input.status.refreshRun.id } : {}),
    },
    { headers: { ...input.headers, "Cache-Control": "no-store" } },
  );
}

/**
 * An explicit scan may ask for canonical v9/v4 work, but a verified v5/v5/v3
 * artifact is still immediately useful to the visitor. Reading it never starts
 * full-history work: only a newly collected quick scan can prove that a full
 * collection is required.
 */
async function legacyReadFallbackResponse(input: {
  scan: import("@/lib/types").ScanResult;
  headers: Record<string, string>;
}) {
  return NextResponse.json(
    {
      ...input.scan,
      cached: true,
      coverage: "complete_public",
      stale: true,
      legacy_read_fallback: true,
      refresh_pending: false,
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

/**
 * A v5/v5 profile can be useful even when the old v3 ScanResult has expired.
 * Return a dedicated handoff rather than inventing a partial scan payload; the
 * profile page reads the persisted artifact. A later explicit scan collects a
 * fresh quick result before deciding whether to enqueue canonical v9/v9/v4.
 */
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
      refresh_pending: false,
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

/**
 * Deliver the trusted bounded result immediately, then let the server worker
 * complete the evidence only when its metrics prove the bounded history is
 * incomplete. This response is deliberately not a canonical artifact: formal
 * v9/v9/v4 storage is written only by a complete quick scan or the durable run.
 */
async function provisionalQuickResponse(input: {
  username: string;
  scan: import("@/lib/types").ScanResult;
  cached: boolean;
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
    const scoreWrite = await ensureCanonicalScoreForPublicRun(resolution.run);
    if (!scoreWrite) return scorePersistenceUnavailable(input.headers);
    await setCachedScan(resolution.scan.metrics.username, resolution.scan);
    return NextResponse.json(
      { ...resolution.scan, cached: true, coverage: "complete_public" },
      { headers: input.headers },
    );
  }
  return NextResponse.json(
    {
      ...input.scan,
      cached: input.cached,
      coverage: "quick",
      provisional: true,
      refresh_pending: resolution.status === "pending",
      enrichment_status: resolution.status,
      ...(resolution.status === "pending"
        ? { run_id: resolution.run.id, retry_after: resolution.retryAfterSeconds }
        : { retry_after: resolution.retryAfterSeconds }),
    },
    { headers: { ...input.headers, "Cache-Control": "no-store" } },
  );
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

  // Check the canonical durable state first. It always wins over the emergency
  // read fallback if a v9/v4 result already exists.
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

  // A current-release quick cache is a server-authored bounded snapshot. It is
  // valid for an immediate provisional roast even while a durable run is
  // pending; the worker replaces it atomically with the complete v9/v9/v4
  // snapshot when all evidence arrives.
  const cached = await getCachedScan(username);
  if (cached) {
    await recordSuccessfulLookup(cached.metrics.username, ip, campaign);
    if (requiresDurablePublicScan(cached)) {
      return provisionalQuickResponse({
        username: cached.metrics.username,
        scan: cached,
        cached: true,
        headers: { ...idem, ...rlHeaders },
        admission: durableAdmission,
      });
    }
    return NextResponse.json(
      { ...cached, cached: true, coverage: "complete_public" },
      { headers: { ...idem, ...rlHeaders } },
    );
  }

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
      return provisionalQuickResponse({
        username: result.metrics.username,
        scan: result,
        cached: false,
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
    // A failed fresh quick scan must not hide a verified v5/v5/v3 artifact,
    // but serving the fallback alone never schedules canonical work. A future
    // successful quick scan will decide whether the account actually needs it.
    const legacyScan = await getLegacyReadFallbackScan(username);
    if (legacyScan) {
      return legacyReadFallbackResponse({
        scan: legacyScan,
        headers: { ...idem, ...rlHeaders },
      });
    }
    if (await hasLegacyReadFallbackProfile(username)) {
      return legacyReadFallbackProfileResponse({
        username,
        headers: { ...idem, ...rlHeaders },
      });
    }
    if (status?.status === "stale") {
      await recordSuccessfulLookup(status.scan.metrics.username, ip, campaign);
      return staleSnapshotResponse({
        status,
        headers: { ...idem, ...rlHeaders },
      });
    }
    const { error, status: responseStatus, retry_after } = scanErrorResponse(e);
    return apiError(error as Parameters<typeof apiError>[0], {
      status: responseStatus,
      headers: {
        ...idem,
        ...rlHeaders,
        ...(retry_after ? { "Retry-After": String(retry_after) } : {}),
      },
    });
  }
}
