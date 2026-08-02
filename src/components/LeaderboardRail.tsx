import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getLeaderboardCached } from "@/lib/leaderboard";
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

/**
 * Homepage right-rail leaderboard teaser with view tabs (trending/score/heat —
 * the same boards as /leaderboard). All three boards are server-rendered into
 * the force-static shell from the Redis payloads /leaderboard already caches,
 * so tab switching is purely local: no API call, no function invocation, no DB
 * read per click. Each board ships RAIL_LIMIT rows; the interactive board
 * (time windows, pagination, VS) still lives at /leaderboard.
 */
export async function LeaderboardRail() {
  const t = await getTranslations("home");
  const tBoard = await getTranslations("leaderboard");
  const boards = await Promise.all(
    RAIL_VIEWS.map(async ({ view, labelKey }) => {
      const { entries } = await getLeaderboardCached(view);
      const rows = withDevLeaderboardPreview(view, entries.slice(0, RAIL_LIMIT));
      return { view, label: tBoard(labelKey), rows };
    }),
  );
  const tabs = boards
    .filter((board) => board.rows.length > 0)
    .map((board) => ({
      key: board.view,
      label: board.label,
      panel: <RailBoard rows={board.rows} view={board.view} openLabel={t("openBoard")} />,
    }));
  if (tabs.length === 0) return null;

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <h2 className="px-2 text-sm font-black tracking-wide text-zinc-100">
        {t("boardHeading")}
      </h2>
      <div className="mt-3">
        <LeaderboardRailTabs tabs={tabs} />
      </div>
    </section>
  );
}
