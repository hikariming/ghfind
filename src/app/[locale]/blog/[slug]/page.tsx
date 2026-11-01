import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { BlogCommentBubbles } from "@/components/BlogCommentBubbles";
import { getPost, getPostSlugs, postAlternates } from "@/lib/blog";
import { localePath } from "@/lib/site";
import { BlogPostView } from "@/components/pages/BlogViews";
import { asTranslator } from "@/lib/translator";

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
  return (
    <main className="relative isolate flex w-full flex-1 justify-center px-5 py-14 sm:py-20">
      <BlogCommentBubbles lang={locale === "zh" ? "zh" : "en"} postSlug={slug} />
      <BlogPostView locale={locale} slug={slug} post={post} t={asTranslator(t)} />
    </main>
  );
}
