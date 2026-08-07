import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Go owns follow state; this only guards a deployment missing its backend rewrite. */
export function GET() {
  return NextResponse.json(
    { error: "backend_not_configured" },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "15" } },
  );
}
