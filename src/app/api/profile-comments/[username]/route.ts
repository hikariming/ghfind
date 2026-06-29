import { NextRequest, NextResponse } from "next/server";
import { auth, authConfigured } from "@/lib/auth";
import {
  normalizeCommentText,
  normalizeGitHubUsername,
  type CreateProfileCommentResponse,
  type ProfileCommentAuthor,
  type ProfileCommentsResponse,
} from "@/lib/comments";
import { createProfileComment, getProfileComments } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

interface CreateProfileCommentBody {
  text?: unknown;
  anonymous?: unknown;
}

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...NO_STORE_HEADERS, ...init?.headers },
  });
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ username: string }> },
) {
  const { username } = await ctx.params;
  const target = normalizeGitHubUsername(decodeURIComponent(username ?? ""));
  if (!target) {
    return jsonNoStore({ error: "invalid_username" }, { status: 400 });
  }

  const comments = await getProfileComments(target);
  return jsonNoStore({ comments } satisfies ProfileCommentsResponse);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ username: string }> },
) {
  const { username } = await ctx.params;
  const target = normalizeGitHubUsername(decodeURIComponent(username ?? ""));
  if (!target) {
    return jsonNoStore({ error: "invalid_username" }, { status: 400 });
  }

  let body: CreateProfileCommentBody;
  try {
    body = await req.json();
  } catch {
    return jsonNoStore({ error: "invalid_body" }, { status: 400 });
  }

  const text = normalizeCommentText(body.text);
  if (!text) {
    return jsonNoStore({ error: "empty_comment" }, { status: 400 });
  }

  const anonymous = body.anonymous !== false;
  const session = authConfigured() ? await auth() : null;
  const viewerUsername = normalizeGitHubUsername(session?.user.login ?? "");
  const author: ProfileCommentAuthor =
    !anonymous && viewerUsername
      ? { type: "github", username: viewerUsername, avatarUrl: session?.user.image ?? null }
      : { type: "anonymous" };

  const comment = await createProfileComment({
    targetUsername: target,
    text,
    author,
    authorGithubId: author.type === "github" ? session?.user.githubId : undefined,
  });

  if (!comment) {
    return jsonNoStore({ error: "comments_unavailable" }, { status: 503 });
  }

  return jsonNoStore({ comment } satisfies CreateProfileCommentResponse, { status: 201 });
}
