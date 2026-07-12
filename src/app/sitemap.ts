import type { MetadataRoute } from "next";
import { getAllPublicUsernames, getIndexableMatchups } from "@/lib/db";
import { getPost, getPostSlugs } from "@/lib/blog";
import { getFacetCategoriesCached } from "@/lib/developers";
import type { FacetType } from "@/lib/facets";
import { PUBLIC_INDEX_MIN_SCORE, SITE_URL, localePath } from "@/lib/site";
import { HTML_LANG, routing } from "@/i18n/routing";

// Generate at request time, not at build: the profile query is a full scan of
// the `scores` table and can exceed Next's 60s build-time prerender limit,
// which aborts the whole production build. Cache the response for an hour so
// crawlers don't hit the DB on every fetch.
export const dynamic = "force-dynamic";
export const revalidate = 3600;

// Hard ceiling on the profile query so a slow/unreachable DB can never hang the
// sitemap render — fall back to static routes only.
const PROFILE_QUERY_TIMEOUT_MS = 20_000;

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** zh lives at the root, other locales under their prefix — emit hreflang alternates for all. */
function entry(
  path: string,
  opts: { lastModified?: Date; changeFrequency?: MetadataRoute.Sitemap[number]["changeFrequency"]; priority?: number } = {},
): MetadataRoute.Sitemap[number] {
  const languages: Record<string, string> = {};
  for (const l of routing.locales) {
    languages[HTML_LANG[l]] = `${SITE_URL}${localePath(l, path)}`;
  }
  return {
    url: `${SITE_URL}${path}`,
    lastModified: opts.lastModified,
    changeFrequency: opts.changeFrequency,
    priority: opts.priority,
    alternates: { languages },
  };
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    entry("/", { changeFrequency: "daily", priority: 1 }),
    entry("/leaderboard", { changeFrequency: "hourly", priority: 0.9 }),
    entry("/developers", { changeFrequency: "daily", priority: 0.9 }),
    entry("/projects", { changeFrequency: "daily", priority: 0.9 }),
    entry("/vs", { changeFrequency: "daily", priority: 0.8 }),
    entry("/docs", { changeFrequency: "weekly", priority: 0.8 }),
    entry("/methodology", { changeFrequency: "monthly", priority: 0.7 }),
    entry("/about", { changeFrequency: "monthly", priority: 0.5 }),
    entry("/contact", { changeFrequency: "monthly", priority: 0.4 }),
    entry("/privacy", { changeFrequency: "yearly", priority: 0.3 }),
  ];

  // Blog posts: synchronous fs reads, no timeout guard needed. `entry()` emits
  // the zh+en alternate pair — correct while every post ships both locales
  // (fallback pages canonicalize onto en anyway, so a missing translation only
  // costs an extra hreflang hint, never a duplicate-content page).
  const blogRoutes: MetadataRoute.Sitemap = [
    entry("/blog", { changeFrequency: "weekly", priority: 0.7 }),
    ...getPostSlugs().map((slug) => {
      const post = getPost(slug, "en");
      return entry(`/blog/${slug}`, {
        lastModified: post ? new Date(post.updated ?? post.date) : undefined,
        changeFrequency: "monthly",
        priority: 0.8,
      });
    }),
  ];

  // Directory buckets (top languages + projects + orgs). Reads the same cached
  // categories the /developers page uses — no extra DB load — behind the same
  // timeout guard so a cold cache can never hang the sitemap.
  const facetRoutes: MetadataRoute.Sitemap = (
    await Promise.all(
      (["language", "repo", "org"] as FacetType[]).map((type) =>
        withTimeout(getFacetCategoriesCached(type), PROFILE_QUERY_TIMEOUT_MS, []).then(
          (cats) =>
            cats.map((c) =>
              // Encode each segment separately so a `repo` value ("owner/name")
              // keeps its slash as a path separator (matches the catch-all route);
              // language/org stay single-segment.
              entry(
                `/developers/${type}/${c.value
                  .split("/")
                  .map((seg) => encodeURIComponent(seg))
                  .join("/")}`,
                { changeFrequency: "weekly", priority: 0.6 },
              ),
            ),
        ),
      ),
    )
  ).flat();

  // Indexable profiles (non-hidden, score ≥ floor). Below-floor pages omitted.
  const profiles = await withTimeout(
    getAllPublicUsernames(PUBLIC_INDEX_MIN_SCORE),
    PROFILE_QUERY_TIMEOUT_MS,
    [],
  );
  const profileRoutes: MetadataRoute.Sitemap = profiles.map((p) =>
    entry(`/u/${p.username}`, {
      lastModified: p.scanned_at ? new Date(p.scanned_at) : undefined,
      changeFrequency: "weekly",
      priority: 0.7,
    }),
  );

  // Indexable PK matchups: LLM-judged and both sides above the floor. Handles are
  // already lowercased+sorted canonical, so each maps to one canonical /vs URL.
  const matchups = await withTimeout(getIndexableMatchups(), PROFILE_QUERY_TIMEOUT_MS, []);
  const matchupRoutes: MetadataRoute.Sitemap = matchups.map((m) =>
    entry(`/vs/${encodeURIComponent(m.a)}/${encodeURIComponent(m.b)}`, {
      lastModified: m.updatedAt ? new Date(m.updatedAt) : undefined,
      changeFrequency: "weekly",
      priority: 0.6,
    }),
  );

  return [...staticRoutes, ...blogRoutes, ...facetRoutes, ...profileRoutes, ...matchupRoutes];
}
