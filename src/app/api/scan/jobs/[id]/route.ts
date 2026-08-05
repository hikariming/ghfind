import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Go owns public scan job status. This fallback fails closed when the same-origin
 * backend rewrite is missing; it must not expose the admin-only job endpoint.
 */
export function GET() {
  return NextResponse.json(
    { error: "backend_not_configured" },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "15" } },
  );
}
