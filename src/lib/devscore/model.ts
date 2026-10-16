/**
 * devscore data contract v15 (devscore SPEC.md "Data contract"; mirrors
 * devscore/src/model.zig). The collector writes a `Developer`, the engine reads
 * it. Every field the collector may not know is optional: `null` means "no
 * evidence either way" and is never conflated with 0.
 *
 * `parseDeveloper` applies the same defaults as the Zig parser (a missing
 * `owned` is false, a missing commit `substance` is 0, ...), so the engine
 * sees identical inputs whichever implementation produced or read the file.
 */

export type NumMap = Record<string, number>;

export interface PrKinds {
  core: number | null;
  test: number | null;
  docs: number | null;
  site: number | null;
  chore: number | null;
  /** Branch-sync PRs ("merge master into feature"): other people's code. */
  merge: number | null;
  /** PRs touching only data files (datasets, route files, CSVs). */
  data: number | null;
}

/** Stars gained in one week: ["YYYY-MM-DD" (Sunday week start, UTC), gain]. */
export type StarWeek = [string, number];

export interface CommitSize {
  /** additions + deletions */
  lines: number;
  merge: boolean;
  /** committedDate "YYYY-MM-DDTHH:MM:SSZ"; null: unknown. */
  at: string | null;
}

export interface Commit {
  /** core | test | docs | site | chore | data | merge */
  kind: string;
  /** Changed lines of hand-written product code (capped at 2000). */
  substance: number;
  lines: number;
  /** Share of recent default-branch commits touching the commit's core area. */
  heat: number | null;
}

export interface Repo {
  name: string;
  owned: boolean;
  is_fork: boolean;
  archived: boolean;
  /** code | data | site | docs | profile | list | config | content */
  kind: string | null;
  stars: number | null;
  forks: number | null;
  repo_total_commits: number | null;
  user_commits: number | null;
  user_merged_prs: number | null;
  pr_kinds: PrKinds | null;
  first_contrib_at: string | null;
  last_contrib_at: string | null;
  active_months: number | null;
  user_rank: number | null;
  contributors_total: number | null;
  top_contributor_commits: number | null;
  merger_standing: NumMap | null;
  owner_is_org: boolean | null;
  code_months_by_year: NumMap | null;
  reviews_by_year: NumMap | null;
  pr_substance: number[] | null;
  commit_merge_share: number | null;
  commit_sample: Commit[] | null;
  commit_sizes: CommitSize[] | null;
  pr_mergers: NumMap | null;
  mutual_mergers: string[] | null;
  primary_language: string | null;
  issues_total: number | null;
  prs_total: number | null;
  pr_batch_share: number | null;
  created_at: string | null;
  releases_total: number | null;
  has_ci: boolean | null;
  has_tests: boolean | null;
  review_depth: number | null;
  issue_authors: number | null;
  dependents: number | null;
  maint_role: string | null;
  maint_months_by_year: NumMap | null;
  merged_others: number | null;
  dependent_repos: number | null;
  star_history: StarWeek[] | null;
  last_push_at: string | null;
}

export interface ExtPr {
  repo: string;
  title: string;
  /** MERGED | CLOSED | OPEN */
  state: string;
  created_at: string;
  additions: number;
  deletions: number;
  changed_files: number;
  merged_by: string | null;
  closed_by: string | null;
  /** Human reviewers other than the author; null: not collected. */
  reviewers: string[] | null;
}

export interface Developer {
  login: string;
  collected_at: string | null;
  repos: Repo[];
  prs_rejected_by_maintainer: number | null;
  prs_merged_total: number | null;
  prs_merged_external: number | null;
  followers: number | null;
  ext_prs: ExtPr[] | null;
}

type Json = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const numOr = (v: unknown, d: number): number => num(v) ?? d;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const obj = (v: unknown): Json | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

function numMap(v: unknown): NumMap | null {
  const o = obj(v);
  if (!o) return null;
  const out: NumMap = {};
  for (const [k, x] of Object.entries(o)) {
    const n = num(x);
    if (n !== null) out[k] = n;
  }
  return out;
}

function arr<T>(v: unknown, f: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const x of v) {
    const y = f(x);
    if (y !== null) out.push(y);
  }
  return out;
}

function prKinds(v: unknown): PrKinds | null {
  const o = obj(v);
  if (!o) return null;
  return {
    core: num(o.core), test: num(o.test), docs: num(o.docs), site: num(o.site),
    chore: num(o.chore), merge: num(o.merge), data: num(o.data),
  };
}

function commit(v: unknown): Commit | null {
  const o = obj(v);
  const kind = o && str(o.kind);
  if (!o || kind === null) return null;
  return { kind, substance: numOr(o.substance, 0), lines: numOr(o.lines, 0), heat: num(o.heat) };
}

function commitSize(v: unknown): CommitSize | null {
  const o = obj(v);
  if (!o) return null;
  return { lines: numOr(o.lines, 0), merge: bool(o.merge) ?? false, at: str(o.at) };
}

function starWeek(v: unknown): StarWeek | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const d = str(v[0]);
  const n = num(v[1]);
  return d !== null && n !== null ? [d, n] : null;
}

function repo(v: unknown): Repo | null {
  const o = obj(v);
  const name = o && str(o.name);
  if (!o || name === null) return null;
  return {
    name,
    owned: bool(o.owned) ?? false,
    is_fork: bool(o.is_fork) ?? false,
    archived: bool(o.archived) ?? false,
    kind: str(o.kind),
    stars: num(o.stars),
    forks: num(o.forks),
    repo_total_commits: num(o.repo_total_commits),
    user_commits: num(o.user_commits),
    user_merged_prs: num(o.user_merged_prs),
    pr_kinds: prKinds(o.pr_kinds),
    first_contrib_at: str(o.first_contrib_at),
    last_contrib_at: str(o.last_contrib_at),
    active_months: num(o.active_months),
    user_rank: num(o.user_rank),
    contributors_total: num(o.contributors_total),
    top_contributor_commits: num(o.top_contributor_commits),
    merger_standing: numMap(o.merger_standing),
    owner_is_org: bool(o.owner_is_org),
    code_months_by_year: numMap(o.code_months_by_year),
    reviews_by_year: numMap(o.reviews_by_year),
    pr_substance: arr(o.pr_substance, num),
    commit_merge_share: num(o.commit_merge_share),
    commit_sample: arr(o.commit_sample, commit),
    commit_sizes: arr(o.commit_sizes, commitSize),
    pr_mergers: numMap(o.pr_mergers),
    mutual_mergers: arr(o.mutual_mergers, str),
    primary_language: str(o.primary_language),
    issues_total: num(o.issues_total),
    prs_total: num(o.prs_total),
    pr_batch_share: num(o.pr_batch_share),
    created_at: str(o.created_at),
    releases_total: num(o.releases_total),
    has_ci: bool(o.has_ci),
    has_tests: bool(o.has_tests),
    review_depth: num(o.review_depth),
    issue_authors: num(o.issue_authors),
    dependents: num(o.dependents),
    maint_role: str(o.maint_role),
    maint_months_by_year: numMap(o.maint_months_by_year),
    merged_others: num(o.merged_others),
    dependent_repos: num(o.dependent_repos),
    star_history: arr(o.star_history, starWeek),
    last_push_at: str(o.last_push_at),
  };
}

function extPr(v: unknown): ExtPr | null {
  const o = obj(v);
  const r = o && str(o.repo);
  const state = o && str(o.state);
  const created = o && str(o.created_at);
  if (!o || r === null || state === null || created === null) return null;
  return {
    repo: r,
    title: str(o.title) ?? "",
    state,
    created_at: created,
    additions: numOr(o.additions, 0),
    deletions: numOr(o.deletions, 0),
    changed_files: numOr(o.changed_files, 0),
    merged_by: str(o.merged_by),
    closed_by: str(o.closed_by),
    reviewers: arr(o.reviewers, str),
  };
}

/** Normalizes a parsed JSON value into a `Developer` with the Zig parser's defaults. */
export function parseDeveloper(value: unknown): Developer {
  const o = obj(value);
  const login = o && str(o.login);
  if (!o || login === null) throw new Error("devscore: invalid developer data (login missing)");
  return {
    login,
    collected_at: str(o.collected_at),
    repos: arr(o.repos, repo) ?? [],
    prs_rejected_by_maintainer: num(o.prs_rejected_by_maintainer),
    prs_merged_total: num(o.prs_merged_total),
    prs_merged_external: num(o.prs_merged_external),
    followers: num(o.followers),
    ext_prs: arr(o.ext_prs, extPr),
  };
}

/**
 * ISO-8601 prefix `YYYY-MM-DD` as a fractional year (2011-07-01 → ~2011.5),
 * exactly as devscore's `model.fractionalYear`; null for malformed input.
 */
export function fractionalYear(ts: string | null | undefined): number | null {
  if (!ts || ts.length < 10 || ts[4] !== "-" || ts[7] !== "-") return null;
  const y = Number(ts.slice(0, 4));
  const m = Number(ts.slice(5, 7));
  const d = Number(ts.slice(8, 10));
  if (!/^\d{4}$/.test(ts.slice(0, 4)) || !/^\d{2}$/.test(ts.slice(5, 7)) || !/^\d{2}$/.test(ts.slice(8, 10))) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return y + (m - 1) / 12 + (d - 1) / 365;
}

/** Collection time as a fractional year; missing or malformed: 2026.73. */
export function collectedYear(d: Developer): number {
  return fractionalYear(d.collected_at) ?? 2026.73;
}
