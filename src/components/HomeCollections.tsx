import { Link } from "@/i18n/navigation";
import { CollectionPromoCard } from "@/components/CollectionPromoCard";
import type { HomeCollectionCard } from "@/lib/pages/home";
import { bcp47 } from "@/lib/site";
import type { Translator } from "@/lib/translator";

/**
 * Homepage "site-owner picks" band — sits between the scan form and the
 * leaderboard (the slot the continue-exploring strip used to hold). Cards come
 * pre-resolved from loadHomeCollectionCards (src/lib/pages/home.ts); only
 * subjects without an editorial nickname use GitHub's cached profile name.
 */
export function HomeCollections({
  locale,
  cards,
  t,
  tBlog,
}: {
  locale: string;
  cards: HomeCollectionCard[];
  /** "collections" namespace. */
  t: Translator;
  /** "blog" namespace. */
  tBlog: Translator;
}) {
  if (cards.length === 0) return null;
  const dateFmt = new Intl.DateTimeFormat(bcp47(locale), {
    year: "2-digit",
    month: "numeric",
    day: "2-digit",
  });
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
        {cards.map((card) => (
          <CollectionPromoCard
            key={card.slug}
            slug={card.slug}
            position={card.position}
            title={card.title}
            intro={card.intro}
            typeLabel={t(`type.${card.type}`)}
            githubUsername={card.githubUsername}
            identityName={card.identityName}
            avatarUrl={card.avatarUrl}
            metaLine={[
              dateFmt.format(new Date(card.publishedAt)),
              card.readingMinutes !== null
                ? tBlog("readingTime", { minutes: card.readingMinutes })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
        ))}
      </div>
    </section>
  );
}
