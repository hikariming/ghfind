import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Leaderboard } from "@/components/Leaderboard";
import { LeaderboardControls } from "@/components/LeaderboardControls";
import { JsonLd, leaderboardJsonLd } from "@/components/JsonLd";
import { localeAlternates } from "@/lib/site";
import { getLeaderboardCached } from "@/lib/leaderboard";
import {
  LEADERBOARD_WINDOW_OPTIONS,
  type LeaderboardWindow,
} from "@/lib/leaderboardWindow";
import { type LeaderboardView } from "@/components/LeaderboardClient";

const WINDOW_LABEL_KEY: Record<LeaderboardWindow, string> = {
  "24h": "window24h",
  "7d": "window7d",
  "30d": "window30d",
  all: "windowAll",
};

export const dynamic = "force-dynamic";

const REMOVAL_ISSUE_URL =
  "https://github.com/hikariming/github-roast/issues/new?title=%E7%94%B3%E8%AF%B7%E4%B8%8B%E6%A6%9C&body=%E8%AF%B7%E5%A1%AB%E5%86%99%E4%BD%A0%E7%9A%84%20GitHub%20%E7%94%A8%E6%88%B7%E5%90%8D%EF%BC%9A";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "leaderboard" });
  return {
    title: `${t("heading")} · ${(await getTranslations({ locale, namespace: "meta" }))("siteName")}`,
    description: t("subtitle"),
    alternates: localeAlternates(locale, "/leaderboard"),
  };
}

export default async function LeaderboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<{ view?: string; window?: string }>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const view: LeaderboardView =
    query?.view === "score"
      ? "score"
      : query?.view === "heat"
        ? "heat"
        : "trending";
  const timeWindow: LeaderboardWindow =
    query?.window === "24h"
      ? "24h"
      : query?.window === "7d"
        ? "7d"
        : query?.window === "30d"
          ? "30d"
          : "all";
  // Clean URLs: omit the default view/window. Both selectors preserve the other.
  const boardHref = (nextView: LeaderboardView, nextWindow: LeaderboardWindow) => {
    const search = new URLSearchParams();
    if (nextView !== "trending") search.set("view", nextView);
    if (nextWindow !== "all") search.set("window", nextWindow);
    const qs = search.toString();
    return qs ? `/leaderboard?${qs}` : "/leaderboard";
  };
  setRequestLocale(locale);
  const t = await getTranslations("leaderboard");
  const viewTitle =
    view === "score"
      ? t("scoreView")
      : view === "heat"
        ? t("heatView")
        : t("trendView");
  const subtitle =
    view === "score"
      ? t("scoreSubtitle")
      : view === "heat"
        ? t("heatSubtitle")
        : t("trendSubtitle");
  const viewItems = (["trending", "score", "heat"] as const).map((tab) => ({
    key: tab,
    label: tab === "trending" ? t("trendView") : tab === "score" ? t("scoreView") : t("heatView"),
    active: view === tab,
    href: boardHref(tab, timeWindow),
  }));
  const windowItems = LEADERBOARD_WINDOW_OPTIONS.map((w) => ({
    key: w,
    label: t(WINDOW_LABEL_KEY[w]),
    active: timeWindow === w,
    href: boardHref(view, w),
  }));

  // Structured data only for the canonical score ranking — the directory's main
  // "top developers" list. Heat is a sort variant behind query params, so
  // emitting one ItemList keeps the markup unambiguous for crawlers.
  // Shares the Redis cache key with <Leaderboard> below (same score+window), so
  // this JSON-LD read is a cache hit, not a second DB query.
  const rankingEntries =
    view === "score"
      ? (await getLeaderboardCached("score", timeWindow)).entries.slice(0, 50)
      : [];

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-5 py-14 sm:py-20">
      {rankingEntries.length > 0 && (
        <JsonLd
          data={leaderboardJsonLd({
            name: t("heading"),
            description: t("subtitle"),
            locale,
            entries: rankingEntries,
          })}
        />
      )}
      <header className="mb-8">
        <div className="flex flex-col items-start gap-5">
          <div className="min-w-0">
            <h1 className="text-3xl font-black leading-tight tracking-tight text-zinc-100 sm:text-5xl">
              {t("heading")}
            </h1>
            <p className="mt-2 text-lg font-black text-zinc-300 sm:text-xl">{viewTitle}</p>
          </div>
        </div>
        <LeaderboardControls
          className="mt-5"
          viewItems={viewItems}
          windowItems={windowItems}
          windowAriaLabel={t("windowAria")}
        />
        <p className="mt-2 text-zinc-400">{subtitle}</p>
      </header>

      <Leaderboard pageSize={20} initialView={view} timeWindow={timeWindow} />

      <footer className="mt-12 text-center text-xs leading-relaxed text-zinc-600">
        {t.rich("footerNote", {
          a: (c) => (
            <a
              href={REMOVAL_ISSUE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 underline underline-offset-2 hover:text-zinc-200"
            >
              {c}
            </a>
          ),
        })}
      </footer>
    </main>
  );
}
