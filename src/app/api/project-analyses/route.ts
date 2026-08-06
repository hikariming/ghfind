import { NextRequest, NextResponse } from "next/server";
import { ProjectAnalysisDatabaseError } from "@/lib/project-analysis-db";
import {
  createProjectAnalysis,
  getReusableProjectAnalysis,
  projectAnalysisRetryState,
  ProjectAnalysisServiceError,
} from "@/lib/project-analysis-service";
import { MosooProjectAnalysisError } from "@/lib/mosoo-project-analysis";
import {
  checkProjectAnalysisRateLimit,
  rateLimitHeaders,
} from "@/lib/project-analysis-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof ProjectAnalysisServiceError) {
    return NextResponse.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
  if (error instanceof MosooProjectAnalysisError) {
    return NextResponse.json(
      { error: error.code, message: error.message },
      {
        status: error.status,
        headers: error.retryAfterSeconds
          ? { "Retry-After": String(error.retryAfterSeconds) }
          : undefined,
      },
    );
  }
  if (error instanceof ProjectAnalysisDatabaseError) {
    return NextResponse.json(
      { error: "analysis_persistence_unavailable", message: error.message },
      { status: 503 },
    );
  }
  console.error("create project analysis failed", error);
  return NextResponse.json(
    { error: "analysis_create_failed", message: "Project analysis could not be created." },
    { status: 500 },
  );
}

export async function POST(req: NextRequest) {
  let body: { repositoryUrl?: unknown; ref?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "Send a JSON request body." },
      { status: 400 },
    );
  }
  if (typeof body.repositoryUrl !== "string") {
    return NextResponse.json(
      { error: "invalid_repository", message: "repositoryUrl must be a string." },
      { status: 400 },
    );
  }
  if (body.ref !== undefined && body.ref !== null && typeof body.ref !== "string") {
    return NextResponse.json(
      { error: "invalid_ref", message: "ref must be a string when provided." },
      { status: 400 },
    );
  }

  let responseHeaders: Record<string, string> = {};
  try {
    const input = {
      repositoryUrl: body.repositoryUrl,
      requestedRef: body.ref as string | null | undefined,
    };
    const reusable = await getReusableProjectAnalysis(input);
    if (reusable) {
      const location = `/api/project-analyses/${reusable.id}`;
      return NextResponse.json(
        {
          analysisId: reusable.id,
          repoKey: reusable.repoKey,
          status: reusable.status,
          phase: reusable.phase,
          progress: reusable.progress,
          retry: projectAnalysisRetryState(reusable),
          statusUrl: location,
          reused: true,
        },
        {
          status: 200,
          headers: {
            Location: location,
            "Idempotency-Key": reusable.idempotencyKey,
            "X-Project-Analysis-Reused": "true",
          },
        },
      );
    }

    const rateLimit = await checkProjectAnalysisRateLimit(clientIp(req));
    responseHeaders = rateLimitHeaders(rateLimit);
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many project analyses. Retry later." },
        { status: 429, headers: responseHeaders },
      );
    }

    const run = await createProjectAnalysis(input);
    const location = `/api/project-analyses/${run.id}`;
    return NextResponse.json(
      {
        analysisId: run.id,
        repoKey: run.repoKey,
        status: run.status,
        phase: run.phase,
        progress: run.progress,
        retry: projectAnalysisRetryState(run),
        statusUrl: location,
      },
      {
        status: 202,
        headers: {
          ...responseHeaders,
          Location: location,
          "Idempotency-Key": run.idempotencyKey,
        },
      },
    );
  } catch (error) {
    const response = errorResponse(error);
    for (const [key, value] of Object.entries(responseHeaders)) {
      response.headers.set(key, value);
    }
    return response;
  }
}
