import { NextRequest, NextResponse } from "next/server";
import {
  getProfileSnapshot,
  listSnapshotUsernames,
  recordDeveloperFacets,
} from "@/lib/db";
import { extractFacets } from "@/lib/facets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * One-off (and re-runnable) backfill: derive the /developers discovery facets
 * from every already-sedimented profile snapshot. Unlike backfill-profiles this
 * makes NO GitHub calls — it reads the local `profile_snapshots` data moat and
 * writes `developer_facets` — so it's cheap and safe to re-run after tuning the
 * classification in lib/facets.ts. New scans keep facets fresh on their own via
 * recordProfileSnapshot; this seeds the accounts scanned before facets existed.
 *
 * Guarded by ADMIN_SECRET (inert until set). Paginate with ?limit=&offset= to
 * stay under the function timeout; the response echoes the next offset to use.
 * Facet caches carry a 10-min TTL, so the directory reflects the backfill within
 * that window without an explicit purge.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers.get("x-admin-secret") !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit")) || 500));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const dryRun = url.searchParams.get("dry") === "1";

  const usernames = await listSnapshotUsernames(limit, offset);

  let written = 0;
  let empty = 0;
  let failed = 0;
  const errors: { username: string; error: string }[] = [];

  for (const username of usernames) {
    try {
      const snapshot = await getProfileSnapshot(username);
      if (!snapshot) {
        empty++;
        continue;
      }
      const facets = extractFacets({
        top_repos: snapshot.top_repos,
        organizations: snapshot.organizations,
        impact_repos: snapshot.impact_repos,
      });
      if (facets.length === 0) {
        empty++;
        continue;
      }
      if (!dryRun) await recordDeveloperFacets(username, facets);
      written++;
    } catch (e) {
      failed++;
      errors.push({ username, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const processed = usernames.length;
  return NextResponse.json({
    dryRun,
    processed,
    written,
    empty,
    failed,
    offset,
    // A short page means the snapshot table is exhausted; otherwise resume here.
    nextOffset: processed === limit ? offset + limit : null,
    errors: errors.slice(0, 20),
  });
}
