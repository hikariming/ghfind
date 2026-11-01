import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { revokeApiToken } from "@/lib/api-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) return json({ error: "same_origin_required" }, 403);
  const session = await auth();
  if (!session) return json({ error: "sign_in_required" }, 401);
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "not_found" }, 404);
  try {
    await revokeApiToken(session.user.githubId, id);
    return json({ revoked: true });
  } catch {
    return json({ error: "token_storage_unavailable" }, 503);
  }
}
