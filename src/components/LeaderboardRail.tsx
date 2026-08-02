import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getLeaderboardCached } from "@/lib/leaderboard";
import { tierStyle } from "@/lib/tier";
import { withDevLeaderboardPreview } from "./devLeaderboardPreview";

const RAIL_LIMIT = 10;

/**
 * Homepage right-rail leaderboard teaser: top trending accounts as plain
 * server-rendered rows, zero client JS. The interactive board (view/window
 * tabs, pagination, VS) lives at /leaderboard — this rail only has to make
 * people click through, so it ships 10 entries instead of the 3×50 the old
 * homepage preview serialized into the RSC payload.
 */
export async function LeaderboardRail() {
  const t = await getTranslations("home");
  const { entries } = await getLeaderboardCached("trending");
  const rows = withDevLeaderboardPreview("trending", entries.slice(0, RAIL_LIMIT));
  if (rows.length === 0) return null;

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <h2 className="px-2 text-sm font-black tracking-wide text-zinc-100">
        {t("boardHeading")}
      </h2>
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
                <span
                  className={`shrink-0 text-sm font-black tabular-nums ${style.text}`}
                >
                  {style.emoji} {entry.final_score.toFixed(1)}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
      <Link
        href="/leaderboard"
        prefetch={false}
        className="mt-2 block rounded-xl px-2 py-2 text-center text-xs font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
      >
        {t("openBoard")}
      </Link>
    </section>
  );
}
