import { NextRequest, NextResponse } from "next/server";
import {
  getScoreBrief,
  hasProfileSnapshot,
  recordProfileSnapshot,
} from "@/lib/db";
import {
  AccountNotFoundError,
  GitHubAuthRequiredError,
  GitHubDataUnavailableError,
  GitHubRateLimitError,
  collect,
} from "@/lib/github";
import { checkRateLimit, coalesceScan, getCachedScan, rateLimitHeaders } from "@/lib/redis";
import { score } from "@/lib/score";
import type { ScanResult } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

function normalizeUsername(input: string): string | null {
  let s = input.trim();
  const m = s.match(/github\.com\/([^/?#]+)/i);
  if (m) s = m[1];
  s = s.replace(/^@/, "");
  return USERNAME_RE.test(s) ? s : null;
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "0.0.0.0";
}

/**
 * On-visit backfill for a scored profile that's missing its evidence snapshot
 * (contributed repos, languages, topics). Legacy `scores` rows predate the
 * profile-snapshot "data moat", so their detail pages render without the repo/
 * language sections. The detail page fires this when `getProfileSnapshot` is
 * null, then refreshes once it's filled.
 *
 * Scoped to accounts that already have a score row (no arbitrary crawling), and
 * reuses the scan cache + single-flight + per-IP limit so the GitHub fetch runs
 * at most once per legacy profile.
 */
export async function POST(req: NextRequest) {
  let body: { username?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const username = normalizeUsername(body.username ?? "");
  if (!username) {
    return NextResponse.json({ error: "invalid_username" }, { status: 400 });
  }

  // Gate before the score/snapshot existence reads. This is a public POST and
  // callers can otherwise turn a legacy-profile retry into two Turso reads even
  // after they have exhausted the expensive GitHub backfill budget.
  const ip = clientIp(req);
  const limit = await checkRateLimit(ip);
  if (!limit.success) {
    return NextResponse.json(
      { error: limit.unavailable ? "rate_limit_unavailable" : "rate_limited" },
      {
        status: limit.unavailable ? 503 : 429,
        headers: { ...rateLimitHeaders(limit), "Cache-Control": "no-store" },
      },
    );
  }

  // Only backfill real, visible scored profiles — never crawl arbitrary handles.
  const brief = await getScoreBrief(username);
  if (!brief) {
    return NextResponse.json({ error: "not_scored" }, { status: 404 });
  }

  // Already has a snapshot (possibly written between page render and this call).
  if (await hasProfileSnapshot(username)) {
    return NextResponse.json({ filled: false, reason: "exists" });
  }

  // Cheapest path: a recent scan is cached — persist it with zero GitHub calls.
  const cached = await getCachedScan(username);
  if (cached) {
    await recordProfileSnapshot(cached);
    return NextResponse.json({ filled: true, cached: true });
  }

  try {
    const result = await coalesceScan(username, async (): Promise<ScanResult> => {
      const collected = await collect(username);
      return { ...collected, scoring: score(collected.metrics) };
    });
    await recordProfileSnapshot(result);
    return NextResponse.json({ filled: true, cached: false });
  } catch (e) {
    if (e instanceof GitHubAuthRequiredError) {
      return NextResponse.json({ error: "github_token_required" }, { status: 500 });
    }
    if (e instanceof AccountNotFoundError) {
      return NextResponse.json({ error: "account_not_found" }, { status: 404 });
    }
    if (e instanceof GitHubRateLimitError) {
      return NextResponse.json({ error: "github_rate_limited" }, { status: 503 });
    }
    if (e instanceof GitHubDataUnavailableError) {
      return NextResponse.json(
        { error: "github_unavailable", retry_after: 60 },
        { status: 503, headers: { "Retry-After": "60" } },
      );
    }
    console.error("profile backfill failed:", e);
    return NextResponse.json({ error: "backfill_failed" }, { status: 500 });
  }
}
