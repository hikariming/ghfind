import { HTML_LANG, routing } from "@/i18n/routing";
import { readingMinutes } from "@/lib/blog";
import { contentFileExists, listContentDir, readContentFile } from "@/lib/content-files";
import type { Tier } from "@/lib/types";

/**
 * Loader for the curated picks section ("编辑推荐"), reading the embedded
 * content map (`@/lib/content-files` — no runtime filesystem). Each entry is a
 * directory `content/collections/<slug>/` holding:
 *
 * - `meta.json` — type, bilingual title/intro, tags, optional feature
 *   `subject` (the person/repo the piece is about) and optional `items`
 *   (card-list picks for roundup-style collections).
 * - `<locale>.md` — optional long-form article body. Editorial content ships
 *   zh + en plus ja/ko translations; a locale without its own body falls back
 *   locale → en → zh.
 *
 * Item `stats` are static editorial numbers for now; the real-data phase
 * resolves live stats from `repos`/`scores` at render time and keeps `stats`
 * as the fallback for entities the engine hasn't scanned yet.
 */

export type LocalizedText = { zh: string; en: string; ja?: string; ko?: string };

export type RepoPickStats = {
  stars: number;
  language?: string;
  description?: string;
  /** Average engine score of the scored contributors. */
  avgScore?: number;
  contributors?: { username: string; tier: Tier }[];
};

export type DeveloperPickStats = {
  name?: string;
  tier: Tier;
  score: number;
  followers?: number;
  totalStars?: number;
  languages?: string[];
};

export type CollectionItem =
  | { kind: "repo"; id: string; blurb: LocalizedText; stats: RepoPickStats }
  | { kind: "developer"; id: string; blurb: LocalizedText; stats: DeveloperPickStats };

export type CollectionSubject = {
  kind: "developer" | "repo";
  /** GitHub username or "owner/name". */
  id: string;
  /** PR-editable display-name override, e.g. "张昱轩 (Yuxuan Zhang)". */
  nickname?: string;
  headline?: LocalizedText;
};

export type CollectionType = "projects" | "developers" | "mixed";

export type Collection = {
  slug: string;
  type: CollectionType;
  title: LocalizedText;
  intro: LocalizedText;
  /** ISO date. */
  publishedAt: string;
  tags: string[];
  subject?: CollectionSubject;
  items: CollectionItem[];
  /** Locales that have a long-form article body (`<locale>.md` present). */
  bodyLocales: string[];
};

export type CollectionArticle = {
  body: string;
  /** The locale actually served (may differ from the requested one). */
  bodyLocale: string;
  readingMinutes: number;
};

export function getCollectionSlugs(): string[] {
  return listContentDir("collections").filter((slug) =>
    contentFileExists(`collections/${slug}/meta.json`),
  );
}

export function getCollection(slug: string): Collection | null {
  // Slugs come from route params — refuse anything that isn't a plain slug.
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const rawMeta = readContentFile(`collections/${slug}/meta.json`);
  if (rawMeta === null) return null;
  const meta = JSON.parse(rawMeta) as Omit<
    Collection,
    "slug" | "items" | "bodyLocales"
  > & { items?: CollectionItem[] };
  const bodyLocales = listContentDir(`collections/${slug}`)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));
  return { ...meta, slug, items: meta.items ?? [], bodyLocales };
}

/** Long-form body with content-locale fallback: requested → en → zh. */
export function getCollectionArticle(
  slug: string,
  locale: string,
): CollectionArticle | null {
  const collection = getCollection(slug);
  if (!collection || collection.bodyLocales.length === 0) return null;
  const bodyLocale = [locale, "en", "zh"].find((l) =>
    collection.bodyLocales.includes(l),
  );
  if (!bodyLocale) return null;
  const body = readContentFile(`collections/${slug}/${bodyLocale}.md`);
  if (body === null) return null;
  return { body, bodyLocale, readingMinutes: readingMinutes(body) };
}

export function listCollections(): Collection[] {
  return getCollectionSlugs()
    .map((slug) => getCollection(slug))
    .filter((c): c is Collection => c !== null)
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
}

/** Editorial copy ships zh + en (+ ja/ko where translated); fall back locale → en → zh. */
export function pickText(text: LocalizedText, locale: string): string {
  return (
    (text as Record<string, string | undefined>)[locale] || text.en || text.zh
  );
}

/**
 * Public GitHub profile name used only when editorial metadata has no nickname.
 * The result is revalidated daily, while a PR-supplied `subject.nickname` stays
 * authoritative and avoids this request entirely.
 */
export async function getGitHubNickname(username: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.github.com/users/${encodeURIComponent(username)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "ghfind",
        },
        next: { revalidate: 86_400 },
      },
    );
    if (!response.ok) return null;
    const profile = (await response.json()) as { name?: unknown };
    return typeof profile.name === "string" && profile.name.trim()
      ? profile.name.trim()
      : null;
  } catch {
    return null;
  }
}

function collectionPath(locale: string, slug: string): string {
  return locale === routing.defaultLocale
    ? `/collections/${slug}`
    : `/${locale}/collections/${slug}`;
}

/**
 * Detail-page `alternates`, mirroring the blog's policy: hreflang lists only
 * locales with a real article body, and fallback pages canonicalize onto the
 * best available body locale so search engines never index the same text
 * under nine URLs. Collections without a body are fully bilingual via
 * meta.json, so they keep the zh+en pair.
 */
export function collectionAlternates(
  locale: string,
  slug: string,
  bodyLocales: string[],
) {
  const available = bodyLocales.length > 0 ? bodyLocales : ["zh", "en"];
  const canonicalLocale = available.includes(locale)
    ? locale
    : available.includes("en")
      ? "en"
      : available[0];
  const languages: Record<string, string> = {};
  for (const l of routing.locales) {
    if (available.includes(l)) {
      languages[HTML_LANG[l]] = collectionPath(l, slug);
    }
  }
  languages["x-default"] = collectionPath(
    available.includes("en") ? "en" : available[0],
    slug,
  );
  return {
    canonical: collectionPath(canonicalLocale, slug),
    languages,
  };
}
