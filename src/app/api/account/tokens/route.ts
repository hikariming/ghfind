import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createApiToken, listApiTokens, MAX_ACTIVE_API_TOKENS } from "@/lib/api-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  return Boolean(origin && origin === request.nextUrl.origin);
}

export async function GET() {
  const session = await auth();
  if (!session) return json({ error: "sign_in_required" }, 401);
  try {
    return json({ tokens: await listApiTokens(session.user.githubId) });
  } catch {
    return json({ error: "token_storage_unavailable" }, 503);
  }
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return json({ error: "same_origin_required" }, 403);
  const session = await auth();
  if (!session) return json({ error: "sign_in_required" }, 401);
  let body: { name?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    return json({ error: "invalid_name" }, 400);
  }
  try {
    const created = await createApiToken(session.user.githubId, name);
    if (!created) return json({ error: "token_limit", limit: MAX_ACTIVE_API_TOKENS }, 409);
    return json(created, 201);
  } catch {
    return json({ error: "token_storage_unavailable" }, 503);
  }
}
