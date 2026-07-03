import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { routing } from "@/i18n/routing";

/**
 * Filesystem blog loader. Posts live in `content/blog/<slug>/<locale>.md` —
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

const BLOG_DIR = path.join(process.cwd(), "content", "blog");

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
  if (!fs.existsSync(BLOG_DIR)) return [];
  return fs
    .readdirSync(BLOG_DIR, { withFileTypes: true })
    .filter(
      (d) => d.isDirectory() && fs.existsSync(path.join(BLOG_DIR, d.name, "en.md")),
    )
    .map((d) => d.name);
}

function localesFor(slug: string): string[] {
  return fs
    .readdirSync(path.join(BLOG_DIR, slug))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));
}

export function getPost(slug: string, locale: string): Post | null {
  // Slugs come from route params — refuse anything that could escape BLOG_DIR.
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const dir = path.join(BLOG_DIR, slug);
  if (!fs.existsSync(path.join(dir, "en.md"))) return null;
  const availableLocales = localesFor(slug);
  const isFallback = !availableLocales.includes(locale);
  const file = path.join(dir, `${isFallback ? "en" : locale}.md`);
  const { data, content } = matter(fs.readFileSync(file, "utf8"));
  const en = isFallback
    ? data
    : matter(fs.readFileSync(path.join(dir, "en.md"), "utf8")).data;
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
function readingMinutes(text: string): number {
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
      languages[l === "zh" ? "zh-CN" : l] = postPath(l, slug);
    }
  }
  languages["x-default"] = postPath(availableLocales.includes("en") ? "en" : "zh", slug);
  return {
    canonical: isFallback ? postPath("en", slug) : postPath(locale, slug),
    languages,
  };
}
