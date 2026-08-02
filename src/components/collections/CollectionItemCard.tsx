import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import type { CollectionItem, DeveloperPickStats, RepoPickStats } from "@/lib/collections";
import { pickText } from "@/lib/collections";
import { TIER_KEY, tierStyle } from "@/lib/tier";

/**
 * Server-rendered cards for curated collection items. Numbers come from the
 * item's static `stats` block; the real-data phase swaps the stats source for
 * live `repos`/`scores` lookups without touching markup. Main links stay
 * on-site (repo page / profile page) — GitHub is a corner link.
 */

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function Blurb({ label, text }: { label: string; text: string }) {
  return (
    <div className="mt-4 rounded-xl border border-orange-400/20 bg-orange-500/[0.06] p-4">
      <div className="text-[10px] font-bold uppercase tracking-wide text-orange-300/90">
        {label}
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-zinc-200">{text}</p>
    </div>
  );
}

function PositionBadge({ position }: { position: number }) {
  return (
    <span className="shrink-0 text-2xl font-black tabular-nums text-zinc-700 sm:text-3xl">
      {String(position).padStart(2, "0")}
    </span>
  );
}

export async function RepoPickCard({
  item,
  locale,
  position,
}: {
  item: Extract<CollectionItem, { kind: "repo" }>;
  locale: string;
  position: number;
}) {
  const t = await getTranslations("collections");
  const stats: RepoPickStats = item.stats;
  const [owner, name] = item.id.split("/");
  const href = `/developers/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  return (
    <article className="rounded-2xl border border-white/10 bg-white/[0.035] p-5 transition-colors hover:border-white/20 sm:p-6">
      <div className="flex items-start gap-4">
        <PositionBadge position={position} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <Link
                href={href}
                prefetch={false}
                className="break-all text-lg font-black text-zinc-100 underline-offset-4 hover:text-white hover:underline sm:text-xl"
              >
                {item.id}
              </Link>
              {stats.description && (
                <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
                  {stats.description}
                </p>
              )}
            </div>
            <div className="shrink-0 text-end text-sm tabular-nums text-zinc-400">
              <div>★ {compact.format(stats.stars)}</div>
              {stats.language && (
                <div className="mt-1 text-xs text-zinc-500">{stats.language}</div>
              )}
            </div>
          </div>

          <Blurb label={t("whyPick")} text={pickText(item.blurb, locale)} />

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {(stats.contributors ?? []).map((c) => {
                const style = tierStyle(c.tier);
                return (
                  <Link
                    key={c.username}
                    href={`/u/${c.username}`}
                    prefetch={false}
                    className={`rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] hover:bg-white/[0.07] ${style.text}`}
                  >
                    {style.emoji} @{c.username}
                  </Link>
                );
              })}
              {typeof stats.avgScore === "number" && (
                <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-200">
                  {stats.avgScore} {t("avgScoreLabel")}
                </span>
              )}
            </div>
            <a
              href={`https://github.com/${item.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-zinc-500 underline-offset-4 hover:text-zinc-300 hover:underline"
            >
              {t("githubLink")} ↗
            </a>
          </div>
        </div>
      </div>
    </article>
  );
}

export async function DeveloperPickCard({
  item,
  locale,
  position,
}: {
  item: Extract<CollectionItem, { kind: "developer" }>;
  locale: string;
  position: number;
}) {
  const t = await getTranslations("collections");
  const tTiers = await getTranslations("tiers");
  const stats: DeveloperPickStats = item.stats;
  const style = tierStyle(stats.tier);
  return (
    <article className="rounded-2xl border border-white/10 bg-white/[0.035] p-5 transition-colors hover:border-white/20 sm:p-6">
      <div className="flex items-start gap-4">
        <PositionBadge position={position} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- GitHub avatar; the image optimizer would just add Vercel cost */}
              <img
                src={`https://github.com/${item.id}.png?size=112`}
                alt=""
                loading="lazy"
                className={`h-12 w-12 shrink-0 rounded-full ring-2 ${style.ring}`}
              />
              <div className="min-w-0">
                <Link
                  href={`/u/${item.id}`}
                  prefetch={false}
                  className="break-all text-lg font-black text-zinc-100 underline-offset-4 hover:text-white hover:underline sm:text-xl"
                >
                  @{item.id}
                </Link>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  {stats.name && <span>{stats.name}</span>}
                  <span className={`font-semibold ${style.text}`}>
                    {style.emoji} {tTiers(`${TIER_KEY[stats.tier]}.name`)}
                  </span>
                </div>
              </div>
            </div>
            <div className="shrink-0 text-end">
              <div className="text-2xl font-black tabular-nums text-zinc-100">
                {stats.score}
              </div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">
                {t("scoreLabel")}
              </div>
            </div>
          </div>

          <Blurb label={t("whyPick")} text={pickText(item.blurb, locale)} />

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
              {typeof stats.followers === "number" && (
                <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 tabular-nums">
                  {compact.format(stats.followers)} {t("followersLabel")}
                </span>
              )}
              {typeof stats.totalStars === "number" && (
                <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-1 tabular-nums">
                  ★ {compact.format(stats.totalStars)} {t("totalStarsLabel")}
                </span>
              )}
              {(stats.languages ?? []).map((lang) => (
                <span
                  key={lang}
                  className="rounded-full border border-emerald-400/25 bg-emerald-500/10 px-2 py-1 text-emerald-200/90"
                >
                  {lang}
                </span>
              ))}
            </div>
            <a
              href={`https://github.com/${item.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-zinc-500 underline-offset-4 hover:text-zinc-300 hover:underline"
            >
              {t("githubLink")} ↗
            </a>
          </div>
        </div>
      </div>
    </article>
  );
}

export async function CollectionItemCard({
  item,
  locale,
  position,
}: {
  item: CollectionItem;
  locale: string;
  position: number;
}) {
  return item.kind === "repo" ? (
    <RepoPickCard item={item} locale={locale} position={position} />
  ) : (
    <DeveloperPickCard item={item} locale={locale} position={position} />
  );
}
