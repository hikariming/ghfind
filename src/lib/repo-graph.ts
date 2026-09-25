/**
 * Pure helpers that turn a developer's profile snapshot into a *repo graph* —
 * the normalized project layer that promotes repositories to first-class,
 * queryable entities alongside the developer-centric `scores` / `developer_facets`
 * tables.
 *
 * Two kinds of node come out of one scan:
 *   - `owner` links — the developer's own notable projects (from `top_repos`,
 *     which the crawler already narrows to original + attributed-original work,
 *     forks excluded and capped at 10). These carry rich metadata (stars,
 *     language, topics, description), so they seed the project page's info card.
 *   - `contributor` links — popular OSS the developer has materially worked on
 *     (from `impact_repos`, i.e. the contribution graph). Same star floor as the
 *     `repo` discovery facet so the two stay in sync; metadata is sparse here
 *     (impact_repos only carries name + stars + commits + prs), filled in later
 *     when a repo's actual owner is scanned.
 *
 * Side-effect free and dependency-light (mirrors {@link ./facets}), so it's
 * trivially unit-tested and reused by both the fire-and-forget write path in
 * `recordProfileSnapshot` and the one-off repo-graph backfill. The DB layer turns
 * the returned nodes/links into `repos` + `repo_developers` rows.
 */
import { rankImpactReposByContribution } from "./facets";
import type { ImpactRepo, TopRepo } from "./types";

/** A repository as a first-class entity. `repo_key` is the lowercased
 *  "owner/name" join key (stable across casing); the other string fields keep
 *  their original casing for display. Metadata beyond the key is best-effort —
 *  contributor-only repos surface with null language/description until their
 *  owner is scanned. */
export interface RepoNode {
  repo_key: string;
  name_with_owner: string;
  owner_login: string;
  name: string;
  description: string | null;
  stars: number;
  forks: number | null;
  language: string | null;
  topics: string[];
}

/** A developer's relationship to a repo. `owner` = it's their own/attributed
 *  featured work; `contributor` = they've landed commits/PRs into it. `weight`
 *  ranks a repo's developers: stars for owners, commit+PR volume for
 *  contributors. */
export interface RepoLink {
  repo_key: string;
  relation: "owner" | "contributor";
  commits: number | null;
  prs: number | null;
  weight: number;
}

export interface RepoGraph {
  repos: RepoNode[];
  links: RepoLink[];
}

/** An owned project needs this many stars to earn a project page — keeps the
 *  `repos` table to genuinely notable work (a dev's 3-star repo is not a
 *  discovery surface) and bounds table growth. */
const OWNER_MIN_STARS = 50;
/** A contributed-to project must clear this star floor to become a node. Kept
 *  identical to `REPO_MIN_STARS` in lib/facets.ts so the project graph and the
 *  `repo` discovery facet describe the same set of notable OSS. */
const CONTRIB_MIN_STARS = 500;
/** Per-developer caps so one prolific account can't flood either table. top_repos
 *  is already ≤10 upstream; impact_repos can be long. */
const MAX_OWNER_REPOS = 10;
const MAX_CONTRIB_REPOS = 20;

/** Lowercased "owner/name" join key, or null when the inputs can't form a stable
 *  key (no owner and no name_with_owner — `name` alone isn't globally unique). */
function repoKeyOf(nameWithOwner: string | null | undefined): string | null {
  if (typeof nameWithOwner !== "string") return null;
  const trimmed = nameWithOwner.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.toLowerCase();
}

/** Owner nodes + links from the developer's own notable repos. */
function ownerGraph(topRepos: TopRepo[]): { nodes: RepoNode[]; links: RepoLink[] } {
  const nodes: RepoNode[] = [];
  const links: RepoLink[] = [];
  const seen = new Set<string>();
  const ranked = [...topRepos]
    .filter((r) => (r?.stars ?? 0) >= OWNER_MIN_STARS)
    .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));

  for (const r of ranked) {
    const nameWithOwner = r.name_with_owner ?? (r.owner_login ? `${r.owner_login}/${r.name}` : null);
    const key = repoKeyOf(nameWithOwner);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const [ownerFromKey, nameFromKey] = key.split("/");
    nodes.push({
      repo_key: key,
      name_with_owner: (nameWithOwner as string).trim(),
      owner_login: (r.owner_login ?? ownerFromKey).toLowerCase(),
      name: r.name ?? nameFromKey,
      description: r.description ?? null,
      stars: r.stars ?? 0,
      forks: r.forks ?? null,
      language: r.language ?? null,
      topics: Array.isArray(r.topics) ? r.topics : [],
    });
    links.push({ repo_key: key, relation: "owner", commits: null, prs: null, weight: r.stars ?? 0 });
    if (nodes.length >= MAX_OWNER_REPOS) break;
  }
  return { nodes, links };
}

/** Contributor nodes + links from the contribution graph (impact_repos). Nodes
 *  here are metadata-thin — filled in when the repo's owner is scanned. */
function contributorGraph(impactRepos: ImpactRepo[]): { nodes: RepoNode[]; links: RepoLink[] } {
  const nodes: RepoNode[] = [];
  const links: RepoLink[] = [];
  const seen = new Set<string>();
  const ranked = rankImpactReposByContribution(
    impactRepos.filter((r) => typeof r?.repo === "string" && (r.stars ?? 0) >= CONTRIB_MIN_STARS),
  );

  for (const r of ranked) {
    const key = repoKeyOf(r.repo);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const [ownerFromKey, nameFromKey] = key.split("/");
    nodes.push({
      repo_key: key,
      name_with_owner: r.repo.trim(),
      owner_login: ownerFromKey,
      name: nameFromKey,
      description: null,
      stars: r.stars ?? 0,
      forks: null,
      language: null,
      topics: [],
    });
    links.push({
      repo_key: key,
      relation: "contributor",
      commits: r.commits ?? null,
      prs: r.prs ?? null,
      weight: (r.commits ?? 0) + (r.prs ?? 0),
    });
    if (nodes.length >= MAX_CONTRIB_REPOS) break;
  }
  return { nodes, links };
}

/**
 * The full repo graph one developer contributes, derived from the raw repo
 * signals a profile snapshot carries. Deterministic and side-effect free.
 *
 * A repo the developer both owns and has contribution activity in (rare, but
 * possible for attributed org repos) yields a single owner link — the owner
 * relation is deduped ahead of contributor and wins.
 */
export function extractRepoGraph(input: {
  top_repos?: TopRepo[] | null;
  impact_repos?: ImpactRepo[] | null;
}): RepoGraph {
  const owner = ownerGraph(input.top_repos ?? []);
  const contrib = contributorGraph(input.impact_repos ?? []);

  // Owner relation wins when the same repo appears on both sides.
  const ownedKeys = new Set(owner.links.map((l) => l.repo_key));
  const contribLinks = contrib.links.filter((l) => !ownedKeys.has(l.repo_key));

  // Merge nodes by key; owner nodes (richer metadata) take precedence.
  const nodesByKey = new Map<string, RepoNode>();
  for (const n of contrib.nodes) nodesByKey.set(n.repo_key, n);
  for (const n of owner.nodes) nodesByKey.set(n.repo_key, n);

  return {
    repos: [...nodesByKey.values()],
    links: [...owner.links, ...contribLinks],
  };
}
