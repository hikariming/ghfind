import type { GithubStanding } from "@/lib/github-standing";
import { formatApproxCount, formatBeatPercent, formatTopPercent } from "@/lib/github-population";

export interface GithubStandingLabels {
  title: string;
  /** Metric display names keyed by standing metric. */
  metrics: Record<GithubStanding["metric"], string>;
  /** "#{rank} of {total}" — counted rank. */
  rank: (rank: string, total: string) => string;
  /** "~#{rank} of {total}" — rank interpolated from the population table. */
  rankApprox: (rank: string, total: string) => string;
  /** "Top {pct}% of repos with ≥{floor}★". */
  topAmong: (pct: string, floor: string) => string;
  /** "Older than {pct}%" — account age reads better as a share beaten. */
  older: (pct: string) => string;
  /** Account age value, e.g. "9.1 yrs". */
  years: (years: string) => string;
  /** Footnote: data source and snapshot date. */
  footnote: (asOf: string) => string;
  /** Co-built repository with its credited share, as on the works list. */
  coBuilt: (share: string) => string;
}

const BOXED = "mt-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-start";

/**
 * "Where this account sits among all of GitHub": the rank of the user's
 * most-starred repository and the account's age. Pure/presentational: rows
 * come from {@link import("@/lib/github-standing").githubStandings}, which
 * reads an offline population snapshot — it is not the ghfind score percentile.
 */
export function GithubStandingCard({
  standings,
  labels,
  locale,
  className = BOXED,
}: {
  standings: GithubStanding[];
  labels: GithubStandingLabels;
  locale: string;
  /** Surface classes; defaults to a boxed card (campaign profiles pass their flat style). */
  className?: string;
}) {
  if (standings.length === 0) return null;
  const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  const whole = new Intl.NumberFormat(locale);
  const oneDecimal = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const share = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  // Non-breaking hyphens keep the snapshot date on one line when the footnote wraps.
  const asOf = standings.map((s) => s.as_of).toSorted()[0].replaceAll("-", "\u2011");

  return (
    <section className={className}>
      <h2 className="text-xs font-semibold tracking-wide text-zinc-400">{labels.title}</h2>
      <ul className="mt-2 space-y-2">
        {standings.map((s) => {
          const repo = s.rank != null;
          const total = formatApproxCount(s.population_size, locale);
          const verdict = repo
            ? s.rank_exact
              ? labels.rank(whole.format(s.rank!), total)
              : labels.rankApprox(formatApproxCount(s.rank!, locale), total)
            : `${s.exact ? "" : "≈ "}${labels.older(formatBeatPercent(s.below_share, locale))}`;
          const coShare = s.repo?.attribution_share;
          // Bars on a log scale: rank #1 of 363M is full, the median repository empty.
          const fill = repo
            ? Math.max(4, (1 - Math.log10(s.rank!) / Math.log10(s.population_size)) * 100)
            : s.below_share * 100;
          return (
            <li key={s.metric} className="text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-zinc-300">
                  {labels.metrics[s.metric]}
                  <span className="ms-1.5 tabular-nums text-zinc-500">
                    {repo ? compact.format(s.value) : labels.years(oneDecimal.format((s.age_days_now ?? s.value) / 365.25))}
                  </span>
                </span>
                <span className="shrink-0 font-semibold tabular-nums text-zinc-100">{verdict}</span>
              </div>
              {repo && (
                <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[11px] text-zinc-500">
                  <span className="min-w-0 truncate text-zinc-400" title={s.repo?.name_with_owner}>
                    {s.repo?.name_with_owner}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {s.exact ? "" : "≈ "}
                    {labels.topAmong(formatTopPercent(s.top_share, locale), String(s.comparison_floor))}
                  </span>
                </div>
              )}
              {coShare !== undefined && (
                <div className="mt-0.5 text-[11px] text-zinc-500">
                  {labels.coBuilt(coShare > 0 && coShare < 0.001 ? "<0.1" : share.format(Math.round(coShare * 1000) / 10))}
                </div>
              )}
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-orange-400/70" style={{ width: `${fill}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11px] leading-snug text-zinc-500">{labels.footnote(asOf)}</p>
    </section>
  );
}
