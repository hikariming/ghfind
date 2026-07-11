import "./_env.mjs";
import {
  getProfileSnapshot,
  listSnapshotUsernames,
  recordRepoGraph,
  updateInfluenceStats,
} from "../src/lib/db";
import { extractRepoGraph } from "../src/lib/repo-graph";

/**
 * Local backfill for the /projects repo graph — the script twin of
 * POST /api/admin/backfill-repos. Derives repos + repo_developers and the
 * scores.followers/total_stars columns from every already-sedimented profile
 * snapshot (NO GitHub calls), so it's cheap and safe to re-run after tuning
 * lib/repo-graph.ts. New scans keep the graph fresh on their own; this seeds
 * the accounts scanned before the repo graph existed. Pass `--dry` to tally
 * without writing.
 */
const DRY = process.argv.includes("--dry");
const PAGE = 500;

// Resume support: `--offset 2500` skips already-backfilled pages (writes are
// idempotent upserts, so overlap is harmless — this just saves time).
const offsetArg = process.argv.indexOf("--offset");
let offset = offsetArg !== -1 ? Math.max(0, Number(process.argv[offsetArg + 1]) || 0) : 0;
let processed = 0;
let written = 0;
let empty = 0;
let failed = 0;
let repoCount = 0;
let linkCount = 0;

for (;;) {
  const usernames = await listSnapshotUsernames(PAGE, offset);
  if (usernames.length === 0) break;

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
        if (!DRY) {
          await updateInfluenceStats(
            username,
            snapshot.metrics.followers,
            snapshot.metrics.total_stars,
          );
        }
        empty++;
        continue;
      }
      if (!DRY) {
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
      console.error(`ERR ${username}:`, e instanceof Error ? e.message : String(e));
    }
    processed++;
  }

  offset += usernames.length;
  console.log(
    `progress offset=${offset} processed=${processed} written=${written} empty=${empty} failed=${failed} repos=${repoCount} links=${linkCount}`,
  );
}

console.log(
  `${DRY ? "[dry] " : ""}done processed=${processed} written=${written} empty=${empty} failed=${failed} repos=${repoCount} links=${linkCount}`,
);
