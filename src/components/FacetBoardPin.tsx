"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { normalizeUsername } from "@/lib/username";
import { trackEvent } from "@/lib/track";

/**
 * Client-side resolver for the `?u=` pin. The board page is ISR-cached (the
 * canonical URL never carries the param), so the query string can only be read
 * here, after hydration — reading it on the server would force every crawler
 * hit of a clean URL through a function invocation. Off-board or garbage
 * handles render nothing, same as the old server-side behavior.
 * Must sit under a <Suspense> boundary (useSearchParams in a static page).
 */
export function FacetBoardPinFromQuery({
  usernames,
  facetValue,
}: {
  /** Board order, rank 1 first — same array the leaderboard renders from. */
  usernames: string[];
  facetValue: string;
}) {
  const fromUser = normalizeUsername(useSearchParams().get("u") ?? "");
  if (!fromUser) return null;
  const idx = usernames.findIndex(
    (u) => u.toLowerCase() === fromUser.toLowerCase(),
  );
  if (idx < 0) return null;
  return (
    <FacetBoardPin
      username={usernames[idx]}
      rank={idx + 1}
      ahead={idx > 0 ? usernames[idx - 1] : null}
      facetValue={facetValue}
    />
  );
}

/**
 * The landing half of the facet-rank loop: a visitor arrives on a directory
 * board from a profile's "#12 on Rust" link (`?u=<handle>`), and this pinned bar
 * shows where that dev sits and offers a one-click duel against the dev one spot
 * above — turning the strongest transit CTA (facet_rank_click) straight into the
 * strongest loop (/vs). Rendered only when the handle is actually on the board.
 */
export function FacetBoardPin({
  username,
  rank,
  ahead,
  facetValue,
}: {
  username: string;
  rank: number;
  /** The dev immediately above on this board — null when `username` is #1. */
  ahead: string | null;
  facetValue: string;
}) {
  const t = useTranslations("developers");
  // Canonical pair order (lowercase + dictionary sort) matches the /vs page's
  // own redirect, so the click never eats a server 301.
  const [x, y] = ahead ? [username.toLowerCase(), ahead.toLowerCase()].sort() : ["", ""];
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-orange-500/25 bg-orange-500/[0.06] px-4 py-3">
      <p className="text-sm text-zinc-200">
        {t.rich("pinRankLine", {
          username,
          rank,
          strong: (chunks) => (
            <span className="font-semibold text-orange-200">{chunks}</span>
          ),
        })}
      </p>
      {ahead ? (
        <Link
          href={`/vs/${x}/${y}`}
          prefetch={false}
          onClick={() =>
            trackEvent("facet_board_vs_click", {
              facet: facetValue,
              rank,
              opponent: ahead.toLowerCase(),
            })
          }
          className="inline-flex items-center gap-1.5 rounded-full bg-orange-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-orange-500"
        >
          <span aria-hidden>⚔️</span>
          {t("pinChallenge", { username: ahead })}
        </Link>
      ) : (
        <span className="text-sm font-semibold text-orange-200">
          {t("pinTop")}
        </span>
      )}
    </div>
  );
}
