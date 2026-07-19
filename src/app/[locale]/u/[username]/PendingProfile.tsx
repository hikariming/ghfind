"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { TierAvatarFrame } from "@/components/TierAvatarFrame";
import { DimensionStarChart } from "@/components/DimensionStarChart";
import { LiveRoast } from "@/components/LiveRoast";
import { DIMENSIONS } from "@/lib/dimensions";
import { readSessionScan } from "@/lib/home-handoff";
import { TIER_KEY, tierStyle } from "@/lib/tier";
import { bcp47 } from "@/lib/site";
import { rankProfileWorks } from "@/lib/profile-work";
import type { RoastMeta, ScanResult, SubScoreKey } from "@/lib/types";

/**
 * Slim profile shell shown while a first-time username is roasted live (no
 * persisted `scores` row yet). The scan comes from the homepage handoff via
 * sessionStorage, or from the server-side cache (`initialScan`) on a direct
 * visit / shared link. Built entirely from that scan — identity, deterministic
 * score, dimension chart, top repos — plus the <LiveRoast> stream. Once the
 * roast finishes and persists, LiveRoast refreshes the page and the full
 * server-rendered profile (rank, reactions, share, badge) takes over.
 */
export function PendingProfile({
  username,
  initialScan,
  fromHome = false,
}: {
  username: string;
  initialScan: ScanResult | null;
  /** Arrived via the homepage `?roasting=1` handoff → the share popup opens
   * immediately, seeded with the deterministic scan score; the AI-adjusted
   * score and one-liner stream into it in place. */
  fromHome?: boolean;
}) {
  const t = useTranslations("detail");
  const tDim = useTranslations("dimensions");
  const tTier = useTranslations("tiers");
  const locale = useLocale();

  // Lazy init resolves the scan without a flash in the common cases: the server
  // cache (`initialScan`), or — on a client-side navigation from the homepage —
  // sessionStorage (available at mount). `readSessionScan` returns null during
  // SSR (no `window`), so a hard reload falls back to the effect below.
  const [scan, setScan] = useState<ScanResult | null>(
    () => initialScan ?? readSessionScan(username),
  );
  const [resolved, setResolved] = useState<boolean>(scan != null);
  const looked = useRef(scan != null);

  // Hard-reload fallback: on SSR the lazy init couldn't see sessionStorage, so
  // read it once after mount. Ref-guarded, so no cascading re-renders.
  useEffect(() => {
    if (scan || looked.current) return;
    looked.current = true;
    const s = readSessionScan(username);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of a browser store unavailable during SSR; ref-guarded
    if (s) setScan(s);
    setResolved(true);
  }, [username, scan]);

  if (!scan) {
    // Still checking sessionStorage → neutral spinner (avoids a not-found flash).
    if (!resolved) {
      return (
        <main className="flex w-full flex-1 items-center justify-center px-5 py-20">
          <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-orange-300/40 border-t-orange-200" />
        </main>
      );
    }
    // No scan anywhere (direct visit to an unscanned handle) → point home.
    return (
      <main className="flex w-full flex-1 items-center justify-center px-5 py-20">
        <p className="text-center text-sm text-zinc-400">
          {t("liveExpired")}{" "}
          <Link href="/" className="text-orange-400 hover:underline">
            {t("liveGoHome")}
          </Link>
        </p>
      </main>
    );
  }

  const { metrics, scoring } = scan;
  const style = tierStyle(scoring.tier);
  const tierKey = TIER_KEY[scoring.tier];
  const dimensionLabels = Object.fromEntries(
    DIMENSIONS.map((key) => [key, tDim(key)]),
  ) as Record<SubScoreKey, string>;

  const nf = new Intl.NumberFormat(bcp47(locale), {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  // Seed for the mount-time share popup: the deterministic scan score. The
  // AI-adjusted meta (score delta, tags, one-liner) streams into the popup
  // in place once the roast's meta frame arrives.
  const scanMeta: RoastMeta = {
    final_score: scoring.final_score,
    tier: scoring.tier,
    tier_label: scoring.tier_label,
    delta: 0,
    percentile: null,
    tags: { zh: [], en: [] },
    roast_line: { zh: "", en: "" },
  };
  const impactRepos = [...(scan.impact_repos ?? [])]
    .sort((a, b) => b.stars - a.stars)
    .slice(0, 6);
  const representativeWorks = rankProfileWorks({
    username: metrics.username,
    topRepos: scan.top_repos,
    impactRepos: scan.impact_repos,
    pinnedRepos: scan.pinned_repos,
    signatureWork: scan.signature_work,
  });
  const organizations = scan.organizations ?? [];

  return (
    <main className="relative isolate flex w-full flex-1 justify-center px-5 py-14 sm:py-20">
      <div className="relative z-10 flex w-full max-w-4xl flex-col">
        <Link href="/leaderboard" className="text-sm text-zinc-400 hover:text-zinc-200">
          {t("back")}
        </Link>

        <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-start">
          {/* Left: identity sidebar */}
          <aside className="flex flex-col gap-4 lg:sticky lg:top-8 lg:w-80 lg:shrink-0">
            <div
              className={`animate-pop flex flex-col items-center rounded-2xl border border-white/10 bg-white/[0.05] p-6 text-center ring-1 ${style.ring}`}
              style={{ boxShadow: `0 0 80px -20px ${style.glow}` }}
            >
              <h1 className="max-w-full">
                <a
                  href={metrics.profile_url ?? `https://github.com/${metrics.username}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`inline-block max-w-full break-all rounded-full bg-black/35 px-4 py-1.5 text-xl font-black leading-tight ${style.text} ring-1 ${style.ring} hover:bg-black/45`}
                  style={{ boxShadow: `0 0 28px -10px ${style.glow}` }}
                >
                  @{metrics.username}
                </a>
              </h1>
              {metrics.name && (
                <div className="mt-2 max-w-full truncate text-sm font-medium text-zinc-300">
                  {metrics.name}
                </div>
              )}
              {metrics.bio && (
                <div className="mt-2 line-clamp-2 max-w-md text-sm text-zinc-400">
                  {metrics.bio}
                </div>
              )}
              <TierAvatarFrame
                username={metrics.username}
                avatarUrl={metrics.avatar_url}
                tier={scoring.tier}
                size="lg"
                className="mt-5"
              />
              <div className={`mt-4 text-6xl font-black tabular-nums ${style.text}`}>
                {scoring.final_score.toFixed(2)}
                <span className="text-2xl text-zinc-600">/100</span>
              </div>
              <div className={`mt-1 text-2xl font-bold ${style.text}`}>
                {style.emoji} {tTier(`${tierKey}.name`)}
              </div>
              <div className="mt-1 text-sm font-medium text-zinc-300">
                {tTier(`${tierKey}.blurb`)}
              </div>

              {organizations.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
                  {organizations.map((org) => (
                    <a
                      key={org}
                      href={`https://github.com/${org}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-full bg-white/5 px-2.5 py-0.5 text-xs text-zinc-300 hover:bg-white/10"
                    >
                      @{org}
                    </a>
                  ))}
                </div>
              )}
            </div>

            {/* Roast-in-progress banner (replaces the rank card until persisted) */}
            <div className="rounded-2xl border border-orange-300/30 bg-orange-500/[0.07] p-4 text-center">
              <div className="flex items-center justify-center gap-2 text-sm font-semibold text-orange-200/90">
                <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-orange-300/40 border-t-orange-200" />
                {t("livePendingBanner")}
              </div>
            </div>
          </aside>

          {/* Right: evidence + live roast */}
          <div className="flex min-w-0 flex-1 flex-col">
            {impactRepos.length > 0 && (
              <section className="mb-6 rounded-2xl border border-amber-300/25 bg-amber-500/[0.05] p-5 sm:p-6">
                <h2 className="mb-1 text-base font-bold text-amber-200">{t("impactHeading")}</h2>
                <p className="mb-4 text-xs text-zinc-400">{t("impactSub")}</p>
                <div className="flex flex-col gap-2">
                  {impactRepos.map((r) => (
                    <a
                      key={r.repo}
                      href={`https://github.com/${r.repo}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 hover:bg-white/[0.06]"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">
                        {r.repo}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                        ⭐ {nf.format(r.stars)}
                        {(r.commits > 0 || r.prs > 0) && (
                          <span className="ms-2 text-zinc-500">
                            {r.commits > 0 && `${nf.format(r.commits)} ${t("commits")}`}
                            {r.commits > 0 && r.prs > 0 && " · "}
                            {r.prs > 0 && `${nf.format(r.prs)} ${t("prs")}`}
                          </span>
                        )}
                      </span>
                    </a>
                  ))}
                </div>
              </section>
            )}

            <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-5 sm:p-6">
              <h2 className="mb-4 text-base font-bold text-zinc-200">{t("dimensionsHeading")}</h2>
              <DimensionStarChart
                scores={scoring.sub_scores}
                labels={dimensionLabels}
                tier={scoring.tier}
              />
            </section>

            {representativeWorks.length > 0 && (
              <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.04] p-5 sm:p-6">
                <h2 className="mb-1 text-base font-bold text-zinc-200">{t("worksHeading")}</h2>
                <p className="mb-4 text-xs text-zinc-400">{t("worksSub")}</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {representativeWorks.map((work) => {
                    const evidence = work.examples?.[0] ?? work.description;
                    return (
                      <a
                        key={work.repo}
                        href={`https://github.com/${work.repo}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex flex-col gap-1 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 hover:bg-white/[0.06]"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">
                            {work.repo}
                          </span>
                          <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                            ⭐ {nf.format(work.stars)}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-zinc-500">
                          {work.prs ? <span>{nf.format(work.prs)} {t("prs")}</span> : null}
                          {work.commits ? <span>{nf.format(work.commits)} {t("commits")}</span> : null}
                          {work.orgContextRepo ? <span>↔ {work.orgContextRepo}</span> : null}
                          {work.language ? <span>{work.language}</span> : null}
                        </div>
                        {evidence && (
                          <p className="line-clamp-2 text-xs text-zinc-400">{evidence}</p>
                        )}
                      </a>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Live roast — streams in place, then refreshes into the full profile */}
            <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.04] p-5 sm:p-7">
              <h2 className="mb-3 text-lg font-bold text-orange-400">{t("roastHeading")}</h2>
              <LiveRoast
                username={metrics.username}
                scan={scan}
                openModalOnMount={fromHome}
                fallbackMeta={fromHome ? scanMeta : undefined}
              />
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
