/**
 * Cache-aside reads for the /developers directory, mirroring lib/leaderboard.ts.
 *
 * Both the category grid and each per-bucket developer list are served from
 * Redis first; a miss runs the DB query once, primes the cache, and — crucially —
 * is de-duped in-process (single-flight) so a burst of concurrent misses on the
 * same key collapses to one query instead of a stampede of GROUP BYs. This is the
 * layer the page and API route call; they never touch db.ts directly.
 */
import {
  getDevelopersByFacet,
  getFacetCategories,
  searchFacetCategories,
  type FacetCategory,
  type FacetSearchResult,
  type LeaderboardEntry,
} from "@/lib/db";
import type { FacetType } from "@/lib/facets";
import {
  getCachedFacetCategories,
  getCachedFacetDevelopers,
  setCachedFacetCategories,
  setCachedFacetDevelopers,
} from "@/lib/redis";

const categoriesInflight = new Map<string, Promise<FacetCategory[]>>();
const developersInflight = new Map<string, Promise<LeaderboardEntry[]>>();

/** Directory categories for a facet type, cache-aside + single-flight. */
export async function getFacetCategoriesCached(
  type: FacetType,
): Promise<FacetCategory[]> {
  const cached = await getCachedFacetCategories(type);
  if (cached) return cached;

  const existing = categoriesInflight.get(type);
  if (existing) return existing;

  const run = (async () => {
    const categories = await getFacetCategories(type);
    // Never cache an empty result: an empty array is truthy, so caching it would
    // pin the "no categories yet" state for a full TTL even after a backfill just
    // populated the table. Empty means the directory is cold; the query on an
    // empty facets table is trivial, and single-flight already covers a burst.
    if (categories.length > 0) await setCachedFacetCategories(type, categories);
    return categories;
  })();
  categoriesInflight.set(type, run);
  try {
    return await run;
  } finally {
    categoriesInflight.delete(type);
  }
}

/** The head of one directory bucket, cache-aside + single-flight. */
export async function getDevelopersByFacetCached(
  type: FacetType,
  value: string,
): Promise<LeaderboardEntry[]> {
  const cached = await getCachedFacetDevelopers(type, value);
  if (cached) return cached;

  const key = `${type}:${value}`;
  const existing = developersInflight.get(key);
  if (existing) return existing;

  const run = (async () => {
    const entries = await getDevelopersByFacet(type, value);
    // See getFacetCategoriesCached: don't cache an empty bucket, so a freshly
    // backfilled bucket appears immediately instead of after the TTL.
    if (entries.length > 0) await setCachedFacetDevelopers(type, value, entries);
    return entries;
  })();
  developersInflight.set(key, run);
  try {
    return await run;
  } finally {
    developersInflight.delete(key);
  }
}

/** Query matching facet buckets. Not Redis-cached: search terms are high-cardinality
 * and the underlying query is bounded to a small result set. */
export async function searchFacetCategoriesForDirectory(
  query: string,
  options: { type?: FacetType | null; limit?: number } = {},
): Promise<FacetSearchResult[]> {
  return searchFacetCategories(query, options);
}

/** Broad facet catalog for AI search. Bypasses Redis because the AI prompt wants
 * a larger catalog than the public browse grid, and the query only runs when a
 * visitor submits a search. */
export async function getFacetCatalogForAiSearch(
  type: FacetType,
): Promise<FacetCategory[]> {
  return getFacetCategories(type, 500);
}
