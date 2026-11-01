import { HTML_LANG, routing } from "@/i18n/routing";
import { getD1Binding } from "@/lib/d1-client";
import { getCachedGitHubName, setCachedGitHubName } from "@/lib/redis";
import type { Tier } from "@/lib/types";

/**
 * Loader for the curated picks section ("编辑推荐" / Founder's picks), backed
 * by D1 (migrations/0022_collections.sql; scripts/collections-to-sql.mts turns
 * meta.json + `<locale>.md` folders into upsert SQL). Each collection has:
 *
 * - a type, multilingual title/intro, tags, an optional feature `subject`
 *   (the person/repo the piece is about) and optional `items` (card-list
 *   picks for roundup-style collections);
 * - optional long-form article bodies per locale; a locale without its own
 *   body falls back locale → en → zh.
 *
 * Listing reads never load article bodies (reading time is precomputed).
 * With no D1 binding (tests, the Next build) everything is empty; a failing
 * query throws, so pages answer 5xx — never a cacheable 404 or empty index
 * that would get the URLs dropped from search results.
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
  /** Editorial display-name override, e.g. "张昱轩 (Yuxuan Zhang)". */
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
  /** Locales that have a long-form article body. */
  bodyLocales: string[];
  /** Precomputed reading time per body locale. */
  readingMinutes: Record<string, number>;
};

export type CollectionArticle = {
  body: string;
  /** The locale actually served (may differ from the requested one). */
  bodyLocale: string;
  readingMinutes: number;
};

type Row = Record<string, unknown>;

const SLUG = /^[a-z0-9-]+$/;
const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

function localized(rows: Row[], field: string): LocalizedText | undefined {
  const text: Record<string, string> = {};
  for (const row of rows) {
    const value = str(row[field]);
    if (value) text[String(row.locale)] = value;
  }
  if (Object.keys(text).length === 0) return undefined;
  return { zh: "", en: "", ...text };
}

function groupBy(rows: Row[], key: (row: Row) => string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const k = key(row);
    const group = groups.get(k);
    if (group) group.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

/**
 * Published collections, newest first (ties: slug descending, the order the
 * file-based loader produced). `slug` narrows to one collection.
 */
async function queryCollections(slug?: string): Promise<Collection[]> {
  const db = getD1Binding();
  if (!db) return [];
  const where = slug === undefined ? "" : "AND c.slug = ?";
  const bind = slug === undefined ? [] : [slug];
  const [collections, translations, items, blurbs] = await db.batch([
    db
      .prepare(
        `SELECT slug, type, published_at, tags, subject_kind, subject_id, subject_nickname
         FROM collections c WHERE status = 'published' ${where}
         ORDER BY published_at DESC, slug DESC`,
      )
      .bind(...bind),
    db
      .prepare(
        `SELECT t.slug, t.locale, t.title, t.intro, t.subject_headline,
                t.body IS NOT NULL AS has_body, t.reading_minutes
         FROM collection_translations t JOIN collections c ON c.slug = t.slug
         WHERE c.status = 'published' ${where}
         ORDER BY t.slug, t.locale`,
      )
      .bind(...bind),
    db
      .prepare(
        `SELECT i.slug, i.position, i.kind, i.item_id, i.stats
         FROM collection_items i JOIN collections c ON c.slug = i.slug
         WHERE c.status = 'published' ${where}
         ORDER BY i.slug, i.position`,
      )
      .bind(...bind),
    db
      .prepare(
        `SELECT b.slug, b.position, b.locale, b.blurb
         FROM collection_item_translations b JOIN collections c ON c.slug = b.slug
         WHERE c.status = 'published' ${where}`,
      )
      .bind(...bind),
  ]);
  const translationsBySlug = groupBy(translations.results, (row) => String(row.slug));
  const itemsBySlug = groupBy(items.results, (row) => String(row.slug));
  const blurbsByItem = groupBy(blurbs.results, (row) => `${row.slug}/${row.position}`);

  return collections.results.map((row) => {
    const slug = String(row.slug);
    const texts = translationsBySlug.get(slug) ?? [];
    const bodies = texts.filter((t) => Number(t.has_body) === 1);
    const subjectKind = row.subject_kind;
    const subjectId = str(row.subject_id);
    const subject: CollectionSubject | undefined =
      (subjectKind === "developer" || subjectKind === "repo") && subjectId
        ? {
            kind: subjectKind,
            id: subjectId,
            ...(str(row.subject_nickname) ? { nickname: String(row.subject_nickname) } : {}),
            ...(localized(texts, "subject_headline")
              ? { headline: localized(texts, "subject_headline") }
              : {}),
          }
        : undefined;
    return {
      slug,
      type: row.type as CollectionType,
      title: localized(texts, "title") ?? { zh: slug, en: slug },
      intro: localized(texts, "intro") ?? { zh: "", en: "" },
      publishedAt: String(row.published_at),
      tags: JSON.parse(String(row.tags ?? "[]")) as string[],
      ...(subject ? { subject } : {}),
      items: (itemsBySlug.get(slug) ?? []).map(
        (item) =>
          ({
            kind: item.kind,
            id: String(item.item_id),
            blurb: localized(blurbsByItem.get(`${slug}/${item.position}`) ?? [], "blurb") ?? {
              zh: "",
              en: "",
            },
            stats: JSON.parse(String(item.stats ?? "{}")),
          }) as CollectionItem,
      ),
      bodyLocales: bodies.map((t) => String(t.locale)),
      readingMinutes: Object.fromEntries(
        bodies.map((t) => [String(t.locale), Number(t.reading_minutes) || 1]),
      ),
    };
  });
}

export async function listCollections(): Promise<Collection[]> {
  return queryCollections();
}

export async function getCollectionSlugs(): Promise<string[]> {
  return (await listCollections()).map((c) => c.slug);
}

export async function getCollection(slug: string): Promise<Collection | null> {
  // Slugs come from route params — refuse anything that isn't a plain slug.
  if (!SLUG.test(slug)) return null;
  return (await queryCollections(slug))[0] ?? null;
}

/** Cheap published-slug check (comment routes); false on any D1 failure. */
export async function collectionExists(slug: string): Promise<boolean> {
  const db = getD1Binding();
  if (!db || !SLUG.test(slug)) return false;
  try {
    const { results } = await db
      .prepare("SELECT 1 FROM collections WHERE slug = ? AND status = 'published'")
      .bind(slug)
      .all();
    return results.length > 0;
  } catch {
    return false;
  }
}

/** Body locale served for `locale`: requested → en → zh, or null without a body. */
export function articleLocale(bodyLocales: string[], locale: string): string | null {
  return [locale, "en", "zh"].find((l) => bodyLocales.includes(l)) ?? null;
}

/** Reading time of the body served for `locale`, without loading the body. */
export function articleReadingMinutes(collection: Collection, locale: string): number | null {
  const bodyLocale = articleLocale(collection.bodyLocales, locale);
  return bodyLocale ? (collection.readingMinutes[bodyLocale] ?? null) : null;
}

/** Long-form body with content-locale fallback: requested → en → zh. */
export async function getCollectionArticle(
  collection: Collection,
  locale: string,
): Promise<CollectionArticle | null> {
  const bodyLocale = articleLocale(collection.bodyLocales, locale);
  const db = getD1Binding();
  if (!bodyLocale || !db) return null;
  const { results } = await db
    .prepare(
      "SELECT body, reading_minutes FROM collection_translations WHERE slug = ? AND locale = ?",
    )
    .bind(collection.slug, bodyLocale)
    .all();
  const row = results[0];
  const body = str(row?.body);
  if (!body) return null;
  return { body, bodyLocale, readingMinutes: Number(row?.reading_minutes) || 1 };
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
 * authoritative and avoids this request entirely. Cached for a day in the
 * shared read-model cache as well as Next's data cache: unauthenticated GitHub
 * calls from shared Worker IPs are often rate-limited, and the Astro pages have
 * no data cache of their own.
 */
export async function getGitHubNickname(username: string): Promise<string | null> {
  const cached = await getCachedGitHubName(username);
  if (cached !== undefined) return cached;
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
    // Failures aren't cached: the next render retries.
    if (!response.ok) return null;
    const profile = (await response.json()) as { name?: unknown };
    const name =
      typeof profile.name === "string" && profile.name.trim() ? profile.name.trim() : null;
    await setCachedGitHubName(username, name);
    return name;
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
