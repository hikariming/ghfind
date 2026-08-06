import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;

/**
 * The Go API owns all roast handling: rate limits, cached snapshot lookup,
 * provider streaming, control frames and CAS persistence. When configured,
 * next.config.ts rewrites this same-origin path before this fallback runs.
 */
export function POST() {
  return NextResponse.json(
    {
      error: "backend_not_configured",
      message: "The Go roast API is not configured for this deployment.",
    },
    {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "15" },
    },
  );
}
