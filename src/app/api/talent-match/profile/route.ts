import { NextRequest } from "next/server";
import { z } from "zod";
import { coreDb, jsonNoStore, sessionUser, signInRequired, unavailable } from "@/lib/talent-match/http";
import { deleteTalentData, getProfile, setOptIn } from "@/lib/talent-match/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether the account has a Talent Match profile, and whether it is open to opportunities. */
export async function GET() {
  const user = await sessionUser();
  if (!user) return signInRequired();
  const db = coreDb();
  if (!db) return unavailable();
  const stored = await getProfile(db, user.githubId);
  return jsonNoStore({ profile: stored ? { optedIn: stored.optedIn } : null });
}

const optInSchema = z.object({ optedIn: z.boolean() });

/**
 * Open to opportunities: consent for the account's current profile to join
 * the talent pool companies match against (phase 3). Companies would see the
 * extracted profile and match score, never résumé text. A profile exists only
 * after a report has run, so there is nothing to opt in before that.
 */
export async function PUT(request: NextRequest) {
  const user = await sessionUser();
  if (!user) return signInRequired();
  let body;
  try {
    body = optInSchema.parse(await request.json());
  } catch {
    return jsonNoStore({ error: "invalid_body" }, { status: 400 });
  }
  const db = coreDb();
  if (!db) return unavailable();
  if (!(await setOptIn(db, user.githubId, body.optedIn, Date.now()))) {
    return jsonNoStore({ error: "profile_missing" }, { status: 409 });
  }
  return jsonNoStore({ optedIn: body.optedIn });
}

/**
 * Delete the account's Talent Match profile and every report, which also
 * withdraws it from the talent pool. No talent vectors are stored yet; once
 * opted-in profiles are indexed their ids come back from deleteTalentData
 * and must be deleted there too.
 */
export async function DELETE() {
  const user = await sessionUser();
  if (!user) return signInRequired();
  const db = coreDb();
  if (!db) return unavailable();
  const vectorIds = await deleteTalentData(db, user.githubId);
  if (vectorIds.length) console.error("talent_vectors_not_deleted", { count: vectorIds.length });
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
