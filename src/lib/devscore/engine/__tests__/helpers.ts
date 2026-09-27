import type { Commit, CommitSize, Developer, Repo } from "../../model";

/** A sampled commit with the Zig defaults (substance 0, lines 0, heat null). */
export function commit(kind: string, substance = 0, lines = 0, heat: number | null = null): Commit {
  return { kind, substance, lines, heat };
}

/** A sized commit with the Zig defaults (not a merge, no timestamp). */
export function size(lines: number, merge = false, at: string | null = null): CommitSize {
  return { lines, merge, at };
}

/** A `Repo` with the Zig struct defaults (false / null), overridden by `r`. */
export function repo(r: Partial<Repo> & { name: string }): Repo {
  return {
    owned: false,
    is_fork: false,
    archived: false,
    kind: null,
    stars: null,
    forks: null,
    repo_total_commits: null,
    user_commits: null,
    user_merged_prs: null,
    pr_kinds: null,
    first_contrib_at: null,
    last_contrib_at: null,
    active_months: null,
    user_rank: null,
    contributors_total: null,
    top_contributor_commits: null,
    merger_standing: null,
    owner_is_org: null,
    code_months_by_year: null,
    reviews_by_year: null,
    pr_substance: null,
    commit_merge_share: null,
    commit_sample: null,
    commit_sizes: null,
    pr_mergers: null,
    mutual_mergers: null,
    primary_language: null,
    issues_total: null,
    prs_total: null,
    pr_batch_share: null,
    created_at: null,
    releases_total: null,
    has_ci: null,
    has_tests: null,
    review_depth: null,
    issue_authors: null,
    dependents: null,
    maint_role: null,
    maint_months_by_year: null,
    merged_others: null,
    dependent_repos: null,
    star_history: null,
    last_push_at: null,
    ...r,
  };
}

/** A `Developer` with the Zig struct defaults, overridden by `d`. */
export function dev(d: Partial<Developer> & { login: string }): Developer {
  return {
    collected_at: null,
    repos: [],
    prs_rejected_by_maintainer: null,
    prs_merged_total: null,
    prs_merged_external: null,
    followers: null,
    ext_prs: null,
    ...d,
  };
}

/** Full PR-kind counts from a partial (missing kinds are null, as in Zig). */
export function kinds(k: Partial<NonNullable<Repo["pr_kinds"]>>): NonNullable<Repo["pr_kinds"]> {
  return { core: null, test: null, docs: null, site: null, chore: null, merge: null, data: null, ...k };
}

/** `n` copies of `x`. */
export function times<T>(x: T, n: number): T[] {
  return Array.from({ length: n }, () => x);
}
