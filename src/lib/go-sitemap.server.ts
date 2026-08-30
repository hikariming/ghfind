import "server-only";

import { getAllPublicUsernames, getIndexableMatchups } from "@/lib/db";

export interface GoSitemapProfile {
  username: string;
  scanned_at: number;
}

export interface GoSitemapMatchup {
  a: string;
  b: string;
  updatedAt: number;
}

/**
 * The bounded, indexable public URL inventory for app/sitemap.ts — the same
 * assembly the Go /api/sitemap endpoint produced: non-hidden profiles at/above
 * the public floor, plus LLM-judged matchups where both sides clear the vs
 * floor. Both reads degrade to [] on a DB failure, matching how the consumer
 * treats a null inventory (static routes only).
 */
export async function getGoSitemapInventory(): Promise<{
  profiles: GoSitemapProfile[];
  matchups: GoSitemapMatchup[];
} | null> {
  const [profiles, matchups] = await Promise.all([
    getAllPublicUsernames(),
    getIndexableMatchups(),
  ]);
  // The Go endpoint served profiles username-ascending; keep that ordering
  // here (getAllPublicUsernames itself ranks by score).
  profiles.sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
  return { profiles, matchups };
}
