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
  startPublicScan,
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

function durableStatusResponse(input: {
  username: string;
  resolution: Exclude<PublicScanResolution, { status: "complete" | "stale" }>;
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

async function staleSnapshotResponse(input: {
  username: string;
  status: Extract<PublicScanResolution, { status: "stale" }>;
  admission: ReturnType<typeof publicScanAdmission>;
  headers: Record<string, string>;
}) {
  const refresh = input.status.refreshPending
    ? null
    : await startPublicScan(input.username, input.admission);
  const refreshRun = refresh && "run" in refresh ? refresh.run : input.status.refreshRun;
  const refreshPending = input.status.refreshPending || refresh?.status === "pending";
  if (refresh?.status === "pending" && refresh.headStartJobId) {
    kickPublicScanDrain(refresh.headStartJobId);
  }
  return NextResponse.json(
    {
      ...input.status.scan,
      cached: true,
      coverage: "complete_public",
      stale: true,
      refresh_pending: refreshPending,
      served_collection_version: input.status.servedCollectionVersion,
      target_collection_version: input.status.targetCollectionVersion,
      ...(refreshRun ? { run_id: refreshRun.id } : {}),
    },
    { headers: { ...input.headers, "Cache-Control": "no-store" } },
  );
}

/**
 * An explicit scan may ask for canonical v9/v4 work, but a verified v5/v5/v3
 * artifact is still immediately useful to the visitor. The refresh attempt is
 * intentionally best-effort: queue or storage pressure must never turn a
 * readable historical profile back into a waiting screen.
 */
async function legacyReadFallbackResponse(input: {
  username: string;
  scan: import("@/lib/types").ScanResult;
  admission: ReturnType<typeof publicScanAdmission>;
  headers: Record<string, string>;
}) {
  let refresh: PublicScanResolution | null = null;
  try {
    refresh = await startPublicScan(input.username, input.admission);
    if (refresh.status === "pending" && refresh.headStartJobId) {
      kickPublicScanDrain(refresh.headStartJobId);
    }
  } catch {
    // The fallback has already passed provenance validation. A failed refresh
    // attempt must not withhold it from the visitor.
    console.error("legacyReadFallback refresh start failed");
  }
  const refreshRun = refresh && "run" in refresh ? refresh.run : null;
  return NextResponse.json(
    {
      ...input.scan,
      cached: true,
      coverage: "complete_public",
      stale: true,
      legacy_read_fallback: true,
      refresh_pending: refresh?.status === "pending",
      served_score_version: LEGACY_READ_FALLBACK.score,
      served_roast_version: LEGACY_READ_FALLBACK.roast,
      served_collection_version: LEGACY_READ_FALLBACK.collection,
      target_score_version: RUNTIME_RELEASE_VERSIONS.score,
      target_roast_version: RUNTIME_RELEASE_VERSIONS.roast,
      target_collection_version: RUNTIME_RELEASE_VERSIONS.collection,
      ...(refreshRun ? { run_id: refreshRun.id } : {}),
    },
    { headers: { ...input.headers, "Cache-Control": "no-store" } },
  );
}

/**
 * A v5/v5 profile can be useful even when the old v3 ScanResult has expired.
 * Return a dedicated handoff rather than inventing a partial scan payload; the
 * profile page reads the persisted artifact while the canonical v9/v4 job runs.
 */
async function legacyReadFallbackProfileResponse(input: {
  username: string;
  admission: ReturnType<typeof publicScanAdmission>;
  headers: Record<string, string>;
}) {
  let refresh: PublicScanResolution | null = null;
  try {
    refresh = await startPublicScan(input.username, input.admission);
    if (refresh.status === "pending" && refresh.headStartJobId) {
      kickPublicScanDrain(refresh.headStartJobId);
    }
  } catch {
    // A persisted read-only profile remains useful when the refresh queue is
    // temporarily unavailable.
    console.error("legacyReadFallback profile refresh start failed");
  }
  const refreshRun = refresh && "run" in refresh ? refresh.run : null;
  return NextResponse.json(
    {
      username: input.username,
      cached: true,
      stale: true,
      legacy_read_fallback: true,
      legacy_profile: true,
      refresh_pending: refresh?.status === "pending",
      served_score_version: LEGACY_READ_FALLBACK.score,
      served_roast_version: LEGACY_READ_FALLBACK.roast,
      served_collection_version: LEGACY_READ_FALLBACK.collection,
      target_score_version: RUNTIME_RELEASE_VERSIONS.score,
      target_roast_version: RUNTIME_RELEASE_VERSIONS.roast,
      target_collection_version: RUNTIME_RELEASE_VERSIONS.collection,
      ...(refreshRun ? { run_id: refreshRun.id } : {}),
    },
    { headers: { ...input.headers, "Cache-Control": "no-store" } },
  );
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

  // The home flow starts here, before the profile page and /api/roast have a
  // chance to replay a report. Without this handoff, a known-good v5/v5/v3
  // artifact was hidden behind a v9/v4 collection wait. An explicit request
  // may start canonical work, but only after this verified legacy result has
  // been selected; it is never written into current caches or scores.
  const legacyScan = await getLegacyReadFallbackScan(username);
  if (legacyScan) {
    return legacyReadFallbackResponse({
      username: legacyScan.metrics.username,
      scan: legacyScan,
      admission: durableAdmission,
      headers: { ...idem, ...rlHeaders },
    });
  }

  // A complete old ScanResult is optional for continuity. The normal v5
  // profile path below has an exact stored v5 score/report but no longer has
  // its full v3 snapshot, so hand the browser to the profile instead of making
  // it wait for a v9/v4 crawl or fabricating a scan payload.
  if (await hasLegacyReadFallbackProfile(username)) {
    return legacyReadFallbackProfileResponse({
      username,
      admission: durableAdmission,
      headers: { ...idem, ...rlHeaders },
    });
  }

  // A cache entry is readable only when Turso has the matching complete run and
  // canonical score. Pre-deployment quick cache entries have neither a trusted
  // scan time nor provenance, so they are discarded and collected afresh.
  const cached = await getCachedScan(username);
  if (status?.status === "stale") {
    await recordSuccessfulLookup(status.scan.metrics.username, ip, campaign);
    return staleSnapshotResponse({
      username: status.scan.metrics.username,
      status,
      admission: durableAdmission,
      headers: { ...idem, ...rlHeaders },
    });
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
