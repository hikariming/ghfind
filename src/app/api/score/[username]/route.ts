import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Go owns score collection/persistence; this only guards a missing backend rewrite. */
export function GET() {
  return NextResponse.json(
    { error: "backend_not_configured" },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "15" } },
  );
}
