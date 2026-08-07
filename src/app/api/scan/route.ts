import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/scan is Go-owned through the same-origin rewrite in next.config.ts.
 * This guard deliberately contains no authentication, cache, GitHub, scoring,
 * or Turso fallback logic: accepting a scan here would split the durable job
 * contract between two runtimes during a deployment misconfiguration.
 */
export function POST() {
  return NextResponse.json(
    { error: "backend_not_configured" },
    {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "15" },
    },
  );
}
