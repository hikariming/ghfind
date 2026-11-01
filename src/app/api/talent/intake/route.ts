import { NextRequest, NextResponse } from "next/server";
import type { Talent } from "@/components/talent/data";
import { persistTalentIntake } from "@/lib/talent-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Talent self-submission (the /talent "add" form). Formerly a Next Server
 * Action; a plain route works the same from the Next page and the Astro
 * island. Same-origin only, like the CSRF check Next applies to actions.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) {
    return NextResponse.json({ ok: false, message: "same_origin_required" }, { status: 403, headers: NO_STORE });
  }
  let talent: Talent;
  try {
    talent = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "提交失败，请稍后重试。" }, { status: 400, headers: NO_STORE });
  }
  return NextResponse.json(await persistTalentIntake(talent), { headers: NO_STORE });
}
