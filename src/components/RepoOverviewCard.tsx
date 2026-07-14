import { Link } from "@/i18n/navigation";
import { tierStyle } from "@/lib/tier";
import type { Tier } from "@/lib/types";
import type { RepoOverview } from "@/lib/db";

export interface RepoOverviewLabels {
  /** "Maintained by" / "作者" prefix for the author row. */
  authoredBy: string;
  /** "contributors on the board" summary noun. */
  contributors: string;
  /** "avg score" label. */
  avgScore: string;
  /** Localized tier display names, keyed by canonical tier. */
  tierLabels: Record<Tier, string>;
}

const nf = new Intl.NumberFormat("en-US");

/**
 * The project page header: repo identity + description + stats, the owner as a
 * scored account (when scanned), and the contributor-quality summary — the
 * "who works on this, and how good are they" read that differentiates a project
 * page here from GitHub's star count. Pure/presentational; rendered only when
 * {@link getRepoOverview} found the repo in the graph.
 */
export function RepoOverviewCard({
  overview,
  labels,
}: {
  overview: RepoOverview;
  labels: RepoOverviewLabels;
}) {
  const { repo, owner, summary } = overview;

  return (
    <section className="mb-8 rounded-2xl border border-white/10 bg-white/[0.04] p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <a
          href={`https://github.com/${repo.name_with_owner}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-lg font-bold text-zinc-100 underline-offset-2 hover:text-white hover:underline sm:text-xl"
        >
          {repo.name_with_owner}
        </a>
        <span className="shrink-0 text-sm tabular-nums text-zinc-400">
          ⭐ {nf.format(repo.stars)}
          {repo.language && <span className="ms-3 text-zinc-500">{repo.language}</span>}
        </span>
      </div>

      {repo.description && (
        <p className="mt-2 line-clamp-2 text-sm text-zinc-400">{repo.description}</p>
      )}

      {repo.topics.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {repo.topics.slice(0, 8).map((topic) => (
            <span
              key={topic}
              className="rounded-full border border-emerald-400/30 bg-emerald-500/12 px-2.5 py-1 text-xs font-semibold text-emerald-200/90"
            >
              {topic}
            </span>
          ))}
        </div>
      )}

      {/* Author row — the owner as a scored developer, linking back into /u. */}
      {owner && (
        <div className="mt-4 flex items-center gap-2 border-t border-white/10 pt-4">
          <span className="text-xs text-zinc-500">{labels.authoredBy}</span>
          <Link
            href={`/u/${owner.username}`}
            className="group flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] py-1 ps-1 pe-3 hover:bg-white/[0.07]"
          >
            {owner.avatar_url && (
              // eslint-disable-next-line @next/next/no-img-element -- avatar thumbnail, no LCP concern in a secondary row
              <img
                src={owner.avatar_url}
                alt=""
                width={24}
                height={24}
                className="h-6 w-6 rounded-full"
              />
            )}
            <span className="text-sm font-medium text-zinc-200 group-hover:text-white">
              {owner.display_name || owner.username}
            </span>
            <span className={`text-xs font-semibold ${tierStyle(owner.tier).text}`}>
              {tierStyle(owner.tier).emoji} {labels.tierLabels[owner.tier]}
            </span>
          </Link>
        </div>
      )}

      {/* Contributor-quality summary — the differentiated read. */}
      {summary.count > 0 && (
        <div className="mt-4 border-t border-white/10 pt-4">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            <span className="text-zinc-300">
              <span className="font-bold tabular-nums text-zinc-100">{summary.count}</span>{" "}
              <span className="text-zinc-400">{labels.contributors}</span>
            </span>
            <span className="text-zinc-300">
              <span className="text-zinc-400">{labels.avgScore}</span>{" "}
              <span className="font-bold tabular-nums text-zinc-100">{summary.avgScore}</span>
            </span>
          </div>
          <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-white/5">
            {summary.tierCounts.map(({ tier, count }) => (
              <div
                key={tier}
                className={tierBarClass(tier)}
                style={{ width: `${(count / summary.count) * 100}%` }}
                title={`${labels.tierLabels[tier]} · ${count}`}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
            {summary.tierCounts.map(({ tier, count }) => (
              <span key={tier} className={tierStyle(tier).text}>
                {tierStyle(tier).emoji} {labels.tierLabels[tier]} {count}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** Distribution-bar segment fill per tier — muted variants that read against the
 *  track background without importing the full tier glow. */
function tierBarClass(tier: Tier): string {
  const map: Record<Tier, string> = {
    夯: "bg-amber-400/80",
    顶级: "bg-violet-400/80",
    人上人: "bg-emerald-400/80",
    NPC: "bg-slate-400/70",
    拉完了: "bg-rose-500/80",
  };
  return map[tier] ?? "bg-slate-400/70";
}
