import { NextRequest, NextResponse } from "next/server";
import { getPublicScanStatus } from "@/lib/public-scan";
import { checkPublicScanStatusRateLimit, rateLimitHeaders } from "@/lib/redis";
import { normalizeUsername } from "@/lib/username";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PENDING_CACHE = "public, max-age=0, s-maxage=5, stale-while-revalidate=15";
const COMPLETE_CACHE = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
}

/**
 * Poll only a previously queued durable collection. This endpoint never starts
 * a GitHub scan, so browsers and agents can safely wait without creating work.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ username: string }> },
) {
  const { username } = await ctx.params;
  const handle = normalizeUsername(decodeURIComponent(username ?? ""));
  if (!handle) return NextResponse.json({ error: "invalid_username" }, { status: 400 });

  // The initiating response carries this opaque id. Requiring it keeps a public
  // username from becoming an unbounded status-read target for arbitrary bots.
  const runId = req.nextUrl.searchParams.get("run_id")?.trim();
  if (!runId) return NextResponse.json({ error: "run_id_required" }, { status: 400 });

  const limit = await checkPublicScanStatusRateLimit(clientIp(req));
  const headers = rateLimitHeaders(limit);
  if (!limit.success) {
    return NextResponse.json(
      {
        error: limit.unavailable ? "rate_limit_unavailable" : "rate_limited",
        retry_after: Number(headers["Retry-After"] ?? 1),
      },
      { status: limit.unavailable ? 503 : 429, headers: { ...headers, "Cache-Control": "no-store" } },
    );
  }

  const status = await getPublicScanStatus(handle);
  if (!status || !status.run || status.run.id !== runId) {
    return NextResponse.json({ error: "scan_not_found" }, { status: 404, headers });
  }
  if (status.status === "complete") {
    return NextResponse.json(
      { status: "complete_public", username: status.run.username, run_id: status.run.id, scan: status.scan },
      { headers: { ...headers, "Cache-Control": COMPLETE_CACHE } },
    );
  }
  return NextResponse.json(
    {
      status: status.status,
      username: status.run.username,
      run_id: status.run.id,
      retry_after: status.retryAfterSeconds,
      ...(status.status === "failed" ? { error: "durable_scan_failed" } : {}),
    },
    {
      status: status.status === "failed" ? 503 : 202,
      headers: {
        ...headers,
        "Cache-Control": status.status === "failed" ? "no-store" : PENDING_CACHE,
        "Retry-After": String(status.retryAfterSeconds),
      },
    },
  );
}
