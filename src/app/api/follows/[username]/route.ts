import { NextRequest, NextResponse } from "next/server";
import { auth, authConfigured } from "../../../../lib/auth";
import { normalizeGitHubUsername } from "../../../../lib/comments";
import { isFollowing, removeFollow, setFollow } from "../../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...NO_STORE_HEADERS, ...init?.headers },
  });
}

async function authenticatedViewer() {
  const session = authConfigured() ? await auth() : null;
  const githubId = session?.user.githubId ?? 0;
  const login = normalizeGitHubUsername(session?.user.login ?? "");
  return Number.isSafeInteger(githubId) && githubId > 0 && login
    ? { githubId, login }
    : null;
}

/** Follow state for the profile button. Signed-out is a plain `false`, not 401 —
 * the button probes on mount and must stay quiet for anonymous visitors. */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ username: string }> },
) {
  const { username } = await ctx.params;
  const target = normalizeGitHubUsername(decodeURIComponent(username ?? ""));
  if (!target) return jsonNoStore({ error: "invalid_username" }, { status: 400 });

  const viewer = await authenticatedViewer();
  if (!viewer) return jsonNoStore({ following: false, signedIn: false });
  return jsonNoStore({
    following: await isFollowing(viewer.githubId, target),
    signedIn: true,
  });
}

export async function PUT(
  _req: NextRequest,
  ctx: { params: Promise<{ username: string }> },
) {
  const { username } = await ctx.params;
  const target = normalizeGitHubUsername(decodeURIComponent(username ?? ""));
  if (!target) return jsonNoStore({ error: "invalid_username" }, { status: 400 });

  const viewer = await authenticatedViewer();
  if (!viewer) return jsonNoStore({ error: "authentication_required" }, { status: 401 });
  if (viewer.login === target) {
    return jsonNoStore({ error: "cannot_follow_self" }, { status: 400 });
  }

  const result = await setFollow(viewer.githubId, target);
  if (result === "limit") {
    return jsonNoStore({ error: "follow_limit_reached" }, { status: 409 });
  }
  return result === "ok"
    ? jsonNoStore({ following: true })
    : jsonNoStore({ error: "follows_unavailable" }, { status: 503 });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ username: string }> },
) {
  const { username } = await ctx.params;
  const target = normalizeGitHubUsername(decodeURIComponent(username ?? ""));
  if (!target) return jsonNoStore({ error: "invalid_username" }, { status: 400 });

  const viewer = await authenticatedViewer();
  if (!viewer) return jsonNoStore({ error: "authentication_required" }, { status: 401 });

  const ok = await removeFollow(viewer.githubId, target);
  return ok
    ? jsonNoStore({ following: false })
    : jsonNoStore({ error: "follows_unavailable" }, { status: 503 });
}
