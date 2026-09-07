import { NextRequest, NextResponse } from "next/server";
import { auth, authConfigured } from "@/lib/auth";
import { normalizeGitHubUsername } from "@/lib/comments";
import { getResumeLibrary, saveResumeLibrary } from "@/lib/db";
import { readResumeLibraryFull, sameResumeContent, resumeSchema, profileSchema, serializeResumeLibrary, upsertResume, RESUME_LIBRARY_MAX_BYTES } from "@/lib/resume";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: { ...NO_STORE_HEADERS, ...init?.headers },
  });
}

async function sessionUser() {
  const session = authConfigured() ? await auth() : null;
  const githubId = session?.user.githubId ?? 0;
  const login = normalizeGitHubUsername(session?.user.login ?? "");
  if (!Number.isSafeInteger(githubId) || githubId <= 0 || !login) return null;
  return { githubId, login };
}

/** Authentication, an empty library and service failure are distinct states. */
export async function GET() {
  const user = await sessionUser();
  if (!user) return jsonNoStore({ error: "sign_in_required" }, { status: 401 });
  const row = await getResumeLibrary(user.githubId);
  if (row === undefined) return jsonNoStore({ error: "resumes_unavailable" }, { status: 503 });
  return jsonNoStore(row ?? { data: null });
}

/** Save one document, preserving other documents and rejecting stale edits. */
export async function PUT(request: NextRequest) {
  const user = await sessionUser();
  if (!user) return jsonNoStore({ error: "sign_in_required" }, { status: 401 });
  let payload;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > RESUME_LIBRARY_MAX_BYTES) return jsonNoStore({ error: "library_too_large" }, { status: 413 });
    payload = JSON.parse(raw);
  } catch { return jsonNoStore({ error: "invalid_body" }, { status: 400 }); }
  const hasResume = payload?.resume !== undefined;
  const hasProfile = payload?.profile !== undefined;
  const parsed = hasResume ? resumeSchema.safeParse(payload.resume) : null;
  const parsedProfile = hasProfile ? profileSchema.safeParse(payload.profile) : null;
  if ((!hasResume && !hasProfile) || parsed?.success === false || parsedProfile?.success === false) return jsonNoStore({ error: "invalid_body" }, { status: 400 });
  if (parsed?.success && !(payload.baseUpdatedAt === null || typeof payload.baseUpdatedAt === "string")) return jsonNoStore({ error: "invalid_body" }, { status: 400 });
  // Retry only when a different document was saved concurrently. The document
  // revision is checked again on every attempt.
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getResumeLibrary(user.githubId);
    if (row === undefined) return jsonNoStore({ error: "resumes_unavailable" }, { status: 503 });
    let library;
    try { library = readResumeLibraryFull(row?.data ?? null); }
    catch { return jsonNoStore({ error: "resumes_unavailable" }, { status: 503 }); }
    const profile = parsedProfile?.success ? parsedProfile.data : library.profile;
    if (!parsed?.success) {
      // Profile-only save: reusable content data, no document revision check.
      let data;
      try { data = serializeResumeLibrary(library.resumes, profile); }
      catch { return jsonNoStore({ error: "library_full" }, { status: 413 }); }
      if (new TextEncoder().encode(data).length > RESUME_LIBRARY_MAX_BYTES) return jsonNoStore({ error: "library_too_large" }, { status: 413 });
      const result = await saveResumeLibrary(user.githubId, user.login, data, row?.data ?? null);
      if (result === "saved") return jsonNoStore({ profile });
      if (result === "unavailable") return jsonNoStore({ error: "resumes_unavailable" }, { status: 503 });
      continue;
    }
    const previous = library.resumes.find(item => item.id === parsed.data.id);
    // A response may be lost after a successful write. Retrying identical
    // content is safe and should not strand the user in a conflict loop.
    if (previous && sameResumeContent(previous, parsed.data)) return jsonNoStore({ resume: previous });
    if ((previous?.updatedAt ?? null) !== payload.baseUpdatedAt) return jsonNoStore({ error: "version_conflict" }, { status: 409 });
    const resume = { ...parsed.data, cloudBase: undefined, updatedAt: new Date(Math.max(Date.now(), (Date.parse(previous?.updatedAt ?? "") || 0) + 1)).toISOString() };
    let data;
    try { data = serializeResumeLibrary(upsertResume(library.resumes, resume), profile); }
    catch { return jsonNoStore({ error: "library_full" }, { status: 413 }); }
    if (new TextEncoder().encode(data).length > RESUME_LIBRARY_MAX_BYTES) return jsonNoStore({ error: "library_too_large" }, { status: 413 });
    const result = await saveResumeLibrary(user.githubId, user.login, data, row?.data ?? null);
    if (result === "saved") return jsonNoStore({ resume });
    if (result === "unavailable") return jsonNoStore({ error: "resumes_unavailable" }, { status: 503 });
  }
  return jsonNoStore({ error: "version_conflict" }, { status: 409 });
}
