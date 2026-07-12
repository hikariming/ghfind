import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link, redirect } from "@/i18n/navigation";
import { getAccountDetail, getMatchup } from "@/lib/db";
import { SUBSCORE_MAX } from "@/lib/score";
import { DIMENSIONS, barColor } from "@/lib/dimensions";
import { TIER_KEY } from "@/lib/tier";
import { verdict } from "@/lib/verdict";
import { normalizeUsername } from "@/lib/username";
import { localeAlternates, localePath, VS_MIN_SCORE } from "@/lib/site";
import { normLang } from "@/lib/lang";
import type { RoastLine } from "@/lib/types";
import { VsPlayerCard } from "@/components/VsPlayerCard";
import { VsSummonButton } from "@/components/VsSummonButton";
import { VsVerdictLive } from "@/components/VsVerdictLive";
import { VsShare } from "@/components/VsShare";

export const dynamic = "force-dynamic";

// Dedupe the DB reads between generateMetadata() and the page render.
const getDetail = cache((username: string) => getAccountDetail(username));
const getM = cache((a: string, b: string) => getMatchup(a, b));

/** Pick the content-language side of a bilingual line, falling back to the other. */
function localeSide(line: RoastLine | null | undefined, locale: string): string {
  if (!line) return "";
  return normLang(locale) === "en" ? line.en || line.zh : line.zh || line.en;
}

/** Normalize + canonicalize (lowercased, dictionary order) a /vs pair, or null
 *  if either handle is invalid. */
function canonicalize(a: string, b: string): { a: string; b: string } | null {
  const na = normalizeUsername(decodeURIComponent(a));
  const nb = normalizeUsername(decodeURIComponent(b));
  if (!na || !nb) return null;
  const [x, y] = [na.toLowerCase(), nb.toLowerCase()].sort();
  return { a: x, b: y };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; a: string; b: string }>;
}): Promise<Metadata> {
  const { locale, a, b } = await params;
  const t = await getTranslations({ locale, namespace: "vs" });
  const pair = canonicalize(a, b);
  if (!pair) return { title: t("heading") };
  const title = t("metaTitle", { a: pair.a, b: pair.b });
  const description = t("metaDescription", { a: pair.a, b: pair.b });
  const image =
    normLang(locale) === "en"
      ? `/api/card/vs/${pair.a}/${pair.b}`
      : `/api/card/vs/${pair.a}/${pair.b}?lang=zh`;
  // Index only a matchup that earned an LLM verdict AND clears the floor on both
  // sides — keeps N² UGC pairs out of the index but lets real, judged duels rank.
  const matchup = await getM(pair.a, pair.b);
  const indexable =
    !!matchup?.verdict &&
    matchup.scoreA >= VS_MIN_SCORE &&
    matchup.scoreB >= VS_MIN_SCORE;
  return {
    title,
    description,
    robots: indexable ? undefined : { index: false, follow: true },
    alternates: localeAlternates(locale, `/vs/${pair.a}/${pair.b}`),
    openGraph: {
      title,
      description,
      url: localePath(locale, `/vs/${pair.a}/${pair.b}`),
      type: "website",
      images: [{ url: image, width: 1200, height: 630 }],
    },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default async function VsPage({
  params,
}: {
  params: Promise<{ locale: string; a: string; b: string }>;
}) {
  const { locale, a, b } = await params;
  const pair = canonicalize(a, b);
  if (!pair) notFound();

  // Redirect any non-canonical spelling (case / order) to the canonical slug so
  // /vs/b/a and /vs/A/B consolidate to one URL (and one OG image / cache entry).
  if (decodeURIComponent(a) !== pair.a || decodeURIComponent(b) !== pair.b) {
    redirect({ href: `/vs/${pair.a}/${pair.b}`, locale });
  }

  setRequestLocale(locale);
  const t = await getTranslations("vs");
  const tDim = await getTranslations("dimensions");
  const tTier = await getTranslations("tiers");

  const [da, db, matchup] = await Promise.all([
    getDetail(pair.a),
    getDetail(pair.b),
    getM(pair.a, pair.b),
  ]);
  const v = verdict(da, db);

  const tierName = (d: typeof da) => (d ? tTier(`${TIER_KEY[d.tier]}.name`) : null);
  const bucketLabel = v.missing
    ? null
    : v.bucket === "crush"
      ? t("bucketCrush")
      : v.bucket === "edge"
        ? t("bucketEdge")
        : t("bucketEven");

  // SSR verdict: a stored LLM verdict (indexable, instant on repeat visits) wins;
  // else the neutral/tie/deterministic template. The client component swaps in a
  // freshly-generated LLM verdict when one is eligible but not yet stored.
  const storedVerdict = localeSide(matchup?.verdict, locale);
  const storedAdvice = localeSide(matchup?.advice, locale);
  const templateLine = v.missing
    ? t("verdictMissing")
    : v.winner === "tie"
      ? t("verdictTie")
      : t(v.templateKey, v.slots);
  const initialVerdict = storedVerdict || templateLine;
  const bothEligible = !!(
    da &&
    db &&
    da.final_score >= VS_MIN_SCORE &&
    db.final_score >= VS_MIN_SCORE
  );

  // "换个对手" seeds the loser back into the Omnibox in half-state.
  const loser =
    !v.missing && v.winner !== "tie" ? v.slots.loser : da?.username ?? pair.a;

  return (
    <main className="relative isolate flex w-full flex-1 justify-center px-5 py-14 sm:py-20">
      <div className="flex w-full max-w-4xl flex-col">
        <Link href="/leaderboard" prefetch={false} className="text-sm text-zinc-400 hover:text-zinc-200">
          {t("back")}
        </Link>

        <h1 className="mt-4 text-center text-2xl font-black text-zinc-100">{t("heading")}</h1>

        {/* Dueling identity cards with the big VS in the middle. */}
        <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
          <VsPlayerCard
            username={pair.a}
            detail={da}
            tierName={tierName(da)}
            notRatedLabel={t("notRated")}
            winLabel={v.winner === "a" ? t("win") : null}
          >
            {!da && <VsSummonButton username={pair.a} />}
          </VsPlayerCard>

          <div className="flex shrink-0 items-center justify-center py-2 sm:px-2">
            <span className="text-4xl font-black text-orange-500 sm:text-5xl">VS</span>
          </div>

          <VsPlayerCard
            username={pair.b}
            detail={db}
            tierName={tierName(db)}
            notRatedLabel={t("notRated")}
            winLabel={v.winner === "b" ? t("win") : null}
          >
            {!db && <VsSummonButton username={pair.b} />}
          </VsPlayerCard>
        </div>

        {/* Verdict banner (auto-generates the LLM verdict + advice on first human
            visit when both sides are eligible; otherwise shows the template). */}
        <VsVerdictLive
          a={pair.a}
          b={pair.b}
          bucketLabel={bucketLabel}
          initialVerdict={initialVerdict}
          initialAdvice={storedAdvice}
          adviceHeading={t("adviceHeading")}
          autoGenerate={bothEligible && !matchup?.verdict}
        />

        {da && db && (
          <>
            {/* Dimension duel — mirrored bars, winner bolded */}
            <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.04] p-5 sm:p-6">
              <h2 className="mb-4 text-center text-base font-bold text-zinc-200">
                {t("dimensionsHeading")}
              </h2>
              <div className="flex flex-col gap-4">
                {DIMENSIONS.map((key) => {
                  const max = SUBSCORE_MAX[key];
                  const va = da.sub_scores[key] ?? 0;
                  const vb = db.sub_scores[key] ?? 0;
                  const pa = Math.max(0, Math.min(1, va / max));
                  const pb = Math.max(0, Math.min(1, vb / max));
                  const w = v.dimWinners[key];
                  return (
                    <div key={key} className="flex items-center gap-3">
                      {/* left (a) — fills toward the center */}
                      <div className="flex flex-1 items-center justify-end gap-2">
                        <span
                          className={`text-sm tabular-nums ${w === "a" ? "font-bold text-emerald-300" : "text-zinc-400"}`}
                        >
                          {va.toFixed(1)}
                        </span>
                        <div className="h-2 w-full max-w-[9rem] overflow-hidden rounded-full bg-white/10">
                          <div
                            className={`ml-auto h-full rounded-full ${barColor(pa)}`}
                            style={{ width: `${pa * 100}%` }}
                          />
                        </div>
                      </div>
                      <div className="w-28 shrink-0 text-center text-xs text-zinc-400">
                        {tDim(key)}
                      </div>
                      {/* right (b) */}
                      <div className="flex flex-1 items-center gap-2">
                        <div className="h-2 w-full max-w-[9rem] overflow-hidden rounded-full bg-white/10">
                          <div
                            className={`h-full rounded-full ${barColor(pb)}`}
                            style={{ width: `${pb * 100}%` }}
                          />
                        </div>
                        <span
                          className={`text-sm tabular-nums ${w === "b" ? "font-bold text-emerald-300" : "text-zinc-400"}`}
                        >
                          {vb.toFixed(1)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Total score row */}
            <section className="mt-4 flex items-center justify-center gap-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5">
              <div className="text-center">
                <div className="text-xs text-zinc-500">@{da.username}</div>
                <div className="text-3xl font-black tabular-nums text-zinc-100">
                  {da.final_score.toFixed(2)}
                </div>
              </div>
              <div className="text-center text-sm text-zinc-500">
                {t("totalHeading")}
                <div className="text-zinc-400">Δ {v.gap.toFixed(2)}</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-zinc-500">@{db.username}</div>
                <div className="text-3xl font-black tabular-nums text-zinc-100">
                  {db.final_score.toFixed(2)}
                </div>
              </div>
            </section>
          </>
        )}

        {v.missing && !da && !db && (
          <p className="mt-6 text-center text-sm text-zinc-400">{t("bothMissing")}</p>
        )}

        {/* Save / share the result as a big flex image */}
        {da && db && (
          <div className="mt-6">
            <VsShare
              a={{ username: da.username, avatarUrl: da.avatar_url, score: da.final_score, tier: da.tier, subScores: da.sub_scores }}
              b={{ username: db.username, avatarUrl: db.avatar_url, score: db.final_score, tier: db.tier, subScores: db.sub_scores }}
              winner={v.winner}
              bucketLabel={bucketLabel ?? t("bucketEven")}
              verdictLine={initialVerdict}
              adviceLine={storedAdvice}
            />
          </div>
        )}

        {/* Keep the chain going */}
        <footer className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Link
            href={`/?username=${encodeURIComponent(`${loser} vs `)}`}
            className="rounded-full border border-white/10 px-5 py-2 text-sm text-zinc-200 hover:bg-white/10"
          >
            {t("swapOpponent")}
          </Link>
          <Link
            href="/"
            className="rounded-full bg-orange-600 px-5 py-2 text-sm font-medium text-white hover:bg-orange-500"
          >
            {t("judgeMe")}
          </Link>
        </footer>
      </div>
    </main>
  );
}
