import { NextRequest, NextResponse } from "next/server";
import { auth, authConfigured } from "../../../../lib/auth";
import { normalizeGitHubUsername } from "../../../../lib/comments";
import {
  getProfileReactionState,
  removeProfileReaction,
  setProfileReaction,
} from "../../../../lib/db";
import { isProfileReaction } from "../../../../lib/reactions";

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

/**
 * Reaction counts plus the viewer's own pick. Public (viewer optional) —
 * added Go-side during the extraction (interactions.go) and repatriated here.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ username: string }> },
) {
  const target = normalizeGitHubUsername((await params).username);
  if (!target) return jsonNoStore({ error: "invalid_username" }, { status: 400 });
  const viewer = await authenticatedViewer();
  const state = await getProfileReactionState(target, viewer?.githubId);
  return jsonNoStore(state);
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ username: string }> },
) {
  const { username } = await ctx.params;
  const target = normalizeGitHubUsername(decodeURIComponent(username ?? ""));
  if (!target) return jsonNoStore({ error: "invalid_username" }, { status: 400 });

  const viewer = await authenticatedViewer();
  if (!viewer) return jsonNoStore({ error: "authentication_required" }, { status: 401 });

  let body: { reaction?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonNoStore({ error: "invalid_body" }, { status: 400 });
  }
  if (!isProfileReaction(body.reaction)) {
    return jsonNoStore({ error: "invalid_reaction" }, { status: 400 });
  }

  const state = await setProfileReaction({
    targetUsername: target,
    voterGithubId: viewer.githubId,
    voterLogin: viewer.login,
    reaction: body.reaction,
  });
  return state
    ? jsonNoStore(state)
    : jsonNoStore({ error: "reactions_unavailable" }, { status: 503 });
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

  const state = await removeProfileReaction({
    targetUsername: target,
    voterGithubId: viewer.githubId,
  });
  return state
    ? jsonNoStore(state)
    : jsonNoStore({ error: "reactions_unavailable" }, { status: 503 });
}
