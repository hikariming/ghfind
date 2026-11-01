import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { isAutomatedClient } from "@/lib/auto-rescan";
import {
  AUTO_REROAST_TRIGGER,
  admitAutoReroast,
  autoReroastDisabled,
  autoReroastMaxPerHour,
  isActiveJob,
  readAutoReroastJob,
  type AutoReroastDeferral,
  type AutoReroastJob,
} from "@/lib/auto-reroast";
import { ROAST_CACHE_VERSION } from "@/lib/cache-version";
import { getAccountDetail } from "@/lib/db";
import { normLang, type Lang } from "@/lib/lang";
import { machineAuth } from "@/lib/machine-auth";
import { autoReroastStore, checkRateLimit, rateLimitHeaders } from "@/lib/redis";
import { isCurrentScoreProvenance } from "@/lib/score-version";
import { normalizeUsername } from "@/lib/username";

/**
 * On-view roast regeneration after a roast-release upgrade (see
 * src/lib/auto-reroast.ts). POST admits and enqueues one job (202 + Location);
 * GET is the read-only status the page polls. Generation itself runs in the
 * ghfind-api cron, never in this request.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

const DEFERRAL_STATUS: Record<AutoReroastDeferral, number> = {
  disabled: 503,
  automated_client: 403,
  not_eligible: 409,
  cooldown: 429,
  budget: 429,
  unavailable: 503,
};

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("cf-connecting-ip")?.trim() ||
    req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ||
    "0.0.0.0"
  );
}

function statusUrl(username: string, lang: Lang): string {
  return `/api/roast/auto?username=${encodeURIComponent(username)}&lang=${lang}`;
}

function deferred(
  username: string,
  lang: Lang,
  reason: AutoReroastDeferral,
  headers: Record<string, string> = {},
  retryAfter?: number,
) {
  console.log("auto_reroast", { outcome: "deferred", reason, username, lang });
  return NextResponse.json(
    { error: "auto_reroast_deferred", reason, state: "none", target_version: ROAST_CACHE_VERSION },
    {
      status: DEFERRAL_STATUS[reason],
      headers: { ...headers, ...NO_STORE, ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) },
    },
  );
}

function jobBody(job: AutoReroastJob | null, current: boolean) {
  return {
    state: current ? "done" : (job?.state ?? "none"),
    target_version: ROAST_CACHE_VERSION,
    ...(job && !current && job.state === "failed" && job.reason ? { reason: job.reason } : {}),
  };
}

type Eligibility = "eligible" | "current" | "ineligible";

/** Server-side truth: current score, but no current-release report in `lang`. */
async function eligibility(username: string, lang: Lang): Promise<Eligibility> {
  const detail = await getAccountDetail(username);
  if (!detail || detail.legacy_read_fallback) return "ineligible";
  if (
    !isCurrentScoreProvenance({
      scoreVersion: detail.score_version,
      sourceCollectionVersion: detail.score_source_collection_version,
      sourceSnapshotHash: detail.score_source_snapshot_hash,
    })
  ) {
    return "ineligible";
  }
  // getAccountDetail exposes report text only on the current roast release.
  return (lang === "en" ? detail.roast_en : detail.roast) ? "current" : "eligible";
}

export async function POST(req: NextRequest) {
  let body: { username?: unknown; lang?: unknown; trigger?: unknown };
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_body", { status: 400 });
  }
  const username = normalizeUsername(body.username);
  if (!username) return apiError("invalid_username", { status: 400 });
  if (body.trigger !== undefined && body.trigger !== AUTO_REROAST_TRIGGER) {
    return apiError("invalid_body", { status: 400 });
  }
  const lang = normLang(body.lang);

  if (autoReroastDisabled()) return deferred(username, lang, "disabled");
  if (isAutomatedClient(req.headers)) return deferred(username, lang, "automated_client");
  const auth = await machineAuth(req);
  if (auth !== "absent") return deferred(username, lang, "automated_client");

  const limit = await checkRateLimit(clientIp(req));
  const rl = rateLimitHeaders(limit);
  if (!limit.success) {
    return NextResponse.json(
      { error: limit.unavailable ? "rate_limit_unavailable" : "rate_limited" },
      { status: limit.unavailable ? 503 : 429, headers: { ...rl, ...NO_STORE } },
    );
  }

  const store = autoReroastStore();
  const existing = await readAutoReroastJob(store, username, lang);
  if (isActiveJob(existing)) {
    return NextResponse.json(jobBody(existing, false), {
      status: 202,
      headers: { ...rl, ...NO_STORE, Location: statusUrl(username, lang) },
    });
  }

  const state = await eligibility(username, lang);
  if (state === "current") {
    return NextResponse.json(jobBody(null, true), { headers: { ...rl, ...NO_STORE } });
  }
  if (state === "ineligible") return deferred(username, lang, "not_eligible", rl);

  const admission = await admitAutoReroast(store, { username, lang }, { maxPerHour: autoReroastMaxPerHour() });
  if (!admission.ok) {
    return deferred(username, lang, admission.reason, rl, admission.retryAfter);
  }
  if (!admission.existing) {
    console.log("auto_reroast", {
      outcome: "queued",
      username: admission.job.username,
      lang,
      to_roast_version: admission.job.target,
    });
  }
  return NextResponse.json(jobBody(admission.job, false), {
    status: 202,
    headers: { ...rl, ...NO_STORE, Location: statusUrl(username, lang) },
  });
}

export async function GET(req: NextRequest) {
  const username = normalizeUsername(req.nextUrl.searchParams.get("username"));
  if (!username) return apiError("invalid_username", { status: 400 });
  const lang = normLang(req.nextUrl.searchParams.get("lang"));
  const job = await readAutoReroastJob(autoReroastStore(), username, lang);
  // Only a finished job needs the row read; queued/running answer from the store.
  const current = !isActiveJob(job) && (await eligibility(username, lang)) === "current";
  return NextResponse.json(jobBody(job, current), { headers: NO_STORE });
}
