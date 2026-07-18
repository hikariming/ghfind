/**
 * Rank / percentile served from a cached score histogram.
 *
 * db.getRank / db.getPercentile aggregate the whole `scores` table per call,
 * and they sit on every profile render, /api/score hit, share card and MCP
 * call — the same "O(table) × crawler traffic" shape as the 2026-07 discovery
 * incident. Here one histogram aggregate per TTL (Redis 5 min, plus a 60s
 * in-process copy) answers every lookup from memory.
 *
 * Granularity is 0.1 score points (buckets are score × 10). Scores are
 * displayed with one decimal, so bucket ties are exactly the display ties;
 * finer-grained stored differences within a bucket count as ties, which can
 * shift a rank by at most the bucket's population — invisible at display
 * precision.
 */

import { getScoreHistogram, type ScoreHistogramRow } from "@/lib/db";
import { getCachedScoreHistogram, setCachedScoreHistogram } from "@/lib/redis";

/** In-process staleness bound; Redis (5 min) is the cross-instance cache. */
const LOCAL_TTL_MS = 60_000;

let local: { rows: ScoreHistogramRow[]; at: number } | null = null;
let inflight: Promise<ScoreHistogramRow[] | null> | null = null;

async function loadHistogram(): Promise<ScoreHistogramRow[] | null> {
  if (local && Date.now() - local.at < LOCAL_TTL_MS) return local.rows;
  if (!inflight) {
    inflight = (async () => {
      try {
        const cached = await getCachedScoreHistogram();
        if (cached && cached.length > 0) {
          local = { rows: cached, at: Date.now() };
          return cached;
        }
        const rows = await getScoreHistogram();
        // [] means the DB is unconfigured/erroring or genuinely empty — don't
        // pin that for a TTL; rank degrades to null exactly like db.getRank.
        if (rows.length === 0) return null;
        local = { rows, at: Date.now() };
        await setCachedScoreHistogram(rows);
        return rows;
      } catch {
        return null;
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}

const toBucket = (score: number) => Math.round(score * 10);

/** Histogram-backed drop-in for {@link import("./db").getRank}: rank among
 *  visible accounts, ties share, null when there's no one to compare against. */
export async function getRankCached(
  score: number,
): Promise<{ rank: number; total: number; below: number } | null> {
  const rows = await loadHistogram();
  if (!rows) return null;
  const b = toBucket(score);
  let above = 0;
  let below = 0;
  let total = 0;
  for (const r of rows) {
    if (r.hidden !== 0) continue;
    total += r.n;
    if (r.bucket > b) above += r.n;
    else if (r.bucket < b) below += r.n;
  }
  if (total <= 1) return null;
  return { rank: above + 1, total, below };
}

/** Histogram-backed drop-in for {@link import("./db").getPercentile}: counts
 *  every account (hidden included), matching the original's semantics. */
export async function getPercentileCached(
  score: number,
): Promise<{ below: number; total: number } | null> {
  const rows = await loadHistogram();
  if (!rows) return null;
  const b = toBucket(score);
  let below = 0;
  let total = 0;
  for (const r of rows) {
    total += r.n;
    if (r.bucket < b) below += r.n;
  }
  return total > 0 ? { below, total } : null;
}
