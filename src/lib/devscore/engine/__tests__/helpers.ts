import type { Commit, CommitSize, Developer, ExtPr, Repo } from "../../model";

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

/** `n` sampled commits of one kind and size. */
export function sample(n: number, kind = "core", substance = 0, lines = substance): Commit[] {
  return times(commit(kind, substance, lines), n);
}

/** Collection time of every synthetic developer below. */
export const COLLECTED_AT = "2026-09-25T00:00:00Z";

/** An external PR; the defaults are a small merged PR created 60 days before `COLLECTED_AT`. */
export function extPr(x: Partial<ExtPr> & { repo: string }): ExtPr {
  return {
    title: "", state: "MERGED", created_at: "2026-07-27T00:00:00Z", additions: 1, deletions: 0, changed_files: 1,
    merged_by: null, closed_by: null, reviewers: null, ...x,
  };
}

/** A repo with one year-and-a-half of steady activity, so only the fields under test vary. */
function active(r: Partial<Repo> & { name: string }): Repo {
  return repo({
    kind: "code",
    first_contrib_at: "2024-01-01T00:00:00Z",
    last_contrib_at: "2026-08-31T23:59:59Z",
    active_months: 12,
    code_months_by_year: { "2024": 6, "2025": 6 },
    commit_merge_share: 0,
    ...r,
  });
}

/** Developer skeleton: an old account, collected at `COLLECTED_AT`, PR totals given. */
function developer(login: string, repos: Repo[], d: Partial<Developer> = {}): Developer {
  return dev({ login, collected_at: COLLECTED_AT, repos, prs_rejected_by_maintainer: 0, prs_merged_total: 0, prs_merged_external: 0, ...d });
}

/**
 * Synthetic developers, small enough to read. `control` is the honest reference: 160 merged
 * PRs into four large projects, each accepted by an independent maintainer. The others are
 * gamers who look big on the surface (stars, followers, volume) but should stay far below it.
 */
export const synthetic = {
  /** 160 PRs merged by independent maintainers of four 60-contributor projects. */
  control: (login = "control"): Developer =>
    developer(login, [0, 1, 2, 3].map((i) =>
      active({
        name: `org${i}/proj-${i}`, forks: 300, user_commits: 40, user_merged_prs: 40, user_rank: 2, contributors_total: 60,
        top_contributor_commits: 60, commit_sample: sample(12, "core", 200), pr_mergers: { [`maint${i}`]: 40 }, mutual_mergers: [],
      })), { prs_merged_total: 160, prs_merged_external: 160 }),

  /** The same 160 PRs, but the only "maintainers" are a ring of accounts merging each other. */
  ring: (login = "ring"): Developer =>
    developer(login, [0, 1, 2, 3].map((i) =>
      active({
        name: `ringmate/proj-${i}`, forks: 300, user_commits: 40, user_merged_prs: 40, user_rank: 2, contributors_total: 6,
        top_contributor_commits: 60, commit_sample: sample(12, "core", 200), pr_mergers: { ringmate: 40 }, mutual_mergers: ["ringmate"],
      })), { prs_merged_total: 160, prs_merged_external: 160 }),

  /** Reach without engineering: huge content/list repos and one tiny CLI. */
  influencer: (login = "influencer"): Developer =>
    developer(login, [
      active({ name: `${login}/chatgpt-prompts`, owned: true, kind: "content", stars: 60000, forks: 8000, repo_total_commits: 900, user_commits: 400, user_rank: 1, contributors_total: 300, top_contributor_commits: 400 }),
      active({ name: `${login}/awesome-ai-tools`, owned: true, kind: "list", stars: 25000, forks: 3000, user_commits: 300, contributors_total: 200 }),
      active({ name: `${login}/ai-guide`, owned: true, kind: "docs", stars: 9000, forks: 900, user_commits: 150, contributors_total: 20 }),
      active({ name: `${login}/tiny-cli`, owned: true, stars: 4000, forks: 12, repo_total_commits: 15, user_commits: 15, user_rank: 1, contributors_total: 1, top_contributor_commits: 15, commit_sample: sample(12, "core", 40) }),
    ]),

  /** One bought-stars framework nobody forks, with barely-there commits. */
  starFarm: (login = "starfarm"): Developer =>
    developer(login, [
      active({
        name: `${login}/super-framework`, owned: true, stars: 30000, forks: 15, repo_total_commits: 120, user_commits: 120, user_rank: 1,
        contributors_total: 2, top_contributor_commits: 120, commit_sample: sample(12, "core", 150),
        commit_sizes: Array.from({ length: 100 }, (_, i) => size(12, false, `2025-01-01T${String(7 + (i % 3)).padStart(2, "0")}:00:00Z`)),
      }),
    ]),

  /** Five scheduled-bot repos: the same tiny commit 900 times over three years. */
  bot: (login = "bot"): Developer =>
    developer(login, [0, 1, 2, 3, 4].map((i) =>
      active({
        name: `${login}/daily-${i}`, owned: true, stars: 0, forks: 0, repo_total_commits: 900, user_commits: 900, user_rank: 1, contributors_total: 1,
        top_contributor_commits: 900, active_months: 36, code_months_by_year: { "2023": 12, "2024": 12, "2025": 12 }, commit_sample: sample(12, "core", 2),
      }))),

  /** Docs-only PRs into 20 famous projects, merged by bots, with 40 more rejected. */
  prSpam: (login = "prspam"): Developer =>
    developer(login, Array.from({ length: 20 }, (_, i) =>
      active({
        name: `big${i}/famous-${i}`, stars: 50000, forks: 9000, user_commits: 3, user_merged_prs: 3, contributors_total: 800,
        pr_kinds: kinds({ core: 0, test: 0, docs: 3, site: 0, chore: 0, merge: 0 }), pr_substance: [0, 0, 0],
        commit_sample: sample(3, "docs", 0, 2), pr_mergers: { "[bot]": 3 },
      })), { prs_rejected_by_maintainer: 40, prs_merged_total: 60, prs_merged_external: 60 }),

  /**
   * A contributor with a real PR history: one 10-PR stint in a popular project (reviewed,
   * accepted by its maintainer), a small owned tool, and an external PR list with reviewers.
   */
  contributor: (login = "contributor"): Developer =>
    developer(login, [
      active({
        name: "acme/engine", stars: 80000, forks: 11000, repo_total_commits: 3500, user_commits: 10, user_merged_prs: 10, contributors_total: 400,
        pr_kinds: kinds({ core: 9, test: 0, docs: 1, site: 0, chore: 0, merge: 0 }), pr_substance: [420, 300, 90, 40, 30, 20, 12, 10, 8, 4],
        commit_sample: sample(10, "core", 40), pr_mergers: { maintainer: 10 }, mutual_mergers: [], review_depth: 3.5, issue_authors: 23,
        active_months: 2, code_months_by_year: { "2026": 2 }, first_contrib_at: "2026-03-01T00:00:00Z", last_contrib_at: "2026-04-30T23:59:59Z",
      }),
      active({
        name: `${login}/tool`, owned: true, stars: 12, forks: 1, repo_total_commits: 60, user_commits: 55, user_rank: 1, contributors_total: 2,
        top_contributor_commits: 55, commit_sample: sample(12, "core", 60),
      }),
    ], {
      prs_merged_total: 10, prs_merged_external: 10, followers: 4,
      ext_prs: Array.from({ length: 10 }, (_, i) =>
        extPr({ repo: "acme/engine", title: `feat: change ${i}`, created_at: `2026-04-${String(1 + i).padStart(2, "0")}T08:00:00Z`, additions: 200 - 15 * i, deletions: 5, changed_files: 4, merged_by: "maintainer", reviewers: ["maintainer"] })),
    }),
};
