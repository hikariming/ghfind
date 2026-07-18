import {
  getDeveloperCommonProjects,
  getProjects,
  getRelatedProjects,
  getRepoLanguage,
  type ProjectListItem,
  type RelatedProject,
} from "@/lib/db";
import type { ProjectSort } from "@/lib/projects";
import { getCachedProjectValue, setCachedProjectValue } from "@/lib/redis";

type CacheLoaderDeps<T> = {
  cacheGet: (key: string) => Promise<T | null>;
  cacheSet: (key: string, value: T) => Promise<void>;
  dbLoad: (key: string) => Promise<T>;
};

export function createCachedLoader<T>(deps: CacheLoaderDeps<T>) {
  const inflight = new Map<string, Promise<T>>();
  return async (key: string): Promise<T> => {
    try {
      const cached = await deps.cacheGet(key);
      if (cached !== null) return cached;
    } catch {
      // Redis is best-effort; the database remains the source of truth.
    }

    const existing = inflight.get(key);
    if (existing) return existing;

    const run = (async () => {
      const value = await deps.dbLoad(key);
      // Empty results are cached too: "no common projects" is the overwhelmingly
      // common answer on profile pages, and skipping it meant every crawler hit
      // went straight to the database (the 2026-07 rows_read incident).
      try {
        await deps.cacheSet(key, value);
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

const listOptions = new Map<string, ProjectListCacheOptions>();
const projectListLoader = createCachedLoader<ProjectListItem[]>({
  cacheGet: getCachedProjectValue,
  cacheSet: setCachedProjectValue,
  dbLoad: async (key) => {
    const options = listOptions.get(key);
    return options ? getProjects(options) : [];
  },
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

const relatedOptions = new Map<string, { repoKey: string; limit: number }>();
const relatedLoader = createCachedLoader<RelatedProject[]>({
  cacheGet: getCachedProjectValue,
  cacheSet: setCachedProjectValue,
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

export async function getDeveloperCommonProjectsCached(
  usernameA: string,
  usernameB: string,
  limit = 6,
) {
  const [a, b] = [usernameA.toLowerCase(), usernameB.toLowerCase()].sort();
  const key = `projects:common:${a}:${b}:${limit}`;
  const load = createCachedLoader<ProjectListItem[]>({
    cacheGet: getCachedProjectValue,
    cacheSet: setCachedProjectValue,
    dbLoad: () => getDeveloperCommonProjects(a, b, limit),
  });
  return load(key);
}
