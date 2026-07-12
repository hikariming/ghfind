import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { Link } from "@/i18n/navigation";
import { JsonLd, articleJsonLd, datasetJsonLd } from "@/components/JsonLd";
import { PostBody } from "@/components/blog/PostBody";
import { getPost, getPostSlugs, postAlternates } from "@/lib/blog";
import { bcp47, localePath } from "@/lib/site";

// Fully static: pure fs reads, prerendered per slug × locale at build time —
// an article on the HN front page never touches a function invocation.
export const dynamicParams = false;

export function generateStaticParams() {
  return getPostSlugs().flatMap((slug) =>
    routing.locales.map((locale) => ({ locale, slug })),
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const post = getPost(slug, locale);
  if (!post) return {};
  const og = `/api/og/blog/${slug}`;
  const url = localePath(locale, `/blog/${slug}`);
  return {
    title: `${post.title} · ghfind`,
    description: post.description,
    alternates: {
      ...postAlternates(locale, slug, post.availableLocales),
      // Per-page markdown twin (served via the /blog/{slug}.md rewrite).
      types: { "text/markdown": `/blog/${slug}.md` },
    },
    openGraph: {
      title: post.title,
      description: post.description,
      type: "article",
      url,
      publishedTime: post.date,
      ...(post.updated ? { modifiedTime: post.updated } : {}),
      images: [{ url: og, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.description,
      images: [og],
    },
  };
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const post = getPost(slug, locale);
  if (!post) notFound();
  const t = await getTranslations("blog");
  const dateFmt = new Intl.DateTimeFormat(bcp47(locale), {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-14 sm:py-20">
      <JsonLd data={articleJsonLd(post)} />
      {post.tags.includes("data") && (
        <JsonLd
          data={datasetJsonLd({
            slug,
            locale,
            name: post.title,
            description: post.description,
            date: post.date,
            updated: post.updated,
          })}
        />
      )}
      <article>
        <header>
          <Link
            href="/blog"
            className="text-sm text-zinc-500 transition-colors hover:text-[var(--primary)]"
          >
            ← {t("backToList")}
          </Link>
          <h1 className="mt-4 text-3xl font-black leading-tight tracking-tight text-[var(--foreground)] sm:text-4xl">
            {post.title}
          </h1>
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-zinc-500">
            <time dateTime={post.date}>{dateFmt.format(new Date(post.date))}</time>
            <span aria-hidden>·</span>
            <span>{t("readingTime", { minutes: post.readingMinutes })}</span>
            {post.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs"
              >
                {tag}
              </span>
            ))}
          </div>
        </header>

        {post.isFallback && (
          <p className="mt-6 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-2.5 text-sm text-zinc-400">
            {t("notTranslated")}
          </p>
        )}

        <div className="mt-8">
          <PostBody body={post.body} />
        </div>
      </article>
    </main>
  );
}
