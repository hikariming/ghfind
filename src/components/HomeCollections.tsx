import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { CollectionPromoCard } from "@/components/CollectionPromoCard";
import {
  getCollectionArticle,
  getGitHubNickname,
  listCollections,
  pickText,
} from "@/lib/collections";
import { bcp47 } from "@/lib/site";

/**
 * Homepage "site-owner picks" band — sits between the scan form and the
 * leaderboard (the slot the continue-exploring strip used to hold). Fully
 * static: collection content is read from fs; only subjects without an
 * editorial nickname use GitHub's cached public profile-name fallback.
 */
export async function HomeCollections({ locale }: { locale: string }) {
  const collections = listCollections().slice(0, 6);
  if (collections.length === 0) return null;
  const t = await getTranslations("collections");
  const tBlog = await getTranslations("blog");
  const dateFmt = new Intl.DateTimeFormat(bcp47(locale), {
    year: "2-digit",
    month: "numeric",
    day: "2-digit",
  });
  const cards = await Promise.all(
    collections.map(async (collection, index) => {
      const githubUsername =
        collection.subject?.kind === "developer" ? collection.subject.id : null;
      const identityName =
        collection.subject?.nickname ??
        (githubUsername ? await getGitHubNickname(githubUsername) : null);
      return { collection, index, githubUsername, identityName };
    }),
  );

  return (
    <section className="w-full">
      <div className="flex items-end justify-between gap-4">
        <h2 className="text-xl font-black tracking-tight text-zinc-100 sm:text-2xl">
          {t("eyebrow")}
        </h2>
        <Link
          href="/collections"
          prefetch={false}
          className="shrink-0 text-sm text-zinc-400 underline-offset-4 transition-colors hover:text-zinc-200 hover:underline"
        >
          {t("viewAll")} →
        </Link>
      </div>
      <div className="collection-grid">
        {cards.map(({ collection, index, githubUsername, identityName }) => {
          const article =
            collection.bodyLocales.length > 0
              ? getCollectionArticle(collection.slug, locale)
              : null;
          const avatarOwner = collection.subject
            ? collection.subject.kind === "repo"
              ? collection.subject.id.split("/")[0]
              : collection.subject.id
            : null;
          const title = pickText(collection.title, locale);
          const titleParts = title.match(/^([^:：]+)\s*[:：]\s*(.+)$/);
          const displayName =
            identityName ?? (!collection.subject ? titleParts?.[1] : null);
          return (
            <CollectionPromoCard
              key={collection.slug}
              slug={collection.slug}
              position={index + 1}
              title={displayName ? (titleParts?.[2] ?? title) : title}
              intro={pickText(collection.intro, locale)}
              typeLabel={t(`type.${collection.type}`)}
              githubUsername={githubUsername}
              identityName={displayName ?? undefined}
              avatarUrl={
                avatarOwner ? `https://github.com/${avatarOwner}.png?size=112` : null
              }
              metaLine={[
                dateFmt.format(new Date(collection.publishedAt)),
                article
                  ? tBlog("readingTime", { minutes: article.readingMinutes })
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          );
        })}
      </div>
    </section>
  );
}
