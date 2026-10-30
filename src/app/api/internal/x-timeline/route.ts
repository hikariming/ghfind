import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { readXTimeline, removeFromXTimeline } from "@/lib/x-timeline.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Operator-agent ingest for the curated X timeline on /feed.
 * Contract and examples: docs/operations/x-timeline.md.
 *
 *   POST   { accounts?: [...], posts: [...] }  ?dryRun=1  → what was kept and why not
 *   GET                                        → stored counts and last update
 *   DELETE ?id=<postId> | ?handle=<handle>     → moderation
 *
 * Auth: ADMIN_SECRET in `x-admin-secret` (same as /api/admin/*) or as a Bearer token.
 */

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.ADMIN_SECRET;
  const supplied = req.headers.get("x-admin-secret") ?? req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  return Boolean(secret && supplied && secureEqual(supplied.trim(), secret));
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  const timeline = await readXTimeline();
  return json({
    accounts: timeline?.accounts.length ?? 0,
    posts: timeline?.posts.length ?? 0,
    updatedAt: timeline?.updatedAt ?? null,
  });
}

/** New content-only imports use the durable social-feed endpoint. */
export async function POST(req: NextRequest) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  return json({ error: "x_importer_retired", replacement: "/api/internal/social-feed/x-posts" }, 410);
}

export async function DELETE(req: NextRequest) {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  const id = req.nextUrl.searchParams.get("id") ?? undefined;
  const handle = req.nextUrl.searchParams.get("handle") ?? undefined;
  if (!id && !handle) return json({ error: "id_or_handle_required" }, 400);
  const removed = await removeFromXTimeline({ id, handle });
  return removed == null ? json({ error: "storage_unavailable" }, 503) : json({ removed });
}
