import { BookOpen, Code2, FileSearch, Users } from "lucide-react";
import type { PostMeta } from "@/lib/blog";
import { Link } from "@/i18n/navigation";
import {
  JsonLd,
  collectionFeatureJsonLd,
  curatedCollectionJsonLd,
} from "@/components/JsonLd";
import { PostBody } from "@/components/blog/PostBody";
import { CollectionItemCard } from "@/components/collections/CollectionItemCard";
import {
  articleReadingMinutes,
  pickText,
  type Collection,
  type CollectionArticle,
  type CollectionSubject,
} from "@/lib/collections";
import { bcp47, localePath } from "@/lib/site";
import type { Translator } from "@/lib/translator";

/**
 * Collection page bodies, shared by the Next app and the Astro app
 * (apps/web) so both stacks render identical markup. Pure and sync: each page
 * resolves its data and translators ("collections", "blog", "tiers"), then
 * hands them over.
 */

type ResearchImage = { src: string; label: string; portrait?: boolean };

const RESEARCH_ICONS: Record<string, ResearchImage[] | undefined> = {
  "how-we-score-github-accounts": [{ src: "/research-icons/how-we-score-github-accounts.webp", label: "" }],
  "we-scored-19000-github-accounts": [{ src: "/research-icons/we-scored-19000-github-accounts.webp", label: "" }],
  "who-builds-openclaw": [{ src: "/research-icons/openclaw.webp", label: "OpenClaw" }],
  "agents-heart-hands-body": [
    { src: "/research-icons/yuiju.webp", label: "yuiju" },
    { src: "/research-icons/lathe.webp", label: "lathe" },
    { src: "/mosoo.svg", label: "mosoo" },
  ],
  "deepseek-harness-apache-maka": [
    { src: "/deepseek.svg", label: "DeepSeek Harness" },
    { src: "/research-icons/maka.webp", label: "Apache Maka" },
  ],
  "max-liu": [{ src: "/research-icons/max-liu-portrait.webp", label: "Max Liu", portrait: true }],
  "who-builds-dify": [{ src: "/research-icons/dify.svg", label: "Dify" }],
};

function ResearchArtwork({ images }: { images: ResearchImage[] }) {
  const grouped = images.length > 1;
  const positions = images.length === 3
    ? ["left-0 top-0", "right-0 top-0", "bottom-0 left-3"]
    : ["left-0 top-0", "bottom-0 right-0"];
  return (
    <span className="relative mt-1 block h-12 w-12 shrink-0" title={images.map(image => image.label).filter(Boolean).join(" · ")}>
      {images.map((image, index) => (
        // eslint-disable-next-line @next/next/no-img-element -- small local artwork and source project marks
        <img
          key={image.src}
          src={image.src}
          alt=""
          width={grouped ? 24 : 48}
          height={grouped ? 24 : 48}
          loading="lazy"
          className={grouped
            ? `absolute h-6 w-6 rounded-md bg-white object-contain ${positions[index]}`
            : `h-12 w-12 rounded-xl ${image.portrait ? "object-cover" : "object-contain"} ${image.label === "Dify" ? "bg-white p-1" : ""}`}
        />
      ))}
    </span>
  );
}

const longDate = (locale: string) =>
  new Intl.DateTimeFormat(bcp47(locale), { year: "numeric", month: "long", day: "numeric" });

export function CollectionsIndexView({
  locale,
  collections,
  posts,
  t,
  tBlog,
}: {
  locale: string;
  collections: Collection[];
  posts: PostMeta[];
  t: Translator;
  tBlog: Translator;
}) {
  const dateFmt = longDate(locale);
  const entries = [
    ...collections.map(collection => ({
      href: `/collections/${collection.slug}`,
      title: pickText(collection.title, locale),
      description: pickText(collection.intro, locale),
      date: collection.publishedAt,
      tags: collection.tags,
      label: t(`type.${collection.type}`),
      minutes: articleReadingMinutes(collection, locale),
      count: collection.items.length,
      avatarOwner: collection.subject?.id.split("/")[0],
      artwork: RESEARCH_ICONS[collection.slug],
      Icon: collection.type === "developers" ? Users : collection.type === "projects" ? Code2 : BookOpen,
    })),
    ...posts.map(post => ({
      href: `/blog/${post.slug}`,
      title: post.title,
      description: post.description,
      date: post.date,
      tags: post.tags,
      label: tBlog("heading"),
      minutes: post.readingMinutes,
      count: 0,
      avatarOwner: undefined,
      artwork: RESEARCH_ICONS[post.slug],
      Icon: FileSearch,
    })),
  ].sort((a, b) => b.date.localeCompare(a.date) || a.href.localeCompare(b.href));

  return (
    <main className="research-index mx-auto flex w-full flex-1 flex-col px-5 py-8 sm:px-8 sm:py-10">
      <header className="max-w-3xl">
        <p className="text-sm font-medium tracking-wide text-muted-foreground">
          {t("eyebrow")}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          {t("heading")}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">{t("subtitle")}</p>
      </header>

      <div className="mt-6 flex flex-col">
        {entries.map((entry) => {
          const Icon = entry.Icon;
          return (
            <article key={entry.href}>
              <Link
                href={entry.href}
                prefetch={false}
                className="collection-index-entry group block"
              >
                <div className="flex items-start gap-4">
                  {entry.avatarOwner ? (
                    // eslint-disable-next-line @next/next/no-img-element -- GitHub avatar; the image optimizer would just add Vercel cost
                    <img
                      src={`https://github.com/${entry.avatarOwner}.png?size=112`}
                      alt=""
                      loading="lazy"
                      className="mt-1 h-12 w-12 shrink-0 rounded-xl"
                    />
                  ) : entry.artwork ? (
                    <ResearchArtwork images={entry.artwork} />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="mt-1 flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"
                    >
                      <Icon className="h-6 w-6" strokeWidth={1.7} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium text-muted-foreground">
                        {entry.label}
                      </span>
                      {entry.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-md bg-muted px-2 py-0.5 text-muted-foreground"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                    <h2 className="mt-3 text-xl font-bold text-zinc-100 group-hover:text-white sm:text-2xl">
                      {entry.title}
                    </h2>
                    <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-zinc-400">
                      {entry.description}
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-zinc-500">
                      <time dateTime={entry.date}>
                        {t("publishedOn", {
                          date: dateFmt.format(new Date(entry.date)),
                        })}
                      </time>
                      {entry.minutes !== null && (
                        <>
                          <span aria-hidden>·</span>
                          <span>
                            {tBlog("readingTime", { minutes: entry.minutes })}
                          </span>
                        </>
                      )}
                      {entry.count > 0 && (
                        <>
                          <span aria-hidden>·</span>
                          <span>{t("itemCount", { count: entry.count })}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </Link>
            </article>
          );
        })}
        {entries.length === 0 && <p className="text-zinc-500">{t("empty")}</p>}
      </div>
    </main>
  );
}

function SubjectCard({
  subject,
  locale,
  t,
}: {
  subject: CollectionSubject;
  locale: string;
  t: Translator;
}) {
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

/**
 * The content column of a collection page. The surrounding <main> and the
 * comment bubbles (a client component) stay with each page, because the
 * Astro page hydrates the bubbles as a separate island. `article` is the
 * body served for `locale` (getCollectionArticle), null when there is none.
 */
export function CollectionView({
  locale,
  slug,
  collection,
  article,
  t,
  tBlog,
  tTiers,
}: {
  locale: string;
  slug: string;
  collection: Collection;
  article: CollectionArticle | null;
  t: Translator;
  tBlog: Translator;
  tTiers: Translator;
}) {
  const isFallbackBody = article !== null && article.bodyLocale !== locale;
  const dateFmt = longDate(locale);

  const featureSubject =
    collection.subject && collection.subject.kind === "developer"
      ? collection.subject
      : null;

  return (
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
      <SubjectCard subject={collection.subject} locale={locale} t={t} />
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
              t={t}
              tTiers={tTiers}
            />
          ))}
        </div>
        <p className="mt-10 text-xs leading-relaxed text-zinc-600">
          {t("dataNote")}
        </p>
      </>
    )}
    </div>
  );
}
