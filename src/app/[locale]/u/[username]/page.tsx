import { cache, Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getAccountDetail, getProfileComments, getSimilarAccounts } from "@/lib/db";
import { JsonLd, profileJsonLd } from "@/components/JsonLd";
import { SITE_URL, PUBLIC_INDEX_MIN_SCORE } from "@/lib/site";
import { CopyBadge } from "@/components/CopyBadge";
import { FloatingCommentBubbles } from "@/components/FloatingCommentBubbles";
import { TierAvatarFrame } from "@/components/TierAvatarFrame";
import { SUBSCORE_MAX } from "@/lib/score";
import { TIER_KEY, tierStyle } from "@/lib/tier";
import { normLang } from "@/lib/lang";
import type { SubScoreKey } from "@/lib/types";
import { ProfileReactionsSection } from "@/components/ProfileReactionsSection";

// Profile comments must be fresh; score/roast data is still fetched from the DB
// and remains cached at the persistence layer where applicable.
export const dynamic = "force-dynamic";

// Dedupe the DB read between generateMetadata() and the page render.
const getDetail = cache((username: string) => getAccountDetail(username));

const DIMENSIONS: SubScoreKey[] = [
  "account_maturity",
  "original_project_quality",
  "contribution_quality",
  "ecosystem_impact",
  "community_influence",
  "activity_authenticity",
];

function barColor(pct: number): string {
  if (pct >= 0.75) return "bg-emerald-400";
  if (pct >= 0.45) return "bg-amber-400";
  return "bg-rose-400";
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; username: string }>;
}): Promise<Metadata> {
  const { locale, username } = await params;
  const t = await getTranslations({ locale, namespace: "detailMeta" });
  const d = await getDetail(decodeURIComponent(username));
  if (!d) return { title: t("notFoundTitle") };

  const tt = await getTranslations({ locale, namespace: "tiers" });
  const tierName = tt(`${TIER_KEY[d.tier]}.name`);
  const title = t("title", {
    username: d.username,
    score: d.final_score.toFixed(2),
    tier: tierName,
  });
  const tags = locale === "en" ? d.tags.en : d.tags.zh;
  const description = tags.length
    ? t("descWithTags", { tags: tags.map((x) => `#${x}`).join(" "), username: d.username, siteUrl: SITE_URL.replace(/^https?:\/\//, "") })
    : t("descPlain", { username: d.username, siteUrl: SITE_URL.replace(/^https?:\/\//, "") });
  // The flex card doubles as the social preview image (resolved absolute via
  // metadataBase in layout.tsx) — so shared /u links render a rich card.
  const image = `/api/card/${d.username}`;
  const path = locale === "en" ? `/en/u/${d.username}` : `/u/${d.username}`;
  // Keep low-score profiles out of search results: they name real people, so a
  // "NPC"/"拉完了" page shouldn't rank on someone's handle. Still reachable and
  // shareable — just not indexed. Mirrors the sitemap floor.
  const indexable = d.final_score >= PUBLIC_INDEX_MIN_SCORE;
  return {
    title,
    description,
    robots: indexable ? undefined : { index: false, follow: true },
    alternates: {
      languages: { "zh-CN": `/u/${d.username}`, en: `/en/u/${d.username}` },
    },
    openGraph: {
      title,
      description,
      url: path,
      type: "website",
      images: [{ url: image, width: 1200, height: 630 }],
    },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default async function AccountPage({
  params,
}: {
  params: Promise<{ locale: string; username: string }>;
}) {
  const { locale, username } = await params;
  setRequestLocale(locale);
  const d = await getDetail(decodeURIComponent(username));
  if (!d) notFound();

  const t = await getTranslations("detail");
  const tDim = await getTranslations("dimensions");
  const tTier = await getTranslations("tiers");
  const style = tierStyle(d.tier);
  const tierKey = TIER_KEY[d.tier];
  const lang = normLang(locale);
  // English visitors read the English-cached roast; fall back to the empty state
  // (not the Chinese report) so the page never mixes languages.
  const roast = lang === "en" ? d.roast_en : d.roast;
  // The bilingual one-liner is generated in one call, so it's available in the
  // visitor's language even when the full report exists only in the other one.
  // Empty for legacy rows — those still carry the one-liner inline in `roast`.
  const roastLine = lang === "en" ? d.roast_line.en : d.roast_line.zh;
  const [similar, comments] = await Promise.all([
    getSimilarAccounts(d.username, d.final_score, d.sub_scores),
    getProfileComments(d.username),
  ]);
  const detailPath = locale === "en" ? `/en/u/${d.username}` : `/u/${d.username}`;

  return (
    <main className="relative isolate flex w-full flex-1 justify-center overflow-hidden px-5 py-14 sm:py-20">
      <FloatingCommentBubbles
        key={d.username}
        lang={lang}
        profileUsername={d.username}
        initialComments={comments}
      />
      <div className="relative z-10 flex w-full max-w-2xl flex-col">
        <JsonLd
          data={profileJsonLd({
            username: d.username,
            displayName: d.display_name,
            avatarUrl: d.avatar_url,
            profileUrl: d.profile_url,
            score: d.final_score,
            locale,
          })}
        />
        <Link href="/leaderboard" className="text-sm text-zinc-400 hover:text-zinc-200">
          {t("back")}
        </Link>

      {/* Header card */}
      <div
        className={`animate-pop mt-4 flex flex-col items-center rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-center ring-1 ${style.ring}`}
        style={{ boxShadow: `0 0 80px -20px ${style.glow}` }}
      >
        <a
          href={d.profile_url ?? `https://github.com/${d.username}`}
          target="_blank"
          rel="noopener noreferrer"
          className={`max-w-full break-all rounded-full bg-black/35 px-4 py-1.5 text-xl font-black leading-tight ${style.text} ring-1 ${style.ring} hover:bg-black/45`}
          style={{ boxShadow: `0 0 28px -10px ${style.glow}` }}
        >
          @{d.username}
        </a>
        {d.display_name && (
          <div className="mt-2 max-w-full truncate text-sm text-zinc-400">{d.display_name}</div>
        )}
        <TierAvatarFrame
          username={d.username}
          avatarUrl={d.avatar_url}
          tier={d.tier}
          size="lg"
          className="mt-5"
        />
        <div className={`mt-4 text-6xl font-black tabular-nums ${style.text}`}>
          {d.final_score.toFixed(2)}
          <span className="text-2xl text-zinc-600">/100</span>
        </div>
        <div className={`mt-1 text-2xl font-bold ${style.text}`}>
          {style.emoji} {tTier(`${tierKey}.name`)}
        </div>
        <div className="mt-1 text-sm text-zinc-400">{tTier(`${tierKey}.blurb`)}</div>

        {d.tags.zh.length + d.tags.en.length > 0 && (
          <div className="mt-3 flex flex-wrap justify-center gap-1.5">
            {d.tags.zh.map((tag, i) => (
              <span
                key={`zh-${tag}-${i}`}
                className="rounded-full bg-orange-500/10 px-2 py-0.5 text-xs text-orange-200/90"
              >
                #{tag}
              </span>
            ))}
            {d.tags.en.map((tag, i) => (
              <span
                key={`en-${tag}-${i}`}
                className="rounded-full bg-sky-500/10 px-2 py-0.5 text-xs text-sky-200/90"
              >
                #{tag}
              </span>
            ))}
          </div>
        )}
      </div>

      <Suspense
        fallback={
          <div className="mt-4 h-28 animate-pulse rounded-2xl border border-orange-300/15 bg-orange-500/[0.035]" />
        }
      >
        <ProfileReactionsSection
          key={`reactions-${d.username}`}
          username={d.username}
          redirectTo={detailPath}
        />
      </Suspense>

      {/* Dimension breakdown */}
      <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
        <h2 className="mb-4 text-base font-bold text-zinc-200">{t("dimensionsHeading")}</h2>
        <div className="flex flex-col gap-3">
          {DIMENSIONS.map((key) => {
            const max = SUBSCORE_MAX[key];
            const v = d.sub_scores[key] ?? 0;
            const pct = Math.max(0, Math.min(1, v / max));
            return (
              <div key={key}>
                <div className="mb-1 flex items-baseline justify-between text-sm">
                  <span className="text-zinc-300">{tDim(key)}</span>
                  <span className="tabular-nums text-zinc-400">
                    {v.toFixed(1)}
                    <span className="text-zinc-600"> / {max}</span>
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full rounded-full ${barColor(pct)}`}
                    style={{ width: `${pct * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Similar developers — same profile shape, nearby score */}
      {similar.length > 0 && (
        <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
          <h2 className="mb-1 text-base font-bold text-zinc-200">{t("similarHeading")}</h2>
          <p className="mb-4 text-xs text-zinc-500">{t("similarSub")}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {similar.map((s) => {
              const st = tierStyle(s.tier);
              const tag = lang === "en" ? s.tags.en[0] : s.tags.zh[0];
              return (
                <Link
                  key={s.username}
                  href={`/u/${s.username}`}
                  prefetch={false}
                  className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 hover:bg-white/[0.06]"
                >
                  {s.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={s.avatar_url} alt={s.username} className="h-8 w-8 shrink-0 rounded-full" />
                  ) : (
                    <div className="h-8 w-8 shrink-0 rounded-full bg-white/10" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-zinc-200">@{s.username}</div>
                    {tag && (
                      <div className="truncate text-[11px] text-orange-200/80">#{tag}</div>
                    )}
                  </div>
                  <span className={`shrink-0 text-right text-sm font-black tabular-nums ${st.text}`}>
                    {st.emoji} {s.final_score.toFixed(2)}
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Full roast report */}
      <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-7">
        <h2 className="mb-3 text-lg font-bold text-orange-400">{t("roastHeading")}</h2>
        {/* Savage one-liner (current language) — shown above the full report. */}
        {roastLine && (
          <p className="mb-4 rounded-xl border border-orange-500/20 bg-orange-500/[0.04] p-4 text-[0.95rem] leading-relaxed text-zinc-100">
            🔥 {roastLine}
          </p>
        )}
        {roast ? (
          <div className="report text-[0.95rem] text-zinc-200">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{roast}</ReactMarkdown>
          </div>
        ) : roastLine ? null : (
          <p className="text-sm text-zinc-500">
            {t.rich("roastEmpty", {
              a: (c) => (
                <Link href="/" className="text-orange-400 hover:underline">
                  {c}
                </Link>
              ),
            })}
          </p>
        )}
      </section>

      <div className="mt-6">
        <CopyBadge baseUrl={SITE_URL} username={d.username} version={d.scanned_at} />
      </div>

      <footer className="mt-10 text-center">
        <Link
          href="/"
          className="inline-block rounded-full bg-orange-600 px-5 py-2 text-sm font-medium text-white hover:bg-orange-500"
        >
          {t("selfCta")}
        </Link>
      </footer>
      </div>
    </main>
  );
}
