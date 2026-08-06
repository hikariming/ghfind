import { NextRequest, NextResponse } from "next/server";
import { reconcilePendingProjectAnalyses } from "@/lib/project-analysis-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  const expected = [
    process.env.PROJECT_ANALYSIS_RECONCILE_SECRET,
    process.env.CRON_SECRET,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (expected.length === 0) return false;
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const explicit = req.headers.get("x-reconcile-secret");
  return expected.some((secret) => bearer === secret || explicit === secret);
}

async function reconcile(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const result = await reconcilePendingProjectAnalyses(20);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

export const GET = reconcile;
export const POST = reconcile;
