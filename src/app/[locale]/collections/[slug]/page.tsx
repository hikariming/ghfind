import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { Link } from "@/i18n/navigation";
import {
  JsonLd,
  collectionFeatureJsonLd,
  curatedCollectionJsonLd,
} from "@/components/JsonLd";
import { CollectionCommentBubbles } from "@/components/CollectionCommentBubbles";
import { PostBody } from "@/components/blog/PostBody";
import { CollectionItemCard } from "@/components/collections/CollectionItemCard";
import {
  collectionAlternates,
  getCollection,
  getCollectionArticle,
  getCollectionSlugs,
  pickText,
  type CollectionSubject,
} from "@/lib/collections";
import { bcp47, localePath } from "@/lib/site";

// Fully static: pure fs reads, prerendered per slug × locale at build time —
// a feature piece landing on a hot feed never touches a function invocation.
export const dynamicParams = false;

export function generateStaticParams() {
  return getCollectionSlugs().flatMap((slug) =>
    routing.locales.map((locale) => ({ locale, slug })),
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const collection = getCollection(slug);
  if (!collection) return {};
  const title = pickText(collection.title, locale);
  const description = pickText(collection.intro, locale);
  const url = localePath(locale, `/collections/${slug}`);
  return {
    title: `${title} · ghfind`,
    description,
    alternates: collectionAlternates(locale, slug, collection.bodyLocales),
    openGraph: {
      title,
      description,
      type: "article",
      url,
      publishedTime: collection.publishedAt,
    },
    twitter: { card: "summary_large_image", title, description },
  };
}

async function SubjectCard({
  subject,
  locale,
}: {
  subject: CollectionSubject;
  locale: string;
}) {
  const t = await getTranslations("collections");
  const isRepo = subject.kind === "repo";
  const avatarOwner = isRepo ? subject.id.split("/")[0] : subject.id;
  const profileHref = isRepo
    ? `/developers/repo/${subject.id}`
    : `/u/${subject.id}`;
  return (
    <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.035] p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- GitHub avatar; the image optimizer would just add Vercel cost */}
          <img
            src={`https://github.com/${avatarOwner}.png?size=128`}
            alt=""
            loading="lazy"
            className="h-14 w-14 shrink-0 rounded-full ring-2 ring-orange-400/40"
          />
          <div className="min-w-0">
            <div className="break-all text-lg font-black text-zinc-100">
              {subject.nickname ?? (isRepo ? subject.id : `@${subject.id}`)}
            </div>
            <div className="text-xs text-zinc-500">
              {isRepo ? subject.id : `@${subject.id}`}
            </div>
            {subject.headline && (
              <p className="mt-1 text-sm leading-relaxed text-zinc-400">
                {pickText(subject.headline, locale)}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={profileHref}
            prefetch={false}
            className="rounded-full bg-orange-500/10 px-4 py-2 text-sm font-semibold text-orange-200 transition-colors hover:bg-orange-500/20"
          >
            {t("viewProfile")}
          </Link>
          <a
            href={`https://github.com/${subject.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-white/10 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-white/[0.06]"
          >
            {t("githubLink")} ↗
          </a>
        </div>
      </div>
    </section>
  );
}

export default async function CollectionPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const collection = getCollection(slug);
  if (!collection) notFound();
  setRequestLocale(locale);
  const t = await getTranslations("collections");
  const tBlog = await getTranslations("blog");
  const article = getCollectionArticle(slug, locale);
  const isFallbackBody = article !== null && article.bodyLocale !== locale;
  const dateFmt = new Intl.DateTimeFormat(bcp47(locale), {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const featureSubject =
    collection.subject && collection.subject.kind === "developer"
      ? collection.subject
      : null;

  return (
    <main className="relative isolate flex w-full flex-1 justify-center px-5 py-14 sm:px-6 sm:py-20">
      <CollectionCommentBubbles
        lang={locale === "zh" ? "zh" : "en"}
        collectionSlug={slug}
      />
      <div className="relative z-10 flex w-full max-w-3xl flex-col">
      {featureSubject && article ? (
        <JsonLd
          data={collectionFeatureJsonLd({
            slug,
            locale,
            title: pickText(collection.title, locale),
            description: pickText(collection.intro, locale),
            datePublished: collection.publishedAt,
            subject: {
              name: featureSubject.nickname ?? featureSubject.id,
              githubUrl: `https://github.com/${featureSubject.id}`,
              profilePath: localePath(locale, `/u/${featureSubject.id}`),
            },
          })}
        />
      ) : (
        <JsonLd
          data={curatedCollectionJsonLd({
            slug,
            locale,
            name: pickText(collection.title, locale),
            description: pickText(collection.intro, locale),
            datePublished: collection.publishedAt,
            items: collection.items.map((item) => ({
              kind: item.kind,
              name: item.kind === "repo" ? item.id : `@${item.id}`,
              path:
                item.kind === "repo"
                  ? localePath(locale, `/developers/repo/${item.id}`)
                  : localePath(locale, `/u/${item.id}`),
            })),
          })}
        />
      )}

      <nav className="text-sm">
        <Link
          href="/collections"
          prefetch={false}
          className="text-zinc-500 underline-offset-4 hover:text-zinc-300 hover:underline"
        >
          ← {t("backToCollections")}
        </Link>
      </nav>

      <header className="mt-6">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-orange-500/10 px-2.5 py-1 font-semibold text-orange-200">
            {t(`type.${collection.type}`)}
          </span>
          {collection.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-white/10 px-2 py-0.5 text-zinc-500"
            >
              {tag}
            </span>
          ))}
        </div>
        <h1 className="mt-3 text-3xl font-black leading-tight tracking-tight text-zinc-100 sm:text-4xl">
          {pickText(collection.title, locale)}
        </h1>
        <p className="mt-4 leading-relaxed text-zinc-400">
          {pickText(collection.intro, locale)}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-zinc-500">
          <time dateTime={collection.publishedAt}>
            {t("publishedOn", {
              date: dateFmt.format(new Date(collection.publishedAt)),
            })}
          </time>
          {article && (
            <>
              <span aria-hidden>·</span>
              <span>{tBlog("readingTime", { minutes: article.readingMinutes })}</span>
            </>
          )}
          {collection.items.length > 0 && (
            <>
              <span aria-hidden>·</span>
              <span>{t("itemCount", { count: collection.items.length })}</span>
            </>
          )}
        </div>
      </header>

      {collection.subject && (
        <SubjectCard subject={collection.subject} locale={locale} />
      )}

      {article && (
        <>
          {isFallbackBody && (
            <p className="mt-8 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-4 py-2.5 text-sm text-zinc-400">
              {t("notTranslated")}
            </p>
          )}
          {/* Body locales are zh/en — keep the article LTR even under an RTL UI locale. */}
          <div className="mt-8" dir={isFallbackBody ? "ltr" : undefined}>
            <PostBody body={article.body} />
          </div>
        </>
      )}

      {collection.items.length > 0 && (
        <>
          <div className="mt-10 flex flex-col gap-5">
            {collection.items.map((item, i) => (
              <CollectionItemCard
                key={`${item.kind}:${item.id}`}
                item={item}
                locale={locale}
                position={i + 1}
              />
            ))}
          </div>
          <p className="mt-10 text-xs leading-relaxed text-zinc-600">
            {t("dataNote")}
          </p>
        </>
      )}
      </div>
    </main>
  );
}
