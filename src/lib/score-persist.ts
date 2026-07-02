import { recordProfileSnapshot, recordScore } from "@/lib/db";
import { spamBotScore } from "@/lib/score";
import type { ScanResult } from "@/lib/types";

/**
 * Persist the deterministic score path only: GitHub scan + local scoring.
 *
 * This deliberately does not write roast text or tags. It is used when an old
 * score-version row is visited and we need to refresh factual scoring without
 * spending LLM tokens or changing the user's report copy behind the scenes.
 */
export async function recordDeterministicScan(
  scan: ScanResult,
  scannedAt = Date.now(),
): Promise<void> {
  const { metrics, scoring } = scan;
  await Promise.all([
    recordScore({
      username: metrics.username,
      display_name: metrics.name,
      avatar_url: metrics.avatar_url,
      profile_url: metrics.profile_url,
      final_score: scoring.final_score,
      tier: scoring.tier,
      tags: { zh: [], en: [] },
      roast_line: { zh: "", en: "" },
      bot_score: spamBotScore(metrics),
      sub_scores: scoring.sub_scores,
      scanned_at: scannedAt,
    }),
    recordProfileSnapshot(scan),
  ]);
}
