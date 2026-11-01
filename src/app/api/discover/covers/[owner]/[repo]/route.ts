import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { deleteCover, ownsRepo, readCover, writeCover } from "@/lib/discover/covers";
import { decodeRouteParam } from "@/lib/route-params";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function repoKey(owner: string, repo: string): string | null {
  const key = `${decodeRouteParam(owner)}/${decodeRouteParam(repo)}`.toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(key)) return null;
  return key;
}

export async function GET(_request: Request, context: { params: Promise<{ owner: string; repo: string }> }) {
  const { owner, repo } = await context.params;
  const key = repoKey(owner, repo);
  if (!key) return NextResponse.json({ error: "invalid_repo" }, { status: 400 });
  const cover = await readCover(key);
  if (!cover) return new NextResponse(null, { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
  return new NextResponse(Buffer.from(cover.bytes), {
    headers: {
      "Content-Type": cover.contentType,
      "Cache-Control": "public, max-age=300",
    },
  });
}

export async function POST(request: Request, context: { params: Promise<{ owner: string; repo: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { owner, repo } = await context.params;
  const key = repoKey(owner, repo);
  if (!key) return NextResponse.json({ error: "invalid_repo" }, { status: 400 });
  if (!ownsRepo(session.user.login, key)) {
    return NextResponse.json({ error: "not_repo_owner", message: "GitHub login must match the repository owner." }, { status: 403 });
  }
  const form = await request.formData();
  const file = form.get("cover");
  if (!(file instanceof File)) return NextResponse.json({ error: "missing_cover" }, { status: 400 });
  const written = await writeCover({
    repoKey: key,
    contentType: file.type,
    bytes: new Uint8Array(await file.arrayBuffer()),
    updatedBy: session.user.login,
  });
  if (!written.ok) return NextResponse.json({ error: written.error }, { status: 400 });
  return NextResponse.json({ ok: true, coverUrl: `/api/discover/covers/${owner}/${repo}` });
}

export async function DELETE(_request: Request, context: { params: Promise<{ owner: string; repo: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { owner, repo } = await context.params;
  const key = repoKey(owner, repo);
  if (!key) return NextResponse.json({ error: "invalid_repo" }, { status: 400 });
  if (!ownsRepo(session.user.login, key)) return NextResponse.json({ error: "not_repo_owner" }, { status: 403 });
  await deleteCover(key);
  return NextResponse.json({ ok: true });
}
