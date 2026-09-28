import { NextRequest, NextResponse } from "next/server";
import { advanceDevscoreJob, DEVSCORE_STEP_BUDGET_MS } from "@/lib/devscore-jobs";
import { scanErrorResponse } from "@/lib/scan-core";
import { decodeRouteParam } from "@/lib/route-params";
import { normalizeUsername } from "@/lib/username";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Status of one account's background devscore job. Each poll advances the job
 * by one step (≈35 s budget), so an open page drives its own computation:
 * `202 {status}` while computing, `200 {status, result}` once the v11 score is
 * published, `404` without a job.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ username: string }> },
) {
  const { username } = await ctx.params;
  const handle = normalizeUsername(decodeRouteParam(username ?? ""));
  if (!handle) {
    return NextResponse.json({ error: "invalid_username" }, { status: 400, headers: NO_STORE });
  }
  let advanced;
  try {
    advanced = await advanceDevscoreJob(handle, Date.now() + DEVSCORE_STEP_BUDGET_MS);
  } catch (error) {
    const { error: code, status, retry_after } = scanErrorResponse(error);
    return NextResponse.json(
      { error: code, status: { state: "running", error: code } },
      { status, headers: { ...NO_STORE, "Retry-After": String(retry_after ?? 15) } },
    );
  }
  if (!advanced) {
    return NextResponse.json(
      { error: "not_found", status: { state: "failed", error: "scan_job_not_found" } },
      { status: 404, headers: NO_STORE },
    );
  }
  if (advanced.result) {
    return NextResponse.json({ status: advanced.status, result: advanced.result }, { headers: NO_STORE });
  }
  // A failed job is a finished poll: 200 with the recorded error code.
  const status = advanced.status.state === "failed" ? 200 : 202;
  return NextResponse.json({ status: advanced.status }, { status, headers: NO_STORE });
}
