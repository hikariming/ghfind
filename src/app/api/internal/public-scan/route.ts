import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { drainPublicScanJobsFromCron } from "@/lib/public-scan-dispatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  const authorization = req.headers.get("authorization");
  return Boolean(secret && authorization && secureEqual(authorization, `Bearer ${secret}`));
}

function localWorkerAuthorized(req: NextRequest): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const secret = process.env.PUBLIC_SCAN_WORKER_SECRET;
  const supplied = req.headers.get("x-public-scan-worker-secret");
  return Boolean(secret && supplied && secureEqual(supplied, secret));
}

async function run(req: NextRequest) {
  if (!cronAuthorized(req) && !localWorkerAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await drainPublicScanJobsFromCron();
  return NextResponse.json({ status: "ok", ...result }, { headers: { "Cache-Control": "no-store" } });
}

// Vercel Cron issues a GET request with Authorization: Bearer $CRON_SECRET.
export async function GET(req: NextRequest) {
  return run(req);
}

// Kept for local operator invocation only; production accepts the same Cron
// credential but never accepts a user-controlled job id.
export async function POST(req: NextRequest) {
  return run(req);
}
