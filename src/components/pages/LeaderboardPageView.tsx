import { JsonLd, leaderboardJsonLd } from "@/components/JsonLd";
import { DiscoveryNextSteps } from "@/components/DiscoveryNextSteps";
import {
  LeaderboardClient,
  type LeaderboardClientEntry,
  type LeaderboardLabels,
  type LeaderboardView,
} from "@/components/LeaderboardClient";
import { LeaderboardControls } from "@/components/LeaderboardControls";
import { withDevLeaderboardPreview } from "@/components/devLeaderboardPreview";
import type { getGoLeaderboard } from "@/lib/go-leaderboard.server";
import { LEADERBOARD_WINDOW_OPTIONS, type LeaderboardWindow } from "@/lib/leaderboardWindow";
import type { Translator } from "@/lib/translator";

const WINDOW_LABEL_KEY: Record<LeaderboardWindow, string> = {
  "24h": "window24h",
  "7d": "window7d",
  "30d": "window30d",
  all: "windowAll",
};

export function leaderboardLabels(t: Translator): LeaderboardLabels {
  return {
    empty: t("empty"),
    prev: t("prev"),
    next: t("next"),
    pageJumpLabel: t("pageJumpLabel"),
    collapse: t("collapse"),
    viewDetail: t("viewDetail", { username: "{username}" }),
    trendLabel: t("trendLabel"),
    trendTitle: t("trendTitle"),
    scoreLabel: t("scoreLabel"),
    scoreTitle: t("scoreTitle"),
    heatLabel: t("heatLabel"),
    heatTitle: t("heatTitle"),
    vsButton: t("vsButton"),
  };}

/** Body of the /leaderboard page, shared by the Next app and apps/web (see BlogViews). */
export function LeaderboardPageView({
  locale,
  t,
  view,
  timeWindow,
  entries,
  rankingEntries,
}: {
  locale: string;
  /** "leaderboard" namespace. */
  t: Translator;
  view: LeaderboardView;
  timeWindow: LeaderboardWindow;
  entries: LeaderboardClientEntry[];
  rankingEntries: Awaited<ReturnType<typeof getGoLeaderboard>>;
}) {
  // Clean URLs: omit the default view/window. Both selectors preserve the other.
  const boardHref = (nextView: LeaderboardView, nextWindow: LeaderboardWindow) => {
    const search = new URLSearchParams();
    if (nextView !== "trending") search.set("view", nextView);
    if (nextWindow !== "all") search.set("window", nextWindow);
    const qs = search.toString();
    return qs ? `/leaderboard?${qs}` : "/leaderboard";
  };
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

      <LeaderboardClient
        key={`${view}:${timeWindow}`}
        initialView={view}
        labels={leaderboardLabels(t)}
        pageSize={20}
        timeWindow={timeWindow}
        scoreEntries={withDevLeaderboardPreview("score", view === "score" ? entries : [])}
        heatEntries={withDevLeaderboardPreview("heat", view === "heat" ? entries : [])}
        trendingEntries={withDevLeaderboardPreview("trending", view === "trending" ? entries : [])}
      />

      <DiscoveryNextSteps />

      <footer className="mt-12 text-center text-xs leading-relaxed text-zinc-600">
        {t("footerNote")}
      </footer>
    </main>
  );
}
