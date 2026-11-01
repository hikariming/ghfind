import { NextRequest, NextResponse } from "next/server";
import { authenticateApiTokenScopes } from "@/lib/api-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Maps a personal API token to its GitHub account and scopes. The ghfind
 *  Review bot calls this to authenticate `ghfind bot` CLI requests; the bot accepts
 *  only tokens with the `bot` scope, then checks the account's repository
 *  permission on GitHub itself. Only personal tokens are
 *  accepted: the shared machine key has no account behind it. */
export async function GET(request: NextRequest) {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return json({ error: "invalid_token" }, 401);
  try {
    const identity = await authenticateApiTokenScopes(token);
    if (!identity) return json({ error: "invalid_token" }, 401);
    return json({ github_id: identity.githubId, scopes: identity.scopes });
  } catch {
    return json({ error: "token_storage_unavailable" }, 503);
  }
}
