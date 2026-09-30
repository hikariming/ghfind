import { NextRequest, NextResponse, after } from "next/server";
import { notifyCampaignCardGenerated } from "@/lib/campaign-notify";
import { campaignSlug, type CampaignSlug } from "@/lib/campaigns";
import {
  hasLegacyReadFallbackProfile,
  getCurrentCanonicalQuickScan,
  getLegacyReadFallbackScan,
  recordAccountLookup,
  recordCampaignParticipant,
} from "@/lib/db";
import { requestDevscoreJob } from "@/lib/devscore-jobs";
import {
  checkRateLimit,
  getCachedScan,
  rateLimitHeaders,
} from "@/lib/redis";
import {
  attachAnonymousSession,
  establishAnonymousSession,
  type AnonymousSession,
} from "@/lib/anonymous-session";
import { apiError } from "@/lib/api-error";
import { machineAuth } from "@/lib/machine-auth";
import { logFreshScanFailure } from "@/lib/scan-core";
import { scanStatusUrl, type ScanJobStatus } from "@/lib/scan-job-client";
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
    hint: "Retry later; no score job could be recorded.",
    headers: {
      ...headers,
      "Cache-Control": "no-store",
      "Retry-After": "5",
    },
  });
}

/**
 * First-time lookups are scored by a background devscore job: 202 with the
 * status Location. Polling that Location advances the job and returns the
 * published ScanResult once the score exists.
 */
function pendingResponse(input: {
  username: string;
  status: ScanJobStatus;
  headers: Record<string, string>;
}) {
  const location = scanStatusUrl(input.username);
  return NextResponse.json(
    { username: input.username, status: input.status, status_url: location },
    {
      status: 202,
      headers: { ...input.headers, Location: location, "Cache-Control": "no-store", "Retry-After": "2" },
    },
  );
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
 * A verified previous-release profile is only an emergency read fallback, served
 * when a new score job cannot be admitted. A published current score always wins.
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
  // `?force=1` (RescanButton) skips the published score and starts a fresh
  // devscore job; admission/rate limits above still apply.
  const force = req.nextUrl.searchParams.get("force") === "1";
  const cached = force
    ? null
    : (await getCachedScan(username)) ?? (await getCurrentCanonicalQuickScan(username))?.scan ?? null;
  if (cached) {
    // A published snapshot replays read-only: republishing it with Date.now()
    // would make an old score look freshly scanned and reset the rescan cooldown.
    await recordSuccessfulLookup(cached.metrics.username, ip, campaign);
    return attachAnonymousSession(
      immediateResponse({ scan: cached, cached: true, headers: { ...idem, ...rlHeaders } }),
      anonymousSession,
    );
  }

  let status: ScanJobStatus | null;
  let jobError: unknown = null;
  try {
    status = await requestDevscoreJob(username, { rescan: force });
  } catch (error) {
    jobError = error;
    status = null;
  }
  if (!status) {
    // No job could be recorded: log through the allowlisted boundary before
    // any legacy fallback can answer 200.
    logFreshScanFailure(jobError, { route: "scan", username: username, persistenceFailure: true });
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
    return scorePersistenceUnavailable({ ...idem, ...rlHeaders });
  }
  await recordSuccessfulLookup(username, ip, campaign);
  return attachAnonymousSession(
    pendingResponse({ username, status, headers: { ...idem, ...rlHeaders } }),
    anonymousSession,
  );
}
