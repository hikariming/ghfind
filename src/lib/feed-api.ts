import { NextResponse } from "next/server";
import { auth, authConfigured } from "@/lib/auth";
import { FeedError } from "@/lib/feed";
import { FEED_BODY_LIMIT, readBoundedBody } from "@/lib/feed-gateway";

const NO_STORE = { "Cache-Control": "no-store" };

export function feedJson(body: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(body, { ...init, headers: { ...NO_STORE, ...init?.headers } });
}

export async function requireFeedViewer(): Promise<
  | { githubId: number; login: string; image: string | null }
  | NextResponse
> {
  if (!authConfigured()) return feedJson({ error: "authentication_required" }, { status: 401 });
  const session = await auth();
  if (!session?.user.githubId || !session.user.login) {
    return feedJson({ error: "authentication_required" }, { status: 401 });
  }
  return session.user;
}

export function isFeedResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse;
}

export function feedErrorResponse(error: unknown): NextResponse {
  if (error instanceof FeedError) {
    return feedJson(
      { error: error.code, message: error.message, ...(error.retryAfter ? { retry_after: error.retryAfter } : {}) },
      {
        status: error.status,
        headers: error.retryAfter ? { "Retry-After": String(error.retryAfter) } : undefined,
      },
    );
  }
  console.error("feed.request_failed", error instanceof Error ? error.message : "unknown");
  return feedJson({ error: "feed_unavailable", message: "Feed storage is temporarily unavailable." }, { status: 503, headers: { "Retry-After": "30" } });
}

export async function feedJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new FeedError("invalid_body", 400, "Expected an application/json request body.");
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > 128 * 1024) {
    throw new FeedError("invalid_body", 400, "Feed request body is too large.");
  }
  try {
    const body = await readBoundedBody(request.body, FEED_BODY_LIMIT);
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new FeedError("invalid_body", 400, "Feed request body is invalid JSON.");
  }
}

export function internalFeedAuthorized(request: Request): boolean {
  const expected = [process.env.FEED_ADMIN_SECRET, process.env.PROJECT_ANALYSIS_RECONCILE_SECRET, process.env.CRON_SECRET]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (expected.length === 0) return false;
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const explicit = request.headers.get("x-feed-admin-secret");
  return expected.some((secret) => secret === bearer || secret === explicit);
}
