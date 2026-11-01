import { coreDb, jsonNoStore, sessionUser, signInRequired, unavailable } from "@/lib/talent-match/http";
import { quotaFor } from "@/lib/talent-match/quota";
import { quotaCounts } from "@/lib/talent-match/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** This month's report quota, plus whether a report is in flight. */
export async function GET() {
  const user = await sessionUser();
  if (!user) return signInRequired();
  const db = coreDb();
  if (!db) return unavailable();
  const now = Date.now();
  const { doneThisMonth, inFlight } = await quotaCounts(db, user.githubId, now);
  return jsonNoStore({ ...quotaFor(doneThisMonth, now), inFlight: inFlight > 0 });
}
