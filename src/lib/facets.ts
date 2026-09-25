/**
 * Pure classification helpers that turn a developer's profile snapshot into
 * queryable *facets* — the discovery axes for the `/developers` directory.
 *
 * Three facet types ship today:
 *   - `language` — the dev's primary programming languages (by byte share across
 *     their top repos), so the directory can list "top Rust developers".
 *   - `org` — the GitHub organizations they belong to (huggingface, pytorch …),
 *     a strong circle/affiliation signal.
 *   - `repo` — notable OSS projects the dev has materially contributed to (from
 *     the contribution graph, not their own repos), so the directory can list
 *     "developers who work on langgenius/dify". This is the axis where many devs
 *     converge on one famous project, making it the strongest discovery bucket.
 *
 * Side-effect free and dependency-light (mirrors {@link ./profile-insights}) so
 * it's trivially unit-tested and reused by both the fire-and-forget write path in
 * `recordProfileSnapshot` and the one-off facet backfill. The DB layer turns the
 * returned {@link Facet}[] into `developer_facets` rows.
 */
import { aggregateLanguages } from "./profile-insights";
import type { ImpactRepo, TopRepo } from "./types";

export type FacetType = "language" | "org" | "repo";

export interface Facet {
  type: FacetType;
  /** Canonical, groupable value — e.g. "Rust", "huggingface". Also the display
   *  string (no separate label column), so it stays human-readable. */
  value: string;
  /** language: percent byte-share among the dev's *kept* languages (0–100);
   *  org: always 1; repo: the project's star count (informational — lets a later
   *  "primary project" pick, and never used for bucket ordering, which is by
   *  score). Lets the reader pick a dev's single primary language later. */
  weight: number;
}

/** Cap on how many of each facet type one developer contributes. Languages are
 *  narrow (a dev "is" 1–3 languages); orgs are higher-signal so we keep more;
 *  repos are capped so one prolific contributor can't flood the facet table.
 *  The repo cap matches the repo graph's contributor cap (lib/repo-graph.ts) so a
 *  project page's contributor summary and its developer list count the same people. */
const MAX_LANGUAGES_PER_DEV = 3;
const MAX_ORGS_PER_DEV = 5;
const MAX_REPOS_PER_DEV = 20;
/** A contributed-to project must clear this star floor to become a `repo` facet.
 *  Keeps the project directory to *notable* OSS (nobody discovers developers by
 *  an obscure 3-star repo) and bounds the facet table — the one knob for project
 *  noise, mirroring MIN_LANGUAGE_PCT for languages. */
const REPO_MIN_STARS = 500;
/** A language must own at least this byte-share (of the dev's real code) to be a
 *  facet — unless it's their single top language, which is always kept so any
 *  dev with real code lands in at least one language bucket. */
const MIN_LANGUAGE_PCT = 15;

/**
 * GitHub Linguist reports markup, build, and doc formats as "languages". Nobody
 * discovers a "CSS developer" or a "Makefile developer", so these are dropped
 * before ranking to keep the directory buckets meaningful. Curated and
 * intentionally conservative — tune here, it's the one knob for language noise.
 */
const LANGUAGE_EXCLUDE = new Set(
  [
    "HTML",
    "CSS",
    "SCSS",
    "Sass",
    "Less",
    "Stylus",
    "Makefile",
    "CMake",
    "Dockerfile",
    "Batchfile",
    "Shell",
    "PowerShell",
    "Roff",
    "TeX",
    "Rich Text Format",
    "Jupyter Notebook",
    "Vim Snippet",
  ].map((n) => n.toLowerCase()),
);

function isRealLanguage(name: string): boolean {
  return !LANGUAGE_EXCLUDE.has(name.trim().toLowerCase());
}

/**
 * The dev's primary language facets: aggregate byte share across their repos
 * (via {@link aggregateLanguages}), drop markup/build noise, re-normalize the
 * remaining shares to sum ~100, then keep those clearing {@link MIN_LANGUAGE_PCT}
 * (always keeping the single top one). Returns [] when there's no real-code
 * signal at all.
 */
function languageFacets(topRepos: TopRepo[]): Facet[] {
  const shares = aggregateLanguages(topRepos, 12).filter((l) => isRealLanguage(l.name));
  if (shares.length === 0) return [];

  const total = shares.reduce((sum, l) => sum + l.pct, 0);
  if (total === 0) return [];

  const renormalized = shares.map((l) => ({
    value: l.name,
    weight: Math.round((l.pct / total) * 100),
  }));

  const kept = renormalized.filter((l, i) => i === 0 || l.weight >= MIN_LANGUAGE_PCT);
  return kept
    .slice(0, MAX_LANGUAGES_PER_DEV)
    .map((l) => ({ type: "language" as const, value: l.value, weight: l.weight }));
}

/** Org facets: trimmed, deduped org logins the dev belongs to (weight 1). */
function orgFacets(organizations: string[]): Facet[] {
  const seen = new Set<string>();
  const out: Facet[] = [];
  for (const raw of organizations) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: "org", value, weight: 1 });
    if (out.length >= MAX_ORGS_PER_DEV) break;
  }
  return out;
}

/**
 * Orders contributed-to repos by the developer's own work in them (commits +
 * PRs), then by stars. Ranking by stars alone let a one-commit drive-by into a
 * famous repo evict the project someone actually maintains once the per-dev cap
 * is hit. Shared with lib/repo-graph.ts so both caps keep the same repos.
 */
export function rankImpactReposByContribution(impactRepos: ImpactRepo[]): ImpactRepo[] {
  const work = (r: ImpactRepo) => (r.commits ?? 0) + (r.prs ?? 0);
  return [...impactRepos].sort((a, b) => work(b) - work(a) || (b.stars ?? 0) - (a.stars ?? 0));
}

/**
 * Project facets: notable OSS the dev has *contributed to* (from `impact_repos`,
 * i.e. the contribution graph — not repos they own). Filtered to projects that
 * clear {@link REPO_MIN_STARS}, deduped by full name, ranked by the dev's own
 * contribution volume, and capped at {@link MAX_REPOS_PER_DEV}. The value is the canonical "owner/name" (kept
 * verbatim for display and links). This is what lets many developers converge on
 * one bucket (e.g. everyone who touched langgenius/dify).
 */
function repoFacets(impactRepos: ImpactRepo[]): Facet[] {
  const seen = new Set<string>();
  const out: Facet[] = [];
  const ranked = rankImpactReposByContribution(
    impactRepos.filter(
      (r) => typeof r?.repo === "string" && r.repo.includes("/") && (r.stars ?? 0) >= REPO_MIN_STARS,
    ),
  );
  for (const r of ranked) {
    const value = r.repo.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push({ type: "repo", value, weight: r.stars ?? 0 });
    if (out.length >= MAX_REPOS_PER_DEV) break;
  }
  return out;
}

/**
 * All discovery facets for one developer, derived from the raw signals a profile
 * snapshot carries. Deterministic and side-effect free.
 */
export function extractFacets(input: {
  top_repos?: TopRepo[] | null;
  organizations?: string[] | null;
  impact_repos?: ImpactRepo[] | null;
}): Facet[] {
  return [
    ...languageFacets(input.top_repos ?? []),
    ...orgFacets(input.organizations ?? []),
    ...repoFacets(input.impact_repos ?? []),
  ];
}
