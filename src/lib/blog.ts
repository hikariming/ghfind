import matter from "gray-matter";
import { HTML_LANG, routing } from "@/i18n/routing";
import { contentFileExists, listContentDir, readContentFile } from "@/lib/content-files";

/**
 * Blog loader over the embedded content map (`@/lib/content-files` — no
 * runtime filesystem, so it works on Workers and inside ISR revalidation).
 * Posts live in `content/blog/<slug>/<locale>.md` —
 * `en.md` is required and is the source of truth for locale-invariant
 * frontmatter (`date`, `updated`, `tags`), so translations can never drift on
 * those fields. Translated files only own `title`/`description`/body.
 *
 * The per-post-per-locale layout is deliberately wider than the UI's current
 * zh/en routing: adding an article language later is dropping a `<locale>.md`
 * file, no restructuring. When a UI locale has no translation yet, the en body
 * is served under that route with an "untranslated" note (see `isFallback`),
 * and `postAlternates` canonicalizes the page onto the en URL so search
 * engines never index duplicate English content twice.
 */


export type PostMeta = {
  slug: string;
  title: string;
  description: string;
  /** ISO date, always from `en.md`. */
  date: string;
  updated?: string;
  tags: string[];
  locale: string;
  /** True when `locale` has no translation and the en body is being served. */
  isFallback: boolean;
  /** Locales that actually have a markdown file for this post. */
  availableLocales: string[];
  readingMinutes: number;
};

export type Post = PostMeta & { body: string };

export function getPostSlugs(): string[] {
  return listContentDir("blog").filter((slug) =>
    contentFileExists(`blog/${slug}/en.md`),
  );
}

function localesFor(slug: string): string[] {
  return listContentDir(`blog/${slug}`)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));
}

export function getPost(slug: string, locale: string): Post | null {
  // Slugs come from route params — refuse anything that isn't a plain slug.
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const enRaw = readContentFile(`blog/${slug}/en.md`);
  if (enRaw === null) return null;
  const availableLocales = localesFor(slug);
  const isFallback = !availableLocales.includes(locale);
  const raw = isFallback ? enRaw : readContentFile(`blog/${slug}/${locale}.md`);
  if (raw === null) return null;
  const { data, content } = matter(raw);
  const en = isFallback ? data : matter(enRaw).data;
  return {
    slug,
    locale,
    isFallback,
    availableLocales,
    title: String(data.title ?? slug),
    description: String(data.description ?? ""),
    date: String(en.date ?? ""),
    updated: en.updated ? String(en.updated) : undefined,
    tags: Array.isArray(en.tags) ? en.tags.map(String) : [],
    readingMinutes: readingMinutes(content),
    body: content,
  };
}

export function listPosts(locale: string): PostMeta[] {
  return getPostSlugs()
    .map((slug) => getPost(slug, locale))
    .filter((p): p is Post => p !== null)
    .map(({ body: _body, ...meta }) => meta)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** CJK-aware reading time: ideographs read per-char, latin per-word. */
export function readingMinutes(text: string): number {
  const cjk = (text.match(/[一-鿿぀-ヿ가-힯]/g) ?? []).length;
  const words = text
    .replace(/[一-鿿぀-ヿ가-힯]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(cjk / 400 + words / 220));
}

function postPath(locale: string, slug: string): string {
  return locale === routing.defaultLocale ? `/blog/${slug}` : `/${locale}/blog/${slug}`;
}

/**
 * Blog-post `alternates`: unlike the site-wide `localeAlternates` (which
 * assumes both locales always exist), hreflang here lists only locales with a
 * real translation, and a fallback page canonicalizes onto the en post.
 */
export function postAlternates(locale: string, slug: string, availableLocales: string[]) {
  const isFallback = !availableLocales.includes(locale);
  const languages: Record<string, string> = {};
  for (const l of routing.locales) {
    if (availableLocales.includes(l)) {
      languages[HTML_LANG[l]] = postPath(l, slug);
    }
  }
  languages["x-default"] = postPath(availableLocales.includes("en") ? "en" : "zh", slug);
  return {
    canonical: isFallback ? postPath("en", slug) : postPath(locale, slug),
    languages,
  };
}
