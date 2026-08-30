import { NextRequest, NextResponse } from "next/server";
import {
  getProfileSnapshot,
  listSnapshotUsernames,
  recordRepoGraph,
  updateInfluenceStats,
} from "@/lib/db";
import { extractRepoGraph } from "@/lib/repo-graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * One-off (and re-runnable) backfill: derive the repo graph (repos +
 * repo_developers) and the scores.followers/total_stars columns from every
 * already-sedimented profile snapshot. Like backfill-facets it makes NO GitHub
 * calls — it reads the local `profile_snapshots` data moat — so it's cheap and
 * safe to re-run after tuning the classification in lib/repo-graph.ts. New scans
 * keep the graph fresh on their own via recordProfileSnapshot; this seeds the
 * accounts scanned before the repo graph existed.
 *
 * Guarded by ADMIN_SECRET (inert until set). Paginate with ?limit=&offset= to
 * stay under the function timeout; the response echoes the next offset to use.
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
  let repoCount = 0;
  let linkCount = 0;
  const errors: { username: string; error: string }[] = [];

  for (const username of usernames) {
    try {
      const snapshot = await getProfileSnapshot(username);
      if (!snapshot) {
        empty++;
        continue;
      }
      const graph = extractRepoGraph({
        top_repos: snapshot.top_repos,
        impact_repos: snapshot.impact_repos,
      });
      if (graph.repos.length === 0) {
        // Still lift influence stats even when the account contributes no repos.
        if (!dryRun) {
          await updateInfluenceStats(
            username,
            snapshot.metrics.followers,
            snapshot.metrics.total_stars,
          );
        }
        empty++;
        continue;
      }
      if (!dryRun) {
        await recordRepoGraph(username, graph);
        await updateInfluenceStats(
          username,
          snapshot.metrics.followers,
          snapshot.metrics.total_stars,
        );
      }
      repoCount += graph.repos.length;
      linkCount += graph.links.length;
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
    repoCount,
    linkCount,
    offset,
    // A short page means the snapshot table is exhausted; otherwise resume here.
    nextOffset: processed === limit ? offset + limit : null,
    errors: errors.slice(0, 20),
  });
}
