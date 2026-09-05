"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { tierStyle } from "@/lib/tier";
import type { LeaderboardClientEntry, LeaderboardView } from "./LeaderboardClient";
import { LeaderboardRailTabs } from "./LeaderboardRailTabs";
import { withDevLeaderboardPreview } from "./devLeaderboardPreview";

const RAIL_LIMIT = 10;

const RAIL_VIEWS: { view: LeaderboardView; labelKey: "trendView" | "scoreView" | "heatView" }[] = [
  { view: "trending", labelKey: "trendView" },
  { view: "score", labelKey: "scoreView" },
  { view: "heat", labelKey: "heatView" },
];

function railBoardHref(view: LeaderboardView) {
  return view === "trending" ? "/leaderboard" : `/leaderboard?view=${view}`;
}

function RailBoard({
  rows,
  view,
  openLabel,
}: {
  rows: LeaderboardClientEntry[];
  view: LeaderboardView;
  openLabel: string;
}) {
  return (
    <>
      <ol className="mt-3 flex flex-col gap-1">
        {rows.map((entry, i) => {
          const style = tierStyle(entry.tier);
          return (
            <li key={entry.username}>
              <Link
                href={`/u/${entry.username}`}
                prefetch={false}
                className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors hover:bg-white/[0.06]"
              >
                <span className="w-5 shrink-0 text-center text-xs font-bold tabular-nums text-zinc-500">
                  {i + 1}
                </span>
                {entry.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- GitHub avatar; matches LeaderboardClient
                  <img
                    src={entry.avatar_url}
                    alt=""
                    loading="lazy"
                    className="h-8 w-8 shrink-0 rounded-full"
                  />
                ) : (
                  <div className="h-8 w-8 shrink-0 rounded-full bg-white/10" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-200">
                  {entry.display_name || `@${entry.username}`}
                </span>
                <span className={`shrink-0 text-sm font-black tabular-nums ${style.text}`}>
                  {style.emoji} {entry.final_score.toFixed(1)}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
      <Link
        href={railBoardHref(view)}
        prefetch={false}
        className="mt-2 block rounded-xl px-2 py-2 text-center text-xs font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
      >
        {openLabel}
      </Link>
    </>
  );
}

function RailSkeleton() {
  return (
    <ol className="mt-3 flex flex-col gap-1" aria-hidden>
      {Array.from({ length: RAIL_LIMIT }, (_, i) => (
        <li key={i} className="flex animate-pulse items-center gap-2.5 rounded-xl px-2 py-1.5">
          <span className="h-3 w-4 rounded bg-white/5" />
          <span className="h-8 w-8 shrink-0 rounded-full bg-white/5" />
          <span className="h-3 flex-1 rounded bg-white/5" />
          <span className="h-3 w-10 rounded bg-white/5" />
        </li>
      ))}
    </ol>
  );
}

/**
 * Homepage right-rail leaderboard teaser with view tabs (trending/score/heat —
 * the same boards as /leaderboard). The homepage shell is force-static and is
 * built in CI without DB/Redis env, so the boards CANNOT be baked in at build
 * time (that used to render an empty rail that got ISR-cached for everyone).
 * Instead the static shell ships the rail frame + skeleton and the three
 * boards are fetched from /api/leaderboard on mount (CDN-cached, one request
 * per view) — the same pattern as DeveloperCount. Tab switching stays purely
 * local. Each board shows RAIL_LIMIT rows; the interactive board (time
 * windows, pagination, VS) still lives at /leaderboard.
 */
export function LeaderboardRail() {
  const t = useTranslations("home");
  const tBoard = useTranslations("leaderboard");
  const [rowsByView, setRowsByView] = useState<Partial<
    Record<LeaderboardView, LeaderboardClientEntry[]>
  > | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all(
      RAIL_VIEWS.map(async ({ view }): Promise<[LeaderboardView, LeaderboardClientEntry[]]> => {
        try {
          const res = await fetch(
            `/api/leaderboard?view=${view}&window=all&limit=${RAIL_LIMIT}`,
          );
          if (!res.ok) return [view, []];
          const data = (await res.json()) as { entries?: LeaderboardClientEntry[] };
          return [view, withDevLeaderboardPreview(view, data.entries ?? [])];
        } catch {
          return [view, []];
        }
      }),
    ).then((results) => {
      if (!alive) return;
      setRowsByView(
        Object.fromEntries(results) as Partial<
          Record<LeaderboardView, LeaderboardClientEntry[]>
        >,
      );
    });
    return () => {
      alive = false;
    };
  }, []);

  // Loading: ship the rail frame with tab chips and skeleton rows so the
  // static shell reserves the layout slot (no pop-in jump after hydration).
  if (rowsByView === null) {
    return (
      <section className="home-rail">
        <h2 className="px-2 text-sm font-black tracking-wide text-zinc-100">
          {t("boardHeading")}
        </h2>
        <div className="mt-3">
          <LeaderboardRailTabs
            tabs={RAIL_VIEWS.map(({ view, labelKey }) => ({
              key: view,
              label: tBoard(labelKey),
              panel: <RailSkeleton />,
            }))}
          />
        </div>
      </section>
    );
  }

  const tabs = RAIL_VIEWS.map(({ view, labelKey }) => ({
    key: view,
    label: tBoard(labelKey),
    rows: rowsByView[view] ?? [],
  })).filter((board) => board.rows.length > 0);
  if (tabs.length === 0) return null;

  return (
    <section className="home-rail">
      <h2 className="px-2 text-sm font-black tracking-wide text-zinc-100">
        {t("boardHeading")}
      </h2>
      {/* key remounts the tab switcher once real rows arrive, so the active
          tab resets to the first board that actually has data. */}
      <div className="mt-3">
        <LeaderboardRailTabs
          key="loaded"
          tabs={tabs.map((board) => ({
            key: board.key,
            label: board.label,
            panel: <RailBoard rows={board.rows} view={board.key} openLabel={t("openBoard")} />,
          }))}
        />
      </div>
    </section>
  );
}
