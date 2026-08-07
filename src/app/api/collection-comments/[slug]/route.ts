import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Go owns collection comments; this only guards a deployment missing its backend rewrite. */
function unavailable() {
  return NextResponse.json(
    { error: "backend_not_configured" },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "15" } },
  );
}

export const GET = unavailable;
export const POST = unavailable;
