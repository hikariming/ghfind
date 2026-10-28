import { Link } from "@/i18n/navigation";
import { JsonLd, articleJsonLd, datasetJsonLd } from "@/components/JsonLd";
import { PostBody } from "@/components/blog/PostBody";
import type { Post, PostMeta } from "@/lib/blog";
import { bcp47 } from "@/lib/site";
import type { Translator } from "@/lib/translator";

/**
 * Blog page bodies, shared by the Next app and the Astro app (apps/web) so
 * both stacks render identical markup. Pure and sync: each page resolves its
 * data and translators, then hands them over.
 */

const longDate = (locale: string) =>
  new Intl.DateTimeFormat(bcp47(locale), { year: "numeric", month: "long", day: "numeric" });

export function BlogIndexView({ locale, posts, t }: { locale: string; posts: PostMeta[]; t: Translator }) {
  // Kept as-is from the original page (not bcp47): zh → zh-CN, others raw.
  const dateFmt = new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 py-14 sm:py-20">
      <h1 className="text-3xl font-black tracking-tight text-[var(--foreground)] sm:text-5xl">
        {t("heading")}
      </h1>
      <p className="mt-3 text-zinc-400">{t("subtitle")}</p>

      <div className="mt-10 flex flex-col gap-8">
        {posts.map((post) => (
          <article key={post.slug}>
            <Link
              href={`/blog/${post.slug}`}
              className="group block rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 transition-colors hover:border-[var(--primary)]"
            >
              <h2 className="text-xl font-bold text-[var(--foreground)] group-hover:text-[var(--primary)] sm:text-2xl">
                {post.title}
              </h2>
              <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-zinc-400">
                {post.description}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-zinc-500">
                <time dateTime={post.date}>{dateFmt.format(new Date(post.date))}</time>
                <span aria-hidden>·</span>
                <span>{t("readingTime", { minutes: post.readingMinutes })}</span>
                {post.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-[var(--border)] px-2 py-0.5"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </Link>
          </article>
        ))}
        {posts.length === 0 && <p className="text-zinc-500">{t("empty")}</p>}
      </div>
    </main>
  );
}

/**
 * The article column of a post page. The surrounding <main> and the comment
 * bubbles (a client component) stay with each page, because the Astro page
 * hydrates the bubbles as a separate island.
 */
export function BlogPostView({ locale, slug, post, t }: { locale: string; slug: string; post: Post; t: Translator }) {
  const dateFmt = longDate(locale);
  return (
    <div className="relative z-10 w-full max-w-3xl">
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
          href="/collections"
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

      {/* A fallback body is English — keep it LTR even under an RTL locale. */}
      <div className="mt-8" dir={post.isFallback ? "ltr" : undefined}>
        <PostBody body={post.body} />
      </div>
      </article>
    </div>
  );
}
