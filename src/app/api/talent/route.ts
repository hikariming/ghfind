import { NextRequest, NextResponse } from "next/server";
import { getTalentOverview, listTalentsPage, type TalentSort } from "@/lib/talent-db";
import { isTalentCategory } from "@/components/talent/categories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public, filter-varying payload: share briefly at the CDN so bursts of
// identical page-0 loads (the common case) skip the function and D1 entirely.
const CDN_CACHE = "public, s-maxage=30, stale-while-revalidate=120";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const sort = sp.get("sort");
  const source = sp.get("source");
  const category = sp.get("category");
  try {
    if (sp.get("overview") === "1") {
      return NextResponse.json(await getTalentOverview(sp.get("locale") ?? undefined), { headers: { "Cache-Control": CDN_CACHE } });
    }
    const result = await listTalentsPage({
      locale: sp.get("locale") ?? undefined,
      query: sp.get("q") ?? undefined,
      direction: sp.get("direction") ?? undefined,
      category: isTalentCategory(category) ? category : undefined,
      tag: sp.get("tag")?.trim() || undefined,
      project: sp.get("project")?.trim() || undefined,
      location: sp.get("location") ?? undefined,
      source: source === "github" || source === "manual" ? source : undefined,
      available: sp.get("available") === "1",
      sort: (["recommended", "stars", "activity"] as TalentSort[]).includes(sort as TalentSort)
        ? (sort as TalentSort)
        : undefined,
      page: sp.get("page") ? Number(sp.get("page")) : 0,
      pageSize: sp.get("pageSize") ? Number(sp.get("pageSize")) : undefined,
      ids: sp.get("ids")?.split(",").filter(Boolean),
    });
    return NextResponse.json(result, { headers: { "Cache-Control": CDN_CACHE } });
  } catch (error) {
    console.error("talent.list_failed", error);
    return NextResponse.json({ error: "talent_list_failed" }, { status: 500 });
  }
}
