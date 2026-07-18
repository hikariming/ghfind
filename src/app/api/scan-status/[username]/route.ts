import { NextRequest, NextResponse } from "next/server";
import { getPublicScanStatus } from "@/lib/public-scan";
import { normalizeUsername } from "@/lib/username";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Poll only a previously queued durable collection. This endpoint never starts
 * a GitHub scan, so browsers and agents can safely wait without creating work.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ username: string }> },
) {
  const { username } = await ctx.params;
  const handle = normalizeUsername(decodeURIComponent(username ?? ""));
  if (!handle) return NextResponse.json({ error: "invalid_username" }, { status: 400 });
  const status = await getPublicScanStatus(handle);
  if (!status) return NextResponse.json({ error: "scan_not_found" }, { status: 404 });
  if (!status.run) {
    return NextResponse.json({ error: "durable_scan_unavailable" }, { status: 503 });
  }
  if (status.status === "complete") {
    return NextResponse.json(
      { status: "complete_public", username: status.run.username, run_id: status.run.id, scan: status.scan },
      { headers: { "Cache-Control": "no-store" } },
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
        "Cache-Control": "no-store",
        "Retry-After": String(status.retryAfterSeconds),
      },
    },
  );
}
