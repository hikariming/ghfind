import { isPresentationPath } from "./presentation-concentration";

/** Public evidence only. Missing evidence contributes zero, never an inferred role. */
export interface CoCreatorFacts {
  user_commits: number;
  total_commits: number;
  leading_commits: number;
  user_merged_prs: number;
  total_merged_prs: number;
  active_years: number;
  core_churn: number;
  sampled_churn: number;
  substantive_samples: number;
  samples: number;
  association?: string;
  first_author?: boolean;
  release_author?: boolean;
  maintainer_file?: boolean;
  pinned?: boolean;
  inflation_severity?: number;
  /** Default-branch commits / merged PRs inside the trailing
   * {@link RECENT_MAINTENANCE_DAYS} window (bots excluded where known).
   * Absent on older snapshots: maintenance evidence is then neutral. */
  recent_user_commits?: number;
  recent_total_commits?: number;
  recent_user_merged_prs?: number;
  recent_total_merged_prs?: number;
  /** Other people's PRs this user reviewed (issue/PR handling evidence). */
  reviewed_prs?: number;
}

export const RECENT_MAINTENANCE_DAYS = 180;
/** Proxy for typical core churn per repository commit: lets a handful of large
 * core PRs count as a bounded major contribution relative to repository size. */
export const CONTENT_CHURN_PER_COMMIT = 100;
export const CONTENT_ROLE_MAX = 0.35;
/** Roles below this fade smoothly to zero: incidental PRs into large repos
 * belong to ecosystem impact, not to lead/major project credit. */
export const ROLE_FADE = 0.2;
/** Star-farm discount: near-zero forks and outside PRs against many stars. */
export const INFLATION_STRENGTH = 5;
/** Small credited shares fade smoothly toward zero (≈x³ near 0): incidental
 * work on a very large repository must not convert into hundreds of credited
 * stars. Shares above this are unchanged, so there is no cliff. */
export const SHARE_FADE = 0.15;
/** Balanced add/delete rewrites (formatting, renames, moves) keep a small weight
 * and never make a sample substantive on their own. */
export const REWRITE_WEIGHT = 0.1;

export const unit = (x: number) => Math.max(0, Math.min(1, x));
export function smoothUnit(x: number): number { x = unit(x); return x*x*(3-2*x); }
const nz = (x: number | undefined) => Math.max(0, x ?? 0);

/** Lifetime dominance: commit share, rank against the leader, merged-PR share. */
export function lifetimeDominance(f: CoCreatorFacts): number {
  const commitShare = unit(f.user_commits / Math.max(1, f.total_commits));
  const rank = unit(f.user_commits / Math.max(1, f.leading_commits));
  const prShare = unit(f.user_merged_prs / Math.max(1, f.total_merged_prs));
  return .5 * Math.sqrt(commitShare) + .2 * rank + .3 * Math.sqrt(prShare);
}

/** Current-maintainer dominance over the recent window. A person who runs the
 * project today (most recent commits/merged PRs, reviews) can lead it even with
 * a lower lifetime share. Confidence grows smoothly with recent volume. */
export function maintenanceDominance(f: CoCreatorFacts): number {
  const rtc = nz(f.recent_total_commits), rtp = nz(f.recent_total_merged_prs);
  if (rtc <= 0 && rtp <= 0) return 0;
  const rc = unit(nz(f.recent_user_commits) / Math.max(1, rtc));
  const rp = unit(nz(f.recent_user_merged_prs) / Math.max(1, rtp));
  const base = rtc > 0 && rtp > 0 ? .6 * Math.sqrt(rc) + .4 * Math.sqrt(rp)
    : rtc > 0 ? Math.sqrt(rc) : Math.sqrt(rp);
  const review = nz(f.reviewed_prs) / (nz(f.reviewed_prs) + 20);
  const volume = smoothUnit(Math.log1p(nz(f.recent_user_commits) + 3 * nz(f.recent_user_merged_prs)) / Math.log(61));
  return unit(base + .1 * review) * volume;
}

/** Content-weighted contribution: sampled core churn relative to repository
 * size. Few commits with large core PRs earn a bounded major-contribution role. */
export function contentRole(f: CoCreatorFacts): number {
  const churn = nz(f.core_churn);
  return Math.min(CONTENT_ROLE_MAX, churn / (churn + CONTENT_CHURN_PER_COMMIT * Math.max(1, f.total_commits))) *
    smoothUnit(nz(f.substantive_samples) / 3);
}

/** Count alone cannot establish leadership: meaningful implementation is required.
 * Role = strongest of lifetime dominance, current maintenance, and content weight;
 * identity/tenure/confidence are bounded modifiers rather than multiplicative cliffs. */
export function coCreatorShare(f: CoCreatorFacts): number {
  const substance = (1-Math.exp(-nz(f.core_churn)/200)) * smoothUnit(nz(f.substantive_samples)/3);
  const inflation = Math.exp(-INFLATION_STRENGTH*unit(f.inflation_severity ?? 0));
  // Founding authorship is a distinct provenance fact. Recent documentation
  // does not revoke it; meaningful code and sustained work still gate credit.
  if (f.first_author) return substance * smoothUnit(
    Math.log1p(nz(f.user_commits)+3*nz(f.user_merged_prs))/Math.log(101),
  ) * inflation;
  const rawRole = Math.max(lifetimeDominance(f), maintenanceDominance(f), contentRole(f));
  const role = rawRole * smoothUnit(rawRole / ROLE_FADE);
  const association = /^(OWNER|MEMBER|COLLABORATOR)$/.test(f.association ?? "") ? 1 : 0;
  const identity = Math.min(1, .7 + .1*association + .1*Number(Boolean(f.release_author))
    + .1*Number(Boolean(f.maintainer_file)) + .05*Number(Boolean(f.pinned)));
  const counted = nz(f.user_commits) + 3*nz(f.user_merged_prs);
  const work = Math.max(1 - Math.exp(-Math.log1p(counted)/2),
    (1 - Math.exp(-nz(f.core_churn)/2000)) * smoothUnit(counted));
  const tenure = .85 + .15*(1-Math.exp(-nz(f.active_years)/2));
  const confidence = .6 + .4*nz(f.samples)/(nz(f.samples)+2);
  const share = unit(role*identity*work*tenure*substance*confidence*inflation);
  return share * smoothUnit(share / SHARE_FADE);
}

/** Legacy attributed snapshots retain their historical full-share interpretation. */
export function projectShare(repo: { attribution_share?: number }): number {
  return unit(repo.attribution_share ?? 1);
}

/** Eight candidates maximum, with a smooth total-share budget below two projects. */
export function budgetCoCreatorShares<T extends { attribution_share?: number; co_creator_facts?: CoCreatorFacts }>(repos: T[]): T[] {
  const total = repos.reduce((sum, repo) => sum + (repo.co_creator_facts?.first_author ? 0 : projectShare(repo)), 0);
  const multiplier = total > 0 ? 2*Math.tanh(total/2)/total : 1;
  return repos.map(repo => ({...repo, attribution_share: projectShare(repo)*(repo.co_creator_facts?.first_author ? 1 : multiplier)}));
}

const CORE_SOURCE = /\.(c|cc|cpp|cs|go|java|js|jsx|mjs|cjs|kt|php|py|rb|rs|scala|swift|ts|tsx|vue|svelte|css|scss)$/;
/** Vendored, generated and build-output paths never count as authored core code. */
const GENERATED_PATH = /(^|\/)(vendor|vendored|third[_-]?party|node_modules|dist|build|out|generated|__generated__|gen)\/|\.(min\.js|pb\.go|pb\.gw\.go|pb\.ts|g\.dart|freezed\.dart|generated\.\w+)$|_pb2(_grpc)?\.py$|\.d\.ts$/;
/** Per-file churn cap: one huge file cannot carry a contribution on its own. */
export const CORE_FILE_CHURN_CAP = 1500;

export interface FileChurn { path: string; additions: number; deletions: number }

/** Content-weighted core churn for one PR/commit. Lockfiles/config are excluded
 * by extension, vendored/generated paths by location, presentation paths as
 * elsewhere; balanced add/delete rewrites (mass formatting, renames, moves)
 * count at a quarter weight. */
export function weightedCoreChurn(files: FileChurn[], repo: string): { core: number; total: number; fresh: number } {
  let core = 0, total = 0, fresh = 0;
  for (const file of files) {
    const a = Math.max(0, file.additions), d = Math.max(0, file.deletions), churn = a + d;
    total += churn;
    if (!CORE_SOURCE.test(file.path) || GENERATED_PATH.test(file.path) || isPresentationPath(file.path, repo)) continue;
    const rewrite = a >= 20 && d >= 20 && Math.abs(a - d) / churn < 0.1;
    const capped = Math.min(CORE_FILE_CHURN_CAP, churn);
    core += capped * (rewrite ? REWRITE_WEIGHT : 1);
    if (!rewrite) fresh += capped;
  }
  return { core, total, fresh };
}

export function isBotLogin(login: string | null | undefined, type?: string | null): boolean {
  return type === "Bot" || /\[bot\]$|-bot$|^(dependabot|renovate|github-actions|copilot-swe-agent)/i.test(login ?? "");
}

export interface ContributorRow { login?: string; contributions?: number; type?: string }

/** Contributor totals with bots excluded from denominator and leader. When the
 * paged list is truncated, the default-branch history total (minus seen bot
 * commits) is the denominator and the user's own graph count is the fallback. */
export function summarizeContributors(rows: ContributorRow[], login: string, opts: {
  truncated: boolean; historyTotal: number; fallbackUserCommits: number;
}): { user_commits: number; total_commits: number; leading_commits: number } {
  const lower = login.toLowerCase();
  let human = 0, bots = 0, leading = 0, user: number | undefined;
  for (const row of rows) {
    const n = Math.max(0, row.contributions ?? 0);
    if (isBotLogin(row.login, row.type)) { bots += n; continue; }
    human += n; leading = Math.max(leading, n);
    if (row.login?.toLowerCase() === lower) user = (user ?? 0) + n;
  }
  const history = Math.max(0, opts.historyTotal - bots);
  const userCommits = user ?? (opts.truncated || rows.length === 0 ? Math.max(0, opts.fallbackUserCommits) : 0);
  const total = opts.truncated || human === 0 ? Math.max(human, history) : human;
  return { user_commits: userCommits, total_commits: Math.max(total, userCommits), leading_commits: Math.max(leading, userCommits) };
}
