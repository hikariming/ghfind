/**
 * The collector fetches closed_by, reviewers and star_history only where the engine can use
 * them (slopNeedsClosers, unreviewedCandidate, hypeNeedsStarHistory). Blanking everything the
 * gates leave out must leave rateDeveloper unchanged.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fractionalYear, parseDeveloper, type Developer, type ExtPr, type StarWeek } from "../../model";
import { eqlIgnoreCase } from "../ascii";
import { rateDeveloper } from "../index";
import { hypeNeedsStarHistory, isHype, defaultParams as p, unreviewedCandidate } from "../score";
import { defaultParams as sp, slopNeedsClosers } from "../slop";
import { dev, repo } from "./helpers";

const fixtures = join(import.meta.dirname, "fixtures");
const files = ["real", "adversarial"].flatMap((dir) =>
  readdirSync(join(fixtures, dir))
    .filter((f) => f !== "expected.json")
    .map((f) => join(fixtures, dir, f)),
);

/** What the gated collector emits for `d`: closers, reviewers and star histories nulled where gated out. */
function gated(d: Developer): Developer {
  const now = d.collected_at !== null ? fractionalYear(d.collected_at) : null;
  const prs = d.ext_prs;
  const h1 = prs === null ? [] : d.repos.filter((r) => unreviewedCandidate(r, prs)).map((r) => r.name);
  const needClosers = prs !== null && slopNeedsClosers(prs);
  return {
    ...d,
    repos: d.repos.map((r) => (hypeNeedsStarHistory(r, now) ? r : { ...r, star_history: null })),
    ext_prs:
      prs?.map((x) => ({
        ...x,
        closed_by: needClosers ? x.closed_by : null,
        reviewers: x.state === "MERGED" && h1.some((n) => eqlIgnoreCase(n, x.repo)) ? x.reviewers : null,
      })) ?? null,
  };
}

const spike: StarWeek[] = [["2026-01-04", 40], ["2026-01-11", 5000], ["2026-01-18", 3000], ["2026-06-07", 30]];

/** A fully collected variant: a spiky star history on every repo, closers on CLOSED and empty reviewers on every PR. */
function enriched(d: Developer): Developer {
  return {
    ...d,
    repos: d.repos.map((r) => ({ ...r, star_history: spike })),
    ext_prs: d.ext_prs?.map((x) => ({ ...x, closed_by: x.state === "CLOSED" ? "maint" : null, reviewers: [] })) ?? null,
  };
}

/**
 * `enriched` plus evidence each gate decides on: an owned repo only F4's spike makes hype, a
 * young org repo with unreviewed self-merges (H1), and rej_min oversized "Fixes #N" PRs the
 * author closed himself, each followed by a merged PR in that repo (a superseded draft, not a
 * rejection, only when the closer is known).
 */
function stressed(d: Developer): Developer {
  const e = enriched(d);
  const at = Date.parse(d.collected_at ?? "2026-09-25T00:00:00Z");
  const ago = (days: number) => new Date(at - days * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const pr = (x: Partial<ExtPr>): ExtPr => ({
    repo: "", title: "", state: "MERGED", created_at: ago(60), additions: 1, deletions: 0, changed_files: 1,
    merged_by: null, closed_by: null, reviewers: [], ...x,
  });
  return {
    ...e,
    repos: [
      ...e.repos,
      repo({
        name: `${d.login}/viral`, owned: true, kind: "code", stars: 8070, forks: 900, contributors_total: 3, dependents: 0,
        active_months: 2, user_commits: 40, repo_total_commits: 40, last_push_at: ago(60), last_contrib_at: ago(60), star_history: spike,
      }),
      repo({
        name: "corp/young", kind: "code", owner_is_org: true, contributors_total: 12, forks: 300, repo_total_commits: 500,
        user_commits: 400, user_merged_prs: 40, active_months: 4, pr_mergers: { "[self]": 40 },
      }),
    ],
    ext_prs: [
      ...(e.ext_prs ?? []),
      ...Array.from({ length: 40 }, () => pr({ repo: "corp/young", merged_by: d.login })),
      ...Array.from({ length: sp.rej_min }, (_, i) => [
        pr({ repo: `o${i}/r`, title: `Fixes #${i}`, state: "CLOSED", created_at: ago(40 + i), additions: 6000, changed_files: 60, closed_by: d.login }),
        pr({ repo: `o${i}/r`, title: `Fix ${i}`, created_at: ago(35 + i), merged_by: "maint" }),
      ]).flat(),
    ],
  };
}

describe("collector gates leave the score unchanged", () => {
  it.each(files)("%s", (file) => {
    const d = parseDeveloper(JSON.parse(readFileSync(file, "utf8")));
    for (const full of [d, enriched(d), stressed(d)]) expect(rateDeveloper(gated(full))).toEqual(rateDeveloper(full));
    // each stressed field is score-relevant: blanking it without its gate changes the result
    const s = stressed(d);
    const rated = rateDeveloper(s);
    const blanked: Developer[] = [
      { ...s, repos: s.repos.map((r) => ({ ...r, star_history: null })) },
      { ...s, ext_prs: s.ext_prs!.map((x) => ({ ...x, closed_by: null })) },
      { ...s, ext_prs: s.ext_prs!.map((x) => ({ ...x, reviewers: null })) },
    ];
    for (const b of blanked) expect(rateDeveloper(b)).not.toEqual(rated);
  });
});

describe("slopNeedsClosers", () => {
  const pr = (state: string, i: number): ExtPr => ({
    repo: `o${i}/r`, title: `Fixes #${i}`, state, created_at: `2026-03-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z`,
    additions: 6000, deletions: 0, changed_files: 60, merged_by: null, closed_by: null, reviewers: null,
  });
  const closed = (n: number) => Array.from({ length: n }, (_, i) => pr("CLOSED", i));

  it("needs closers from rej_min CLOSED PRs on", () => {
    expect(slopNeedsClosers([...closed(sp.rej_min - 1), pr("MERGED", 99), pr("OPEN", 98)])).toBe(false);
    expect(slopNeedsClosers(closed(sp.rej_min))).toBe(true);
  });

  it("just below rej_min every other slop signal firing still gives no verdict, whoever closed them", () => {
    const below = dev({ login: "u", collected_at: "2026-09-01T00:00:00Z", ext_prs: closed(sp.rej_min - 1) });
    const at = dev({ login: "u", collected_at: "2026-09-01T00:00:00Z", ext_prs: closed(sp.rej_min) });
    expect(rateDeveloper(below).v3.flags.slop).toBe(false);
    // at the threshold the closers decide: unknown closers reject, self-closes with no merge still reject
    expect(rateDeveloper(at).v3.flags.slop).toBe(true);
    expect(rateDeveloper(gated(below))).toEqual(rateDeveloper(below));
  });
});

describe("unreviewedCandidate", () => {
  const r = repo({ name: "Corp/New", contributors_total: p.unrev_adopted, owned: false });
  const merged = (n: number, name = "corp/new"): ExtPr[] =>
    Array.from({ length: n }, () => ({
      repo: name, title: "", state: "MERGED", created_at: "2026-07-01T00:00:00Z", additions: 0, deletions: 0,
      changed_files: 0, merged_by: "u", closed_by: null, reviewers: [],
    }));

  it("needs ≥ unrev_min_prs merged PRs (case-insensitive repo), < unrev_adopted outside contributors, not owned", () => {
    expect(unreviewedCandidate(r, merged(p.unrev_min_prs))).toBe(true);
    expect(unreviewedCandidate(r, merged(p.unrev_min_prs - 1))).toBe(false);
    expect(unreviewedCandidate(r, [...merged(p.unrev_min_prs - 1), { ...merged(1)[0], state: "CLOSED" }])).toBe(false);
    expect(unreviewedCandidate({ ...r, contributors_total: p.unrev_adopted + 1 }, merged(p.unrev_min_prs))).toBe(false);
    expect(unreviewedCandidate({ ...r, contributors_total: null }, merged(p.unrev_min_prs))).toBe(true);
    expect(unreviewedCandidate({ ...r, owned: true }, merged(p.unrev_min_prs))).toBe(false);
    expect(unreviewedCandidate(r, null)).toBe(false);
  });
});

describe("hypeNeedsStarHistory", () => {
  const now = fractionalYear("2026-09-27T00:00:00Z");
  const daysAgo = (days: number) => new Date(Date.UTC(2026, 8, 27) - days * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  // owned, 8000 stars, unknown issue authors (F3 unknown): F4 alone decides
  const viral = repo({
    name: "u/wrapper", owned: true, kind: "code", stars: 8070, contributors_total: 3, dependents: 0,
    active_months: p.hype_spike_max_months, last_push_at: daysAgo(p.hype_idle_days + 2),
  });
  /** isHype with and without the history agrees whenever the gate says it is not needed. */
  const consistent = (r: typeof viral) =>
    hypeNeedsStarHistory(r, now) || isHype({ ...r, star_history: spike }, now, p) === isHype({ ...r, star_history: null }, now, p);

  it("needed exactly where the spike decides isHype", () => {
    const cases = [
      viral,
      { ...viral, active_months: p.hype_spike_max_months + 1 },
      { ...viral, last_push_at: daysAgo(p.hype_idle_days - 2) },
      { ...viral, last_push_at: null },
      { ...viral, issue_authors: 2 },
      { ...viral, issue_authors: 2, kind: "content" },
      { ...viral, stars: p.hype_min_stars - 1 },
      { ...viral, kind: "list" },
      { ...viral, owned: false, user_commits: 5, repo_total_commits: 400 },
    ];
    expect(cases.map((r) => hypeNeedsStarHistory(r, now))).toEqual([true, false, false, false, false, true, false, false, false]);
    for (const r of cases) expect(consistent(r)).toBe(true);
    // where it is needed, the history does flip the verdict
    expect(isHype({ ...viral, star_history: spike }, now, p)).toBe(true);
    expect(isHype(viral, now, p)).toBe(false);
  });
});
