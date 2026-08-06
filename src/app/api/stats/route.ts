import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `/api/stats` is Go-owned. When `GHFIND_BACKEND_ORIGIN` is configured,
 * next.config.ts transparently rewrites this path before this fallback can run.
 * Keeping an explicit misconfiguration response avoids silently returning a
 * stale Next implementation that still owns Turso/Redis access.
 */
export function GET() {
  return NextResponse.json(
    {
      error: "backend_not_configured",
      message: "The Go API origin is not configured for this deployment.",
    },
    {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "15" },
    },
  );
}
