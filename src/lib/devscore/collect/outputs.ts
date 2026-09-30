/**
 * Phase output contracts shared by the collector's phase modules. Every output is JSON:
 * Python dicts keyed by repo become Record<string, …>, sets become sorted arrays, tuple keys
 * become "repo#number" strings. Names follow collect.py so the port can be checked line by line.
 */
import type { ExtPr } from "../model";

/** Python `defaultdict(lambda: defaultdict(int))`: repo → "YYYY-MM" → count. */
export type RepoMonths = Record<string, Record<string, number>>;

/** `user`: fetch_user. */
export interface UserOut {
  id: string;
  login: string;
  name: string | null;
  followers: number | null;
  contributionYears: number[];
  /** own non-fork repos by push time, then by stars (OWN_REPO_CAP each) */
  pushed: string[];
  starred: string[];
}

/** `contribs`: fetch_monthly_contribs (keys are GitHub names before canonicalisation). */
export interface ContribsOut {
  commits: RepoMonths;
  prs: RepoMonths;
  reviews: RepoMonths;
}

/** One maintainer repo from GH Archive (`fetch_maintainer` + gap fill). */
export interface MaintRaw {
  role: string | null;
  months: Record<string, number>;
  merged_others: number;
}

/** Maintainer event families (collect.py MAINT_TYPES), in that order. */
export type MaintType = "reviews" | "comments" | "merged" | "closes";

/** fetch_maintainer's per-repo entry: MaintRaw plus the per-month events by family (gap fill input). */
export interface MaintEvents extends MaintRaw {
  by_type: Record<string, Record<MaintType, number>>;
}

/** `maintainer`: fetch_maintainer; null when the ClickHouse query failed (unknown, never 0). */
export type MaintainerOut = Record<string, MaintEvents> | null;

/** fill_maint_gaps info (gap_note input): gap months per family, repos checked, filled months per repo. */
export interface GapInfo {
  gaps: Record<MaintType, string[]>;
  checked: number;
  repos: Record<string, string[]>;
}

/** `gap_fill`: maintainer data after fill_maint_gaps, plus the note info (null: ClickHouse failed). */
export interface GapFillOut {
  maint: MaintainerOut;
  info: GapInfo | null;
}

/** A merged PR node of the user's global list (fetch_user_prs MERGED). */
export interface MergedPrNode {
  number: number;
  title: string;
  createdAt: string;
  mergedAt: string | null;
  mergedBy: { login: string; __typename: string } | null;
  repository: { nameWithOwner: string; owner: { login: string } };
}

/** The rejected_by_maintainer window of the PR list: its CLOSED PRs, the external ones' node ids. */
export interface ClosedScan {
  /** CLOSED totalCount */
  total: number;
  /** CLOSED PRs in the window */
  listed: number;
  /** node ids of the window's PRs to repos the user does not own, in list order */
  ext: string[];
  complete: boolean;
}

/**
 * An ext_prs entry as collected: additions/deletions/changed_files are null unless rule A
 * can use them (slopNeedsClosers); parseDeveloper reads null as 0, like the Zig parser.
 */
export type CollectedExtPr = Omit<ExtPr, "additions" | "deletions" | "changed_files"> & {
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
};

/** The fetch_ext_prs window of the PR list: entries without closers, sizes or reviewers, and their node ids. */
export interface ExtScan {
  prs: CollectedExtPr[];
  /** GraphQL node id of prs[i] */
  ids: string[];
  complete: boolean;
}

/**
 * `merged_prs`: one pass over the user's PR list (all states), split into the three windows
 * the per-state scans used to page: the merged list (total/nodes/complete), `closed` for
 * `rejected` and `ext` for `ext_prs`.
 */
export interface MergedPrsOut {
  total: number;
  nodes: MergedPrNode[];
  complete: boolean;
  closed: ClosedScan;
  ext: ExtScan;
}

/** Raw GraphQL repo metadata (REPO_FIELDS) as fetch_repo_meta returns it. */
export type RepoMeta = Record<string, unknown> & {
  nameWithOwner: string;
  stargazerCount: number;
  forkCount: number;
  isFork: boolean;
  isPrivate: boolean;
  owner: { login: string };
};

/**
 * `repo_meta`: candidates resolved to canonical repos, and everything collect() derives from
 * them before the per-repo work: the rekeyed contribution maps, maintainer data on canonical
 * names, repo kinds, PR repos and the list of repos needing per-repo PR search.
 */
export interface RepoMetaOut {
  canon: Record<string, RepoMeta>;
  /** requested name → canonical name */
  alias: Record<string, string>;
  dropped: string[];
  cgCommits: RepoMonths;
  cgPrs: RepoMonths;
  cgReviews: RepoMonths;
  /** maint_all: every GH Archive name folded onto canonical names */
  maintAll: Record<string, MaintRaw>;
  /** maint: verified-role repos (role defaulted to COLLABORATOR) */
  maint: Record<string, MaintRaw>;
  maintSignal: string[];
  kinds: Record<string, string>;
  /** repos searched for per-repo merged-PR samples (top PR_SAMPLE_REPOS by pr_sample_priority) */
  searched: string[];
  mergedExternal: number;
  notes: string[];
}

/** `pr_samples`: repo → {issueCount, nodes} (fetch_repo_pr_samples, or slices of the full list). */
export type PrSamplesOut = Record<string, { issueCount: number; nodes: MergedPrNode[] } | null>;

/** PR detail (fetch_pr_details): key "repo#number". */
export interface PrDetail {
  additions: number;
  deletions: number;
  /** changed file paths (first 100) */
  files: string[];
  substance: number;
}

/** `pr_details`: prs_by_repo (repo → number → node) and the detail sample. */
export interface PrDetailsOut {
  prsByRepo: Record<string, Record<string, MergedPrNode>>;
  details: Record<string, PrDetail>;
}

/** `mutual_mergers`: pr_mergers per repo and the reciprocal-merger lists. */
export interface MutualMergersOut {
  mergers: Record<string, Record<string, number> | null>;
  mutualByRepo: Record<string, string[]>;
}

/** One commit of a GraphQL history (fetch_commit_histories node). */
export interface HistoryNode {
  oid: string;
  date: string | null;
  merge: boolean;
  /** additions + deletions */
  lines: number;
}

/** `histories`: repo → {total, nodes, sizes} for the top HISTORY_REPOS. */
export type HistoriesOut = Record<
  string,
  { total: number; nodes: HistoryNode[]; sizes: { lines: number; merge: boolean; at: string | null }[] } | null
>;

/** `signals`: issue authors per repo and ecosyste.ms dependents. */
export interface SignalsOut {
  signalSet: string[];
  contribSet: string[];
  sampleSet: string[];
  signals: Record<string, { issue_authors?: number | null }>;
  /** repo → [dependent packages, dependent repos]; only the first is emitted */
  dependents: Record<string, [number | null, number | null]>;
}

/** One entry of `per_repo` (collect.py per_repo()). */
export interface PerRepoExtra {
  uc: number | null;
  src: string | null;
  cg: number;
  months: string[];
  owned: boolean;
  rank: number | null;
  ctotal: number | null;
  top: number | null;
  standing: Record<string, number> | null;
  code_months_by_year: Record<string, number>;
  reviews_by_year: Record<string, number>;
  sizes: { lines: number; merge: boolean; at: string | null }[] | null;
  sample: { kind: string; substance: number; lines: number; heat: number | null }[] | null;
}

/** `per_repo`: canonical repo → extra (iterates repos with a saved cursor). */
export type PerRepoOut = Record<string, PerRepoExtra>;

/** `owner_types`: owner login → is organization (null unknown). */
export type OwnerTypesOut = Record<string, boolean | null>;

/** `star_history`: repo → weekly gains, for the star_history_candidates the hype rule can use. */
export interface StarHistoryOut {
  candidates: string[];
  history: Record<string, [string, number][] | null>;
}

/** `rejected`: rejected_by_maintainer → (closed external, scanned, closed by someone else), plus the PR details fetched with it. */
export interface RejectedOut {
  closedExt: number;
  scanned: number;
  byOther: number;
  /** PR node id → last ClosedEvent actor (null: ghost/unknown/unreadable): the window's external PRs, and ext_prs' CLOSED ones when rule A can use them */
  closers: Record<string, string | null>;
  /** PR node id → [additions, deletions, changedFiles] of ext_prs entries, only when rule A can use them */
  sizes: Record<string, [number, number, number]>;
}

/**
 * `ext_prs`: fetch_ext_prs; closed_by and sizes only when slopNeedsClosers, reviewers only on
 * MERGED PRs of unreviewedCandidate repos (null elsewhere).
 */
export interface ExtPrsOut {
  prs: CollectedExtPr[];
  complete: boolean;
}
