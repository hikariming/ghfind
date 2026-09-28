import { NextRequest, NextResponse } from "next/server";
import { enqueueDevscoreBackfill, listReadyDevscoreJobs } from "@/lib/db";
import { advanceDevscoreJob, DEVSCORE_STEP_BUDGET_MS } from "@/lib/devscore-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_JOBS = 10;
const DEFAULT_JOBS = 3;
const MAX_BACKFILL = 500;
/** Backfill never lets the active queue exceed this many jobs (GitHub quota guard). */
const BACKFILL_ACTIVE_CAP = 50;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  return req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] === secret;
}

function boundedInt(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(0, Math.min(max, n));
}

/**
 * Recovery driver for background devscore jobs (Bearer CRON_SECRET, like the
 * project-analysis reconcile route). Body (all optional):
 *   {"jobs": N}      advance up to N ready jobs (default 3, max 10) — abandoned
 *                    jobs whose page was closed, expired leases, due retries;
 *   {"backfill": N}  first enqueue up to N accounts still on the previous score
 *                    release (highest score, then most recently looked up),
 *                    never exceeding 50 active jobs.
 * The jobs share one ~35 s step budget inside the 60 s route.
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { jobs?: unknown; backfill?: unknown } = {};
  if (req.headers.get("content-type")?.includes("application/json")) {
    try {
      body = (await req.json()) ?? {};
    } catch {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }
  }
  const startedAt = Date.now();
  const deadline = startedAt + DEVSCORE_STEP_BUDGET_MS;
  const backfillLimit = boundedInt(body.backfill, 0, MAX_BACKFILL);
  const backfill = backfillLimit > 0
    ? await enqueueDevscoreBackfill({ limit: backfillLimit, activeCap: BACKFILL_ACTIVE_CAP, now: startedAt })
    : null;

  const usernames = await listReadyDevscoreJobs(boundedInt(body.jobs, DEFAULT_JOBS, MAX_JOBS), startedAt);
  const results = await Promise.all(
    usernames.map(async (username) => {
      try {
        const advanced = await advanceDevscoreJob(username, deadline);
        return { username, status: advanced?.status ?? null, published: Boolean(advanced?.result) };
      } catch (error) {
        console.error("devscore advance failed:", error);
        return { username, status: null, published: false };
      }
    }),
  );
  return NextResponse.json(
    { advanced: results, ...(backfill ? { backfill } : {}) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
