import { NextRequest, NextResponse } from "next/server";
import { getTalentById } from "@/lib/talent-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CDN_CACHE = "public, s-maxage=300, stale-while-revalidate=600";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    const talent = await getTalentById(id, req.nextUrl.searchParams.get("locale") ?? undefined);
    if (!talent) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(talent, { headers: { "Cache-Control": CDN_CACHE } });
  } catch (error) {
    console.error("talent.detail_failed", error);
    return NextResponse.json({ error: "talent_detail_failed" }, { status: 500 });
  }
}
