import { NextResponse } from "next/server";
import { cardFromAssessment } from "@/lib/discover/map";
import { countProjectBoard, listProjectBoard, type ProjectBoard } from "@/lib/project-analysis-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseBoard(value: string | null): ProjectBoard {
  if (value === "classic" || value === "all") return value;
  return "treasure";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(50, Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  const locale = url.searchParams.get("locale") ?? "zh";
  const board = parseBoard(url.searchParams.get("board"));
  try {
    const [entries, total] = await Promise.all([
      listProjectBoard(board, { limit, offset }),
      countProjectBoard(board),
    ]);
    const items = entries.map((entry) => cardFromAssessment(entry, locale));
    const nextOffset = offset + items.length < total ? offset + items.length : null;
    return NextResponse.json(
      { items, nextOffset, source: "public", degraded: [], requestId: null },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600" } },
    );
  } catch (error) {
    console.error("discover.public_failed", error);
    return NextResponse.json(
      { error: "discover_unavailable", message: "Public discover is temporarily unavailable.", items: [], nextOffset: null },
      { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30" } },
    );
  }
}
