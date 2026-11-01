import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  ApiTokenScopesUnavailableError,
  createApiToken,
  listApiTokens,
  MAX_ACTIVE_API_TOKENS,
  OPTIONAL_API_TOKEN_SCOPES,
  type ApiTokenScope,
} from "@/lib/api-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** `scopes` is optional; when present it must be an array of distinct opt-in
 *  scopes (currently only "bot"). `scan` is implicit and not accepted here. */
function parseScopes(value: unknown): ApiTokenScope[] | null {
  if (value === undefined) return ["scan"];
  if (!Array.isArray(value) || value.length > OPTIONAL_API_TOKEN_SCOPES.length) return null;
  const scopes = new Set<ApiTokenScope>();
  for (const item of value) {
    if (typeof item !== "string" || !OPTIONAL_API_TOKEN_SCOPES.includes(item as ApiTokenScope) || scopes.has(item as ApiTokenScope)) return null;
    scopes.add(item as ApiTokenScope);
  }
  return ["scan", ...scopes];
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
  let body: { name?: unknown; scopes?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid_body" }, 400);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    return json({ error: "invalid_name" }, 400);
  }
  const scopes = parseScopes(body.scopes);
  if (!scopes) return json({ error: "invalid_scopes" }, 400);
  try {
    const created = await createApiToken(session.user.githubId, name, scopes);
    if (!created) return json({ error: "token_limit", limit: MAX_ACTIVE_API_TOKENS }, 409);
    return json(created, 201);
  } catch (error) {
    if (error instanceof ApiTokenScopesUnavailableError) return json({ error: "token_scopes_unavailable" }, 503);
    return json({ error: "token_storage_unavailable" }, 503);
  }
}
