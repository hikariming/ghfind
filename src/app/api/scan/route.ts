import { NextRequest, NextResponse } from "next/server";
import { recordAccountLookup } from "@/lib/db";
import {
  AccountNotFoundError,
  GitHubAuthRequiredError,
  GitHubRateLimitError,
  collect,
} from "@/lib/github";
import {
  checkRateLimit,
  clearCachedLeaderboards,
  coalesceScan,
  getCachedScan,
} from "@/lib/redis";
import { score } from "@/lib/score";
import { verifyTurnstile } from "@/lib/turnstile";
import type { ScanResult } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

/** Extract a bare handle from a username or profile URL. */
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

async function recordSuccessfulLookup(username: string, ip: string): Promise<void> {
  const counted = await recordAccountLookup(username, ip);
  if (counted) await clearCachedLeaderboards();
}

export async function POST(req: NextRequest) {
  let body: { username?: string; turnstileToken?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const username = normalizeUsername(body.username ?? "");
  if (!username) {
    return NextResponse.json({ error: "invalid_username" }, { status: 400 });
  }

  const ip = clientIp(req);

  const human = await verifyTurnstile(body.turnstileToken ?? null, ip);
  if (!human) {
    return NextResponse.json({ error: "turnstile_failed" }, { status: 403 });
  }

  // Cache hit short-circuits both GitHub and (later) the LLM. The leaderboard
  // row + percentile are produced by /api/roast (which has the AI-adjusted final
  // score), so the scan response stays purely the deterministic result.
  const cached = await getCachedScan(username);
  if (cached) {
    await recordSuccessfulLookup(cached.metrics.username, ip);
    return NextResponse.json({ ...cached, cached: true });
  }

  const { success } = await checkRateLimit(ip);
  if (!success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  try {
    const result = await coalesceScan(username, async (): Promise<ScanResult> => {
      const { metrics, top_repos, recent_prs, flood_pr_titles, impact_repos, verified_impact_prs } =
        await collect(username);
      const scoring = score(metrics);
      return { metrics, top_repos, recent_prs, flood_pr_titles, impact_repos, verified_impact_prs, scoring };
    });
    await recordSuccessfulLookup(result.metrics.username, ip);
    return NextResponse.json({ ...result, cached: false });
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
    console.error("scan failed:", e);
    return NextResponse.json({ error: "scan_failed" }, { status: 500 });
  }
}
