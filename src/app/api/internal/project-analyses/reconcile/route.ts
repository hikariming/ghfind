import { NextRequest, NextResponse } from "next/server";
import { recoverProjectAnalysis, ProjectAnalysisServiceError, reconcilePendingProjectAnalyses } from "@/lib/project-analysis-service";

import { getProjectAnalysisRecovery } from "@/lib/project-analysis-db";

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
  if (req.method === "POST" && req.headers.get("content-type")?.includes("application/json")) {
    try {
      const reader = req.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) { await reader.cancel(); return NextResponse.json({ error: "request_too_large" }, { status: 413 }); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const input = JSON.parse(new TextDecoder().decode(bytes));
      const run = await recoverProjectAnalysis(input);
      const audit = await getProjectAnalysisRecovery(run.id);
      if (!audit) throw new Error("recovery_audit_missing");
      return NextResponse.json({ analysisId: run.id, requestedRef: run.requestedRef, status: run.status,
        idempotencyKey: run.idempotencyKey, threadId: run.mosooThreadId, runId: run.mosooRunId,
        startedAt: run.startedAt, createAttempts: run.createAttempts,
        recovery: { requestId: audit.requestId, action: audit.action, executionDeadlineAt: audit.executionDeadlineAt,
          createdAt: audit.createdAt, priorThreadId: audit.expectedThreadId, priorRunId: audit.expectedRunId,
          nextIdempotencyKey: audit.nextIdempotencyKey } }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const status = error instanceof ProjectAnalysisServiceError ? error.status : error instanceof SyntaxError ? 400 : 503;
      return NextResponse.json({ error: error instanceof ProjectAnalysisServiceError ? error.code : "analysis_recovery_unavailable" },
        { status, headers: { "Cache-Control": "no-store" } });
    }
  }
  const result = await reconcilePendingProjectAnalyses(20);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

export const GET = reconcile;
export const POST = reconcile;
