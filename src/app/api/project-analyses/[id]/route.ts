import { NextResponse } from "next/server";
import { ProjectAnalysisDatabaseError } from "@/lib/project-analysis-db";
import {
  getPublicProjectAnalysisView,
  ProjectAnalysisServiceError,
} from "@/lib/project-analysis-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const view = await getPublicProjectAnalysisView(id, true);
    return NextResponse.json(view, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ProjectAnalysisServiceError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.status },
      );
    }
    if (error instanceof ProjectAnalysisDatabaseError) {
      return NextResponse.json(
        { error: "analysis_persistence_unavailable", message: error.message },
        { status: 503 },
      );
    }
    console.error("read project analysis failed", { analysisId: id, error });
    return NextResponse.json(
      { error: "analysis_read_failed", message: "Project analysis could not be read." },
      { status: 500 },
    );
  }
}
