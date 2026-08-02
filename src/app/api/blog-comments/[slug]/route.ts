import { NextRequest, NextResponse } from "next/server";
import { auth, authConfigured } from "@/lib/auth";
import {
  normalizeBlogSlug,
  normalizeCommentText,
  normalizeGitHubUsername,
  type BlogCommentsResponse,
  type CommentAuthor,
  type CreateBlogCommentResponse,
} from "@/lib/comments";
import { getPost } from "@/lib/blog";
import { createBlogComment, getBlogComments } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

interface CreateBlogCommentBody {
  text?: unknown;
  anonymous?: unknown;
}

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...NO_STORE_HEADERS, ...init?.headers },
  });
}

function postSlugFromParam(value: string | undefined): string | null {
  try {
    const slug = normalizeBlogSlug(decodeURIComponent(value ?? ""));
    return slug && getPost(slug, "en") ? slug : null;
  } catch {
    return null;
  }
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug: rawSlug } = await ctx.params;
  const postSlug = postSlugFromParam(rawSlug);
  if (!postSlug) return jsonNoStore({ error: "invalid_post" }, { status: 404 });

  const comments = await getBlogComments(postSlug);
  return jsonNoStore({ comments } satisfies BlogCommentsResponse);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug: rawSlug } = await ctx.params;
  const postSlug = postSlugFromParam(rawSlug);
  if (!postSlug) return jsonNoStore({ error: "invalid_post" }, { status: 404 });

  let body: CreateBlogCommentBody;
  try {
    body = await req.json();
  } catch {
    return jsonNoStore({ error: "invalid_body" }, { status: 400 });
  }

  const text = normalizeCommentText(body.text);
  if (!text) return jsonNoStore({ error: "empty_comment" }, { status: 400 });

  const anonymous = body.anonymous === true;
  let author: CommentAuthor;
  let authorGithubId: number | undefined;
  if (anonymous) {
    author = { type: "anonymous" };
  } else {
    const session = authConfigured() ? await auth() : null;
    const viewerUsername = normalizeGitHubUsername(session?.user.login ?? "");
    if (!viewerUsername) {
      return jsonNoStore({ error: "authentication_required" }, { status: 401 });
    }

    author = { type: "github", username: viewerUsername, avatarUrl: session?.user.image ?? null };
    authorGithubId = session?.user.githubId;
  }

  const comment = await createBlogComment({
    postSlug,
    text,
    author,
    authorGithubId,
  });
  if (!comment) return jsonNoStore({ error: "comments_unavailable" }, { status: 503 });

  return jsonNoStore({ comment } satisfies CreateBlogCommentResponse, { status: 201 });
}
