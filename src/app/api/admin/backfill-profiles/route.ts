import { NextRequest, NextResponse } from "next/server";
import { collect } from "@/lib/github";
import {
  getHeatLeaderboard,
  getLeaderboard,
  hasProfileSnapshot,
  recordProfileSnapshot,
} from "@/lib/db";
import { score } from "@/lib/score";
import type { ScanResult } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * One-off backfill: sediment raw developer-profile snapshots for the HEAD of the
 * leaderboard (top scores + top heat). Existing scored accounts have no
 * profile_snapshots row, and their raw scan has long expired from the 24h Redis
 * cache — so we re-crawl GitHub for the head and persist a full snapshot, giving
 * later domain classification real data to work from without re-crawling again.
 *
 * Guarded by ADMIN_SECRET (no default → inert until set). Runs sequentially with
 * a delay to respect the GitHub quota. Resumable: accounts that already have a
 * snapshot are skipped unless ?refresh=1. Use ?topN=&offset= to process in
 * batches if it nears the function timeout.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret || req.headers.get("x-admin-secret") !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  // How many to pull from EACH board (score + heat) before dedup.
  const topN = Math.min(500, Math.max(1, Number(url.searchParams.get("topN")) || 200));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const dryRun = url.searchParams.get("dry") === "1";
  const refresh = url.searchParams.get("refresh") === "1";
  // Pace GitHub crawls. collect() makes several REST + GraphQL calls per user, so
  // keep a healthy gap; capped so a typo can't stall the function.
  const rawDelay = Number(url.searchParams.get("delayMs"));
  const delayMs = Math.min(10000, Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : 1500);

  // Head of both boards, deduped (preserve order: score board first).
  const [byScore, byHeat] = await Promise.all([
    getLeaderboard(topN),
    getHeatLeaderboard(topN),
  ]);
  const seen = new Set<string>();
  const usernames: string[] = [];
  for (const e of [...byScore, ...byHeat]) {
    const u = e.username.toLowerCase();
    if (seen.has(u)) continue;
    seen.add(u);
    usernames.push(e.username);
  }
  const batch = usernames.slice(offset);

  let written = 0;
  let skipped = 0;
  let failed = 0;
  const errors: { username: string; error: string }[] = [];

  for (let i = 0; i < batch.length; i++) {
    const username = batch[i];
    if (!refresh && (await hasProfileSnapshot(username))) {
      skipped++;
      continue;
    }
    if (dryRun) {
      written++;
      continue;
    }
    if (i > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const collected = await collect(username);
      const scan: ScanResult = { ...collected, scoring: score(collected.metrics) };
      await recordProfileSnapshot(scan);
      written++;
    } catch (e) {
      failed++;
      errors.push({ username, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({
    dryRun,
    refresh,
    candidates: usernames.length,
    processed: batch.length,
    offset,
    written,
    skipped,
    failed,
    errors: errors.slice(0, 20),
  });
}
