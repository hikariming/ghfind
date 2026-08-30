import { NextResponse } from "next/server";
import { auth, authConfigured } from "../../../lib/auth";
import { normalizeGitHubUsername } from "../../../lib/comments";
import { listFollowedAccounts } from "../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...NO_STORE_HEADERS, ...init?.headers },
  });
}

/**
 * The signed-in user's follow feed — each watched handle with current score,
 * tier and the "this week" delta. Powers the homepage following module.
 * Signed-out gets `{ accounts: null }` with 200 (mirrors /api/me's always-200
 * contract so the client island can probe without error handling).
 */
export async function GET() {
  const session = authConfigured() ? await auth() : null;
  const githubId = session?.user.githubId ?? 0;
  const login = normalizeGitHubUsername(session?.user.login ?? "");
  if (!Number.isSafeInteger(githubId) || githubId <= 0 || !login) {
    return jsonNoStore({ accounts: null });
  }
  const accounts = await listFollowedAccounts(githubId);
  return accounts
    ? jsonNoStore({ accounts })
    : jsonNoStore({ error: "follows_unavailable" }, { status: 503 });
}
