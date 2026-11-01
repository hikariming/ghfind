import {
  getProfileCommonProjects,
  getProjects,
  getRelatedProjects,
  getRepoLanguage,
  type ProjectListItem,
  type RelatedProject,
} from "@/lib/db";
import { isBotRequest } from "@/lib/bot-user-agent";
import { createLocalCache } from "@/lib/edge-cache";
import type { ProjectSort } from "@/lib/projects";
import { getCachedProjectValue, setCachedProjectValue } from "@/lib/redis";

type CacheLoaderDeps<T, Args extends unknown[] = []> = {
  cacheGet: (key: string) => Promise<T | null>;
  cacheSet: (key: string, value: T) => Promise<void>;
  dbLoad: (key: string, ...args: Args) => Promise<T>;
  /** Returned — and NOT cached — when dbLoad throws. A transient Turso/network
   * failure must degrade this one render, not blank the surface for a full
   * TTL (the homepage projects band vanished for 6h per hiccup). */
  fallback: T;
  /** Whether a loaded value earns a shared KV entry (default: every value).
   * Rejected values stay in the in-isolate map instead (see below). */
  persist?: (value: T) => boolean;
  /** Keep crawler renders out of KV (lib/bot-user-agent): a long-tail crawler
   * fetches each page about once per TTL, so its KV write is never read back. */
  skipBotWrites?: boolean;
  /** TTL of the in-isolate map that holds values kept out of KV. Without it
   * they are not cached. The Workers Cache API is intentionally unused:
   * `cache.match` miss/expiry is logged as a zone 504. */
  localTtlSeconds?: number;
  isBot?: () => boolean;
};

const LOCAL_CACHE_ENTRIES = 2000;

export function createCachedLoader<T, Args extends unknown[] = []>(deps: CacheLoaderDeps<T, Args>) {
  const inflight = new Map<string, Promise<T>>();
  const ttl = deps.localTtlSeconds;
  const local = ttl ? createLocalCache<T>(ttl * 1000, LOCAL_CACHE_ENTRIES) : null;
  const isBot = deps.isBot ?? isBotRequest;
  return async (key: string, ...args: Args): Promise<T> => {
    const memo = local?.get(key);
    if (memo !== undefined) return memo;
    try {
      const cached = await deps.cacheGet(key);
      if (cached !== null) return cached;
    } catch {
      // Redis is best-effort; the database remains the source of truth.
    }

    const existing = inflight.get(key);
    if (existing) return existing;

    const run = (async () => {
      let value: T;
      try {
        value = await deps.dbLoad(key, ...args);
      } catch (e) {
        console.error("project discovery dbLoad failed:", key, e);
        return deps.fallback;
      }
      // Successes are always cached somewhere, empty ones included: skipping
      // them sent every crawler hit straight to the database (the 2026-07
      // rows_read incident). Errors return the fallback above uncached.
      const shared = (deps.persist?.(value) ?? true) && !(deps.skipBotWrites && isBot());
      try {
        if (shared) await deps.cacheSet(key, value);
        else if (local) local.set(key, value);
      } catch {
        // Cache writes must never break a discovery page.
      }
      return value;
    })();
    inflight.set(key, run);
    try {
      return await run;
    } finally {
      inflight.delete(key);
    }
  };
}

export interface ProjectListCacheOptions {
  sort: ProjectSort;
  language: string | null;
  limit: number;
  offset: number;
}

export function projectListCacheKey(options: ProjectListCacheOptions): string {
  const language = options.language?.trim().toLowerCase() || "all";
  return `projects:list:${options.sort}:${language}:${options.limit}:${options.offset}`;
}

export function relatedProjectsCacheKey(repoKey: string, limit: number): string {
  return `projects:related:${repoKey.trim().toLowerCase()}:${limit}`;
}

// The project lists keep writing KV for every answer, crawler renders and
// empty pages included: the key space is small (sort x language x page) and a
// cold miss on an unfiltered list is a whole-graph aggregation, far costlier
// in D1 than the write.
const listOptions = new Map<string, ProjectListCacheOptions>();
const projectListLoader = createCachedLoader<ProjectListItem[]>({
  cacheGet: getCachedProjectValue,
  cacheSet: setCachedProjectValue,
  dbLoad: async (key) => {
    const options = listOptions.get(key);
    return options ? getProjects(options) : [];
  },
  fallback: [],
});

export async function getProjectsCached(options: ProjectListCacheOptions) {
  const key = projectListCacheKey(options);
  listOptions.set(key, options);
  try {
    return await projectListLoader(key);
  } finally {
    listOptions.delete(key);
  }
}

// Related projects of one repo page (~17.5k KV writes/day at a 6h TTL, 4.4k
// live keys). Repo pages are a crawler long tail, so:
// - only answers with real shared-contributor neighbors, rendered for a human,
//   earn a KV entry, for 24h (the graph only moves on scans/backfills);
// - empty or filler-only answers (no shared contributors — the cheap case: the
//   neighbor query reads only this repo's few contributors, and the filler is
//   the per-language list already cached in KV) and crawler renders stay in
//   the in-isolate map, so repeats in the same isolate still skip the database.
const RELATED_TTL_SECONDS = 86400; // 24h

const relatedOptions = new Map<string, { repoKey: string; limit: number }>();
const relatedLoader = createCachedLoader<RelatedProject[]>({
  cacheGet: getCachedProjectValue,
  cacheSet: (key, value) => setCachedProjectValue(key, value, RELATED_TTL_SECONDS),
  persist: (related) => related.some((item) => item.sharedContributorCount > 0),
  skipBotWrites: true,
  localTtlSeconds: RELATED_TTL_SECONDS,
  fallback: [],
  dbLoad: async (key) => {
    const options = relatedOptions.get(key);
    if (!options) return [];
    const shared = await getRelatedProjects(options.repoKey, options.limit);
    if (shared.length >= options.limit) return shared;
    // Same-language filler for repos with few shared-contributor neighbors.
    // Goes through the per-language list cache, so the whole-graph aggregation
    // runs once per language per TTL — not once per repo page as before.
    const language = await getRepoLanguage(options.repoKey);
    if (!language) return shared;
    const fallback = await getProjectsCached({
      sort: "quality",
      language,
      limit: Math.max(options.limit * 2, 12),
      offset: 0,
    });
    const seen = new Set([
      options.repoKey.trim().toLowerCase(),
      ...shared.map((item) => item.project.repo.repo_key),
    ]);
    return [
      ...shared,
      ...fallback
        .filter((project) => !seen.has(project.repo.repo_key))
        .map((project) => ({ project, sharedContributorCount: 0 })),
    ].slice(0, options.limit);
  },
});

export async function getRelatedProjectsCached(repoKey: string, limit = 6) {
  const key = relatedProjectsCacheKey(repoKey, limit);
  relatedOptions.set(key, { repoKey, limit });
  try {
    return await relatedLoader(key);
  } finally {
    relatedOptions.delete(key);
  }
}

// Common projects for a whole profile — every similar candidate in one entry
// (and one database round trip, see db.getProfileCommonProjects). The per-pair
// entries this replaces were ~49k KV writes/day: up to three per crawler view
// of a profile, almost never read back.
//
// D1 stays bounded without KV for the common answer. "Nothing in common" — the
// overwhelmingly common result — costs only username/primary-key index seeks
// (the project query never runs), and it is still cached in-isolate, so repeat
// renders in the same isolate don't reach the database. Only non-empty answers
// rendered for humans earn a KV entry.
const PROFILE_COMMON_TTL_SECONDS = 21600; // 6h, the PROJECT_DISCOVERY TTL

function profileCommonProjectsCacheKey(username: string, candidates: string[], limit: number): string {
  const others = candidates.map((candidate) => candidate.trim().toLowerCase()).join(",");
  return `projects:common:v2:${username.trim().toLowerCase()}:${limit}:${others}`;
}

const profileCommonLoader = createCachedLoader<ProjectListItem[][], [string, string[], number]>({
  cacheGet: getCachedProjectValue,
  cacheSet: setCachedProjectValue,
  dbLoad: (_key, username, candidates, limit) => getProfileCommonProjects(username, candidates, limit),
  fallback: [],
  persist: (lists) => lists.some((items) => items.length > 0),
  skipBotWrites: true,
  localTtlSeconds: PROFILE_COMMON_TTL_SECONDS,
});

/** Per candidate (in order), the projects it shares with `username`. */
export async function getProfileCommonProjectsCached(
  username: string,
  candidates: string[],
  limit = 6,
): Promise<ProjectListItem[][]> {
  if (candidates.length === 0) return [];
  const key = profileCommonProjectsCacheKey(username, candidates, limit);
  const lists = await profileCommonLoader(key, username, candidates, limit);
  // The fallback (database error) is [] — still one (empty) list per candidate.
  return candidates.map((_, index) => lists[index] ?? []);
}
