/**
 * Repo-level phases of the devscore collector: collect.py collect() from the candidate repos
 * on (lines 1622-2002) split into phases, plus the fetchers they call (fetch_repo_meta,
 * fetch_repo_pr_samples, fetch_pr_details, fetch_mutual_mergers, fetch_commit_histories,
 * fetch_repo_signals, fetch_dependents, contributors_commits, sample_commits, commit_heat,
 * owner_types, fetch_star_histories) and the final Developer assembly.
 */
import { fractionalYear, type Developer, type Repo } from "../model";
import { hypeNeedsStarHistory, unreviewedCandidate } from "../engine/score";
import { slopNeedsClosers } from "../engine/slop";
import { eqlIgnoreCase } from "../engine/ascii";
import {
  classifyCommit,
  classifyPr,
  coreArea,
  ECO_LOOKUP,
  ECO_NAME_LOOKUP,
  ECO_PAGES,
  ECO_WORKERS,
  hasCi,
  hasTests,
  issueAuthors,
  kindWithEvidence,
  MAINT_MONTH_MIN,
  MAINT_REPOS,
  MAINT_SIGNAL_REPOS,
  maintMonths,
  MERGE_TITLE,
  mergerKey,
  monthKey,
  MUTUAL_BATCH,
  mutualMergerPairs,
  packageDependents,
  packageNames,
  prBatchShare,
  prMergers,
  prSamplePriority,
  prSubstance,
  repoKind,
  repoPriority,
  ROLE_RANK,
  scaleCounts,
  SIGNAL_BATCH,
  STAR_API_VERSION,
  STAR_PAGES,
  starHistoryCandidates,
  starHistoryNote,
  type RootEntry,
} from "./classify";
import { ApiError, chunks, gqlStr, linkHasNext, monthEnd, monthStart, pool, type Http } from "./http";
import type { PhaseContext } from "./index";
import type {
  CollectedExtPr,
  ContribsOut,
  ExtPrsOut,
  GapFillOut,
  HistoriesOut,
  HistoryNode,
  MaintRaw,
  MergedPrNode,
  MergedPrsOut,
  MutualMergersOut,
  OwnerTypesOut,
  PerRepoExtra,
  PerRepoOut,
  PrDetail,
  PrDetailsOut,
  PrSamplesOut,
  RejectedOut,
  RepoMeta,
  RepoMetaOut,
  RepoMonths,
  SignalsOut,
  StarHistoryOut,
  UserOut,
} from "./outputs";
import { gapNote } from "./phase-maint";
import { EXT_PR_CAP, EXT_PR_PAGES, extPrSince, fetchReviewers, isExternal, PR_SCAN_REQUESTS, pyRound } from "./phase-user";

/** merged PRs fetched in detail (additions/deletions/files) */
export const PR_DETAIL_CAP = 60;
export const PR_DETAIL_PER_REPO_FIRST_PASS = 8;
/** per-repo merged-PR titles for title classification */
export const REPO_PR_SAMPLE = 20;
/** top PR repos by pr_sample_priority that get a per-repo merged-PR sample */
export const PR_SAMPLE_REPOS = 50;
/** GraphQL history pages (100 each) of the user's commits per repo */
export const HISTORY_PAGES = 3;
/** top repos by repo_priority whose commit history is read */
export const HISTORY_REPOS = 40;
/** repos per history query (1 point; 10 aliases time out) */
export const HISTORY_BATCH = 3;
/** concurrent history queries */
export const HISTORY_WORKERS = 4;
/** concurrent commit-diff fetches per sampled repo */
export const SAMPLE_WORKERS = 6;
/** top repos by repo_priority that get adoption signals (GraphQL + ecosyste.ms) */
export const SIGNAL_REPOS = 25;
/** REST /contributors (1-2 calls per repo) only for the top CONTRIB_REPOS */
export const CONTRIB_REPOS = 10;
/** top repos by repo_priority whose own commits are diff-sampled */
export const COMMIT_SAMPLE_REPOS = 12;
/** own non-merge commits per sampled repo whose diff is fetched */
export const COMMIT_SAMPLE = 12;
/** aliased path histories per heat query */
export const HEAT_AREAS = 20;
/** concurrent per_repo workers (collect.py `_Pool(8)`) */
const PER_REPO_WORKERS = 8;
const STAR_WORKERS = 4;

export const REPO_FIELDS = `nameWithOwner stargazerCount forkCount isFork isPrivate description pushedAt
  owner { login } defaultBranchRef { target { ... on Commit { history { totalCount } } } }
  object(expression: "HEAD:") { ... on Tree { entries { name type extension } } }
  workflows: object(expression: "HEAD:.github/workflows") { ... on Tree { entries { name } } }
  releases { totalCount }
  mentionableUsers { totalCount }`;
const MERGED_BY = "mergedBy { login __typename }";

/** RECENT_FROM: "YYYY-MM" 24 months before collection. */
export function recentFrom(startedAt: string): string {
  return `${Number(startedAt.slice(0, 4)) - 2}-${startedAt.slice(5, 7)}`;
}

/** HEAT_SINCE: 3 years before collection, day capped at 28 (keeps the cache warm). */
export function heatSince(startedAt: string): string {
  const day = Math.min(Number(startedAt.slice(8, 10)), 28);
  return `${Number(startedAt.slice(0, 4)) - 3}-${startedAt.slice(5, 7)}-${String(day).padStart(2, "0")}T00:00:00Z`;
}

/** Python round(x, 4): the exact decimal value rounded, exact ties half to even. */
function pyRound4(x: number): number {
  const exact = x.toFixed(20);
  if (/^-?\d+\.\d{4}50*$/.test(exact)) return pyRound(x * 1e4) / 1e4;
  return Number(x.toFixed(4));
}

/** Sort by a (number, string) key like Python's sorted(key=lambda r: (n, s)) (stable). */
function sortBy<T>(items: T[], key: (item: T) => [number, string]): T[] {
  const keyed = items.map((item) => [key(item), item] as const);
  keyed.sort(([a], [b]) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return keyed.map(([, item]) => item);
}

function sumValues(months: Record<string, number>): number {
  return Object.values(months).reduce((a, b) => a + b, 0);
}

/** Python dict(sorted(d.items())) on string keys. */
function sortedKeys(o: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The optional REPO_FIELDS parts of a repo meta, as GraphQL returns them. */
interface MetaFields {
  description?: string | null;
  pushedAt?: string | null;
  defaultBranchRef?: { target?: { history?: { totalCount: number } | null } | null } | null;
  object?: { entries?: RootEntry[] | null } | null;
  workflows?: { entries?: { name: string }[] | null } | null;
  releases?: { totalCount: number } | null;
  mentionableUsers?: { totalCount: number } | null;
}
type Meta = RepoMeta & MetaFields;

function owns(m: RepoMeta, login: string): boolean {
  return m.owner.login.toLowerCase() === login.toLowerCase();
}

// ---------------------------------------------------------------- fetchers

/** fetch_repo_meta: requested name → meta (null when unresolvable); meta.nameWithOwner is canonical. */
export async function fetchRepoMeta(http: Http, names: string[]): Promise<Map<string, RepoMeta | null>> {
  const run = async (chunk: string[]) => {
    const parts = chunk.map((n, i) => {
      const slash = n.indexOf("/");
      return `r${i}: repository(owner: ${gqlStr(n.slice(0, slash))}, name: ${gqlStr(n.slice(slash + 1))}) { ${REPO_FIELDS} }`;
    });
    const data = await http.graphql<Record<string, RepoMeta | null>>("query { " + parts.join("\n") + " }");
    return new Map(chunk.map((n, i) => [n, data[`r${i}`] ?? null]));
  };
  return http.parHalving(names, 20, run, "repo meta");
}

type PrSample = { issueCount: number; nodes: MergedPrNode[] } | null;

/** fetch_repo_pr_samples: repo → (merged PR count, first REPO_PR_SAMPLE nodes) via aliased search. */
export async function fetchRepoPrSamples(http: Http, login: string, repos: string[]): Promise<Map<string, PrSample>> {
  const run = async (chunk: string[]) => {
    const parts = chunk.map((r, i) => {
      const q = `repo:${r} author:${login} is:pr is:merged`;
      return `s${i}: search(query: ${gqlStr(q)}, type: ISSUE, first: ${REPO_PR_SAMPLE}) {
              issueCount nodes { ... on PullRequest { number title createdAt mergedAt ${MERGED_BY} } } }`;
    });
    const data = await http.graphql<Record<string, PrSample>>("query { " + parts.join("\n") + " }");
    return new Map(chunk.map((r, i) => [r, data[`s${i}`] ?? null]));
  };
  return http.parHalving(repos, 10, run, "repo PR search");
}

/** fetch_pr_details: "repo#number" → {additions, deletions, files, substance}. */
export async function fetchPrDetails(http: Http, prs: [string, number][]): Promise<Map<string, PrDetail>> {
  type Pr = { additions: number; deletions: number; files: { nodes?: { path: string; additions: number; deletions: number }[] | null } | null };
  const run = async (chunk: [string, number][]) => {
    const parts = chunk.map(([r, num], i) => {
      const slash = r.indexOf("/");
      return `p${i}: repository(owner: ${gqlStr(r.slice(0, slash))}, name: ${gqlStr(r.slice(slash + 1))}) {
              pullRequest(number: ${num}) { additions deletions
                files(first: 100) { nodes { path additions deletions } } } }`;
    });
    const data = await http.graphql<Record<string, { pullRequest?: Pr | null } | null>>("query { " + parts.join("\n") + " }");
    const out = new Map<string, PrDetail>();
    chunk.forEach(([r, num], i) => {
      const pr = data[`p${i}`]?.pullRequest;
      if (!pr) return;
      const nodes = pr.files?.nodes ?? [];
      out.set(`${r}#${num}`, {
        additions: pr.additions,
        deletions: pr.deletions,
        files: nodes.map((f) => f.path),
        substance: prSubstance(nodes),
      });
    });
    return out;
  };
  return http.parHalving(prs, 10, run, "PR detail");
}

/**
 * fetch_mutual_mergers: "repo#merger" → true if the user merged any of the merger's (first 20)
 * merged PRs in that repo. Pairs whose search fails are absent (unknown).
 */
export async function fetchMutualMergers(http: Http, login: string, pairs: [string, string][]): Promise<Map<string, boolean>> {
  const run = async (chunk: [string, string][]) => {
    const parts = chunk.map(([r, m], i) => {
      const q = `repo:${r} is:pr is:merged author:${m}`;
      return `m${i}: search(query: ${gqlStr(q)}, type: ISSUE, first: 20) {
              nodes { ... on PullRequest { ${MERGED_BY} } } }`;
    });
    type S = { nodes: ({ mergedBy?: { login: string; __typename: string } | null } | null)[] } | null;
    const data = await http.graphql<Record<string, S>>("query { " + parts.join("\n") + " }");
    const out = new Map<string, boolean>();
    chunk.forEach(([r, m], i) => {
      const s = data[`m${i}`];
      if (s != null) out.set(`${r}#${m}`, s.nodes.some((n) => n !== null && mergerKey(n, login) === "[self]"));
    });
    return out;
  };
  return http.parHalving(pairs, MUTUAL_BATCH, run, "mutual mergers");
}

interface GqlHistory {
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: ({
    oid: string;
    additions: number | null;
    deletions: number | null;
    committedDate: string | null;
    messageHeadline: string | null;
    parents: { totalCount: number };
  } | null)[];
}

/**
 * fetch_commit_histories: repo → {total, nodes, sizes}: the user's default-branch commits
 * (newest first, up to HISTORY_PAGES×100) via GraphQL history(author: {id}), HISTORY_BATCH repos
 * (or follow-up cursors) per query. Repos whose history cannot be read are absent.
 */
export async function fetchCommitHistories(http: Http, uid: string, repos: string[]): Promise<HistoriesOut> {
  const run = async (chunk: [string, string | null][]) => {
    const parts = chunk.map(([r, after], i) => {
      const slash = r.indexOf("/");
      const cur = after ? `, after: ${gqlStr(after)}` : "";
      return `h${i}: repository(owner: ${gqlStr(r.slice(0, slash))}, name: ${gqlStr(r.slice(slash + 1))}) {
              defaultBranchRef { target { ... on Commit {
                history(first: 100, author: {id: ${gqlStr(uid)}}${cur}) {
                  totalCount pageInfo { hasNextPage endCursor }
                  nodes { oid additions deletions committedDate messageHeadline parents { totalCount } }
              } } } } }`;
    });
    type D = { defaultBranchRef?: { target?: { history?: GqlHistory | null } | null } | null } | null;
    const data = await http.graphql<Record<string, D>>("query { " + parts.join("\n") + " }");
    return new Map(chunk.map(([r], i) => [r, data[`h${i}`]?.defaultBranchRef?.target?.history ?? null]));
  };
  const out: Record<string, { total: number; nodes: HistoryNode[] }> = {};
  let pending: [string, string | null][] = repos.map((r) => [r, null]);
  for (let page = 0; page < HISTORY_PAGES; page += 1) {
    const got = new Map<string, GqlHistory | null>();
    const parts = await pool(chunks(pending, HISTORY_BATCH), HISTORY_WORKERS, (c) => http.halving(c, run, "commit history"));
    for (const part of parts) for (const [k, v] of part) got.set(k, v);
    pending = [];
    for (const [r, h] of got) {
      if (!h) continue;
      const e = (out[r] ??= { total: h.totalCount, nodes: [] });
      for (const c of h.nodes) {
        if (!c) continue;
        e.nodes.push({
          oid: c.oid,
          date: c.committedDate,
          lines: (c.additions || 0) + (c.deletions || 0),
          merge: c.parents.totalCount > 1 || MERGE_TITLE.test(c.messageHeadline || ""),
        });
      }
      if (h.pageInfo.hasNextPage) pending.push([r, h.pageInfo.endCursor]);
    }
    if (pending.length === 0) break;
  }
  const result: HistoriesOut = {};
  for (const [r, e] of Object.entries(out)) {
    result[r] = { ...e, sizes: e.nodes.map((c) => ({ lines: c.lines, merge: c.merge, at: c.date })) };
  }
  return result;
}

/** fetch_repo_signals: repo → {issue_authors} (outside authors of the last 50 issues). Failed repos absent. */
export async function fetchRepoSignals(http: Http, login: string, top: string[]): Promise<Map<string, { issue_authors: number }>> {
  const run = async (chunk: string[]) => {
    const parts = chunk.map((r, i) => {
      const slash = r.indexOf("/");
      return `s${i}: repository(owner: ${gqlStr(r.slice(0, slash))}, name: ${gqlStr(r.slice(slash + 1))}) { owner { login }
              issues(last: 50) { nodes { author { login __typename } } } }`;
    });
    type D = { owner: { login: string }; issues: { nodes: Parameters<typeof issueAuthors>[0] } } | null;
    const data = await http.graphql<Record<string, D>>("query { " + parts.join("\n") + " }");
    const out = new Map<string, { issue_authors: number }>();
    chunk.forEach((r, i) => {
      const d = data[`s${i}`];
      if (d != null) out.set(r, { issue_authors: issueAuthors(d.issues.nodes, d.owner.login, login) });
    });
    return out;
  };
  return http.parHalving(top, SIGNAL_BATCH, run, "repo signals");
}

/** eco_lookup_url: all packages ecosyste.ms links to the repo (pages of 100, ≤ ECO_PAGES); null on failure. */
export async function ecoLookupUrl(http: Http, repo: string): Promise<unknown[] | null> {
  const first = await http.ecoGet(ECO_LOOKUP + repo);
  if (!Array.isArray(first)) return null;
  const out: unknown[] = [...first];
  let page = 1;
  while (out.length === 100 * page && page < ECO_PAGES) {
    page += 1;
    const more = await http.ecoGet(`${ECO_LOOKUP}${repo}&page=${page}`);
    if (!Array.isArray(more) || more.length === 0) break;
    out.push(...more);
  }
  return out;
}

/**
 * fetch_dependents: repo → [dependents, dependent_repos] via the ecosyste.ms package lookups:
 * repository_url, then a name lookup for each packageNames() name no found package carries.
 * `done` holds results already known (a resumed step); `onRepo` sees each new one.
 */
export async function fetchDependents(
  http: Http,
  repos: string[],
  done: Record<string, [number | null, number | null]> = {},
  onRepo?: (repo: string, value: [number | null, number | null]) => void,
): Promise<Record<string, [number | null, number | null]>> {
  const res = await pool(repos, ECO_WORKERS, async (r): Promise<[number | null, number | null]> => {
    if (done[r]) return done[r];
    const byUrl = await ecoLookupUrl(http, r);
    const have = new Set<string>();
    for (const p of byUrl ?? []) {
      if (p && typeof p === "object" && !Array.isArray(p)) have.add(String((p as { name?: unknown }).name || "").toLowerCase());
    }
    const byName: unknown[] = [];
    for (const n of packageNames(r)) {
      if (!have.has(n)) byName.push(await http.ecoGet(ECO_NAME_LOOKUP + encodeURIComponent(n)));
    }
    const value: [number | null, number | null] =
      byUrl === null && byName.every((x) => x === null) ? [null, null] : packageDependents(r, byUrl, byName);
    onRepo?.(r, value);
    return value;
  });
  return Object.fromEntries(repos.map((r, i) => [r, res[i]]));
}

/** contributors_commits result. */
export interface ContribStanding {
  uc: number | null;
  rank: number | null;
  total: number | null;
  top: number | null;
  standing: Record<string, number> | null;
}

const NO_STANDING: ContribStanding = { uc: null, rank: null, total: null, top: null, standing: null };

/**
 * contributors_commits: the user's standing in REST /contributors (anon=1), page 1 only; the
 * login's entry plus anonymous entries named like the login/profile name (`names`, lowercase);
 * `mergers`' commits relative to the #1 entry; total from the Link rel="last" page.
 */
export async function contributorsCommits(
  http: Http,
  repo: string,
  login: string,
  names: Set<string>,
  mergers: string[],
): Promise<ContribStanding> {
  type C = { login?: string | null; type?: string; name?: string | null; contributions: number };
  const lo = login.toLowerCase();
  const out: ContribStanding = { ...NO_STANDING };
  let items: unknown;
  let link: string | null;
  try {
    [items, link] = await http.rest(`repos/${repo}/contributors?per_page=100&anon=1&page=1`);
  } catch (error) {
    if (error instanceof ApiError) return out;
    throw error;
  }
  if (!Array.isArray(items)) return out;
  const list = items as C[];
  if (list.length) out.top = list[0].contributions ?? null;
  list.forEach((c, i) => {
    if ((c.login || "").toLowerCase() === lo || (c.type === "Anonymous" && names.has((c.name || "").trim().toLowerCase()))) {
      out.uc = (out.uc ?? 0) + c.contributions;
      if (out.rank === null) out.rank = i + 1;
    }
  });
  if (list.length && mergers.length) {
    const byLogin = new Map(list.map((c) => [(c.login || "").toLowerCase(), c.contributions]));
    const top = list[0].contributions || 0;
    out.standing = Object.fromEntries(
      mergers.map((m) => [m, top ? pyRound4(Math.min(1, (byLogin.get(m.toLowerCase()) ?? 0) / top)) : 0]),
    );
  }
  const last = /[?&]page=(\d+)[^>]*>; rel="last"/.exec(link ?? "");
  if (!linkHasNext(link)) out.total = list.length;
  else if (last) {
    const lastPage = Number(last[1]);
    try {
      const [rest] = await http.rest(`repos/${repo}/contributors?per_page=100&anon=1&page=${lastPage}`);
      if (Array.isArray(rest)) out.total = (lastPage - 1) * 100 + rest.length;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  }
  return out;
}

type SampleCommit = { kind: string; substance: number; lines: number; heat: number | null };
type RawSample = Omit<SampleCommit, "heat"> & { areas: string[] };

/**
 * sample_commits: up to COMMIT_SAMPLE of the user's non-merge history commits, evenly spread in
 * time, each classified from its REST diff; `areas` (core areas of its files) feed commitHeat.
 */
export async function sampleCommits(http: Http, repo: string, nodes: HistoryNode[]): Promise<RawSample[]> {
  const own = nodes.filter((c) => !c.merge).sort((a, b) => {
    const x = a.date || "";
    const y = b.date || "";
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const n = own.length;
  const k = Math.min(n, COMMIT_SAMPLE);
  const idx = [...new Set(Array.from({ length: k }, (_, i) => pyRound((i * (n - 1)) / Math.max(1, k - 1))))].sort((a, b) => a - b);
  type Full = { commit?: { message?: string | null } | null; files?: { filename?: string | null; additions?: number | null; deletions?: number | null }[] | null };
  const res = await pool(idx, SAMPLE_WORKERS, async (i): Promise<RawSample | null> => {
    let full: Full | null;
    try {
      [full] = await http.rest<Full | null>(`repos/${repo}/commits/${own[i].oid}`);
    } catch (error) {
      if (error instanceof ApiError) return null;
      throw error;
    }
    const files = (full?.files ?? []).map((f) => ({ path: f.filename ?? null, additions: f.additions ?? null, deletions: f.deletions ?? null }));
    const areas = new Set<string>();
    for (const f of files) {
      const a = coreArea(f.path || "");
      if (a) areas.add(a);
    }
    return {
      kind: classifyCommit(full?.commit?.message || "", 1, files.map((f) => ({ filename: f.path, ...f }))),
      substance: prSubstance(files),
      lines: files.reduce((s, f) => s + (f.additions || 0) + (f.deletions || 0), 0),
      areas: [...areas].sort(),
    };
  });
  return res.filter((s): s is RawSample => s !== null);
}

/** Key of the all-commits total in commitHeat's counts (no core area is empty). */
const HEAT_TOTAL = "";

/**
 * commit_heat: each sample commit's heat = max over its core areas of (default-branch commits
 * touching the area since `since`) / (all default-branch commits since `since`); null when it
 * has no core area, the total is 0 or the lookup failed.
 */
export async function commitHeat(http: Http, repo: string, sample: RawSample[], since: string): Promise<SampleCommit[]> {
  const areas = [...new Set(sample.flatMap((c) => c.areas))].sort();
  const slash = repo.indexOf("/");
  const o = repo.slice(0, slash);
  const n = repo.slice(slash + 1);
  const run = async (chunk: string[]) => {
    const parts = chunk.map((a, i) => `a${i}: history(path: ${gqlStr(a)}, since: ${gqlStr(since)}) { totalCount }`);
    type T = Record<string, { totalCount: number } | null>;
    const data = await http.graphql<{ repository?: { defaultBranchRef?: { target?: T | null } | null } | null }>(
      `query { repository(owner: ${gqlStr(o)}, name: ${gqlStr(n)}) {
          defaultBranchRef { target { ... on Commit {
            total: history(since: ${gqlStr(since)}) { totalCount }
            ${parts.join(" ")} } } } } }`,
    );
    const t: T = data.repository?.defaultBranchRef?.target ?? {};
    const out = new Map<string, number | null>(chunk.map((a, i) => [a, t[`a${i}`]?.totalCount ?? null]));
    out.set(HEAT_TOTAL, t.total?.totalCount ?? null);
    return out;
  };
  const counts = await http.parHalving(areas, HEAT_AREAS, run, `heat ${repo}`);
  const total = counts.get(HEAT_TOTAL) ?? null;
  return sample.map(({ areas: own, ...c }) => {
    const vals = own.map((a) => counts.get(a)).filter((v): v is number => v != null);
    return { ...c, heat: vals.length && total ? Math.min(1, Math.max(...vals) / total) : null };
  });
}

/** owner_types: owner login → is Organization (null if unresolvable). */
export async function ownerTypes(http: Http, owners: string[]): Promise<OwnerTypesOut> {
  const run = async (chunk: string[]) => {
    const parts = chunk.map((o, i) => `o${i}: repositoryOwner(login: ${gqlStr(o)}) { __typename }`);
    const data = await http.graphql<Record<string, { __typename: string } | null>>("query { " + parts.join("\n") + " }");
    return new Map(chunk.map((o, i) => [o, data[`o${i}`]?.__typename ?? null]));
  };
  const out = await http.parHalving([...owners].sort(), 50, run, "owner type");
  return Object.fromEntries(owners.map((o) => [o, out.get(o) == null ? null : out.get(o) === "Organization"]));
}

/**
 * fetch_star_history: weekly star gains [["YYYY-MM-DD", gain > 0], …] ascending from GET
 * /repos/{r}/stargazers/history (API version STAR_API_VERSION, 30 weeks per page, ≤ STAR_PAGES
 * pages); null when the first page fails.
 */
export async function fetchStarHistory(http: Http, repo: string): Promise<[string, number][] | null> {
  const weeks = new Map<number, number>();
  for (let page = 1; page <= STAR_PAGES; page += 1) {
    let items: unknown;
    let link: string | null;
    try {
      [items, link] = await http.rest(`repos/${repo}/stargazers/history?per_page=30&page=${page}`, STAR_API_VERSION);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (page === 1) {
        http.env.log?.(`  ! star history ${repo}: ${error.message}`);
        return null;
      }
      break;
    }
    for (const w of Array.isArray(items) ? items : []) {
      if (w && typeof w === "object" && !Array.isArray(w) && w.total) weeks.set(Math.trunc(Number(w.week)), Math.trunc(Number(w.total)));
    }
    if (!linkHasNext(link)) break;
  }
  return [...weeks]
    .sort((a, b) => a[0] - b[0])
    .map(([t, n]) => [new Date(t * 1000).toISOString().slice(0, 10), n]);
}

// ---------------------------------------------------------------- phases

/** Python `rekey`: contribution months folded onto canonical names (dropped repos vanish). */
function rekey(src: RepoMonths, alias: Record<string, string>): RepoMonths {
  const out: RepoMonths = {};
  for (const [r, months] of Object.entries(src)) {
    const to = alias[r];
    if (to === undefined) continue;
    const o = (out[to] ??= {});
    for (const [m, c] of Object.entries(months)) o[m] = (o[m] ?? 0) + c;
  }
  return out;
}

export async function runRepoMeta(ctx: PhaseContext): Promise<RepoMetaOut> {
  const u = await ctx.get<UserOut>("user");
  const contribs = await ctx.get<ContribsOut>("contribs");
  const { maint: maintRaw } = await ctx.get<GapFillOut>("gap_fill");
  const merged = await ctx.get<MergedPrsOut>("merged_prs");
  const login = u.login;
  const notes: string[] = [];

  const verified = Object.entries(maintRaw ?? {}).filter(([, e]) => e.role || e.merged_others > 0);
  const maintTop = sortBy(verified, ([r, e]) => [-maintMonths(e.months), r])
    .slice(0, MAINT_REPOS)
    .map(([r]) => r);

  const extListed = merged.nodes.filter((n) => isExternal(n, login)).length;
  let mergedExternal: number;
  if (merged.complete) mergedExternal = extListed;
  else {
    mergedExternal = merged.nodes.length ? pyRound((extListed / merged.nodes.length) * merged.total) : 0;
    notes.push(`prs_merged_external extrapolated from ${merged.nodes.length}/${merged.total} listed merged PRs`);
  }

  const candidates = new Set<string>([...u.pushed, ...u.starred]);
  for (const src of [contribs.commits, contribs.prs, contribs.reviews]) for (const r of Object.keys(src)) candidates.add(r);
  for (const n of merged.nodes) candidates.add(n.repository.nameWithOwner);
  for (const r of maintTop) candidates.add(r);

  ctx.log(`  repo metadata for ${candidates.size} candidates`);
  const metaByReq = await fetchRepoMeta(ctx.http, [...candidates].sort());
  const canon: Record<string, RepoMeta> = {};
  const alias: Record<string, string> = {};
  for (const [req, m] of metaByReq) {
    if (!m || m.isPrivate) continue;
    canon[m.nameWithOwner] = m;
    alias[req] = m.nameWithOwner;
  }
  const dropped = [...candidates].filter((r) => !(r in alias)).sort();
  if (dropped.length) notes.push(`dropped ${dropped.length} unresolvable/private candidate repos: ${dropped.slice(0, 10).join(", ")}`);

  const cgCommits = rekey(contribs.commits, alias);
  const cgPrs = rekey(contribs.prs, alias);
  const cgReviews = rekey(contribs.reviews, alias);

  // maintainer evidence onto canonical names: strongest role, summed months/merges over all GH Archive names
  const maintAll: Record<string, MaintRaw> = {};
  for (const [r, e] of Object.entries(maintRaw ?? {})) {
    const to = alias[r];
    if (to === undefined) continue;
    const c = (maintAll[to] ??= { role: null, months: {}, merged_others: 0 });
    if ((ROLE_RANK[e.role ?? ""] ?? 0) > (ROLE_RANK[c.role ?? ""] ?? 0)) c.role = e.role;
    for (const [mk, n] of Object.entries(e.months)) c.months[mk] = (c.months[mk] ?? 0) + n;
    c.merged_others += e.merged_others;
  }
  const maint: Record<string, MaintRaw> = {};
  for (const [r, c] of Object.entries(maintAll)) {
    // merging others' PRs needs write access
    if (c.role || c.merged_others > 0) maint[r] = { ...c, role: c.role || "COLLABORATOR" };
  }
  const maintSignal = sortBy(Object.keys(maint), (r) => [-maintMonths(maint[r].months), r]).slice(0, MAINT_SIGNAL_REPOS);

  const listed: Record<string, number> = {};
  const prRepos = new Set(Object.keys(cgPrs));
  for (const n of merged.nodes) {
    const r = alias[n.repository.nameWithOwner];
    if (r === undefined) continue;
    prRepos.add(r);
    listed[r] = (listed[r] ?? 0) + 1;
  }
  const searched = sortBy([...prRepos].sort(), (r) => [
    -prSamplePriority(canon[r], r in cgPrs ? sumValues(cgPrs[r]) : 0, listed[r] ?? 0),
    "",
  ]).slice(0, PR_SAMPLE_REPOS);

  const kinds: Record<string, string> = {};
  for (const [r, m] of Object.entries(canon) as [string, Meta][]) kinds[r] = repoKind(r, login, m.description, m.object?.entries);

  return { canon, alias, dropped, cgCommits, cgPrs, cgReviews, maintAll, maint, maintSignal, kinds, searched, mergedExternal, notes };
}

export async function runPrSamples(ctx: PhaseContext): Promise<PrSamplesOut> {
  const { login } = await ctx.get<UserOut>("user");
  const merged = await ctx.get<MergedPrsOut>("merged_prs");
  const { alias, searched } = await ctx.get<RepoMetaOut>("repo_meta");
  if (merged.complete) {
    // the full merged list is known: per-repo samples are its repo slices, no extra queries
    ctx.log(`  per-repo merged PRs from the full list (${merged.nodes.length} PRs) for ${searched.length} repos`);
    const out: PrSamplesOut = {};
    for (const r of searched) {
      const nodes = merged.nodes.filter((n) => alias[n.repository.nameWithOwner] === r);
      out[r] = { issueCount: nodes.length, nodes };
    }
    return out;
  }
  ctx.log(`  per-repo merged PR search for ${searched.length} repos (merged list incomplete: ${merged.nodes.length}/${merged.total})`);
  return Object.fromEntries(await fetchRepoPrSamples(ctx.http, login, searched));
}

export async function runPrDetails(ctx: PhaseContext): Promise<PrDetailsOut> {
  const merged = await ctx.get<MergedPrsOut>("merged_prs");
  const { alias, canon } = await ctx.get<RepoMetaOut>("repo_meta");
  const prSamples = await ctx.get<PrSamplesOut>("pr_samples");
  // merged PRs per repo: from the global list, extended by per-repo samples
  const prsByRepo: Record<string, Record<string, MergedPrNode>> = {};
  for (const n of merged.nodes) {
    const r = alias[n.repository.nameWithOwner];
    if (r !== undefined) (prsByRepo[r] ??= {})[n.number] = n;
  }
  for (const [r, s] of Object.entries(prSamples)) {
    for (const n of s?.nodes ?? []) {
      if (!n) continue;
      const prs = (prsByRepo[r] ??= {});
      if (!(n.number in prs)) prs[n.number] = n;
    }
  }
  // detail sample: prioritize by repo stars, spread across repos first
  const order = sortBy(Object.keys(prsByRepo), (r) => [-canon[r].stargazerCount, ""]);
  const queues = new Map(order.map((r) => [r, Object.values(prsByRepo[r]).map((n) => n.number).sort((a, b) => b - a)]));
  const picked: [string, number][] = [];
  for (const perRepo of [PR_DETAIL_PER_REPO_FIRST_PASS, null]) {
    for (const r of order) {
      const q = queues.get(r)!;
      const take = perRepo === null ? [...q] : q.slice(0, perRepo);
      for (const num of take) {
        if (picked.length >= PR_DETAIL_CAP) break;
        picked.push([r, num]);
        q.splice(q.indexOf(num), 1);
      }
    }
  }
  ctx.log(`  PR details for ${picked.length} PRs`);
  const details = Object.fromEntries(await fetchPrDetails(ctx.http, picked));
  return { prsByRepo, details };
}

/** merged_by_repo: the per-repo search count when sampled, else the PR nodes seen. */
function mergedByRepo(prsByRepo: PrDetailsOut["prsByRepo"], prSamples: PrSamplesOut): Record<string, number> {
  return Object.fromEntries(
    Object.entries(prsByRepo).map(([r, nodes]) => [r, prSamples[r] ? prSamples[r].issueCount : Object.keys(nodes).length]),
  );
}

export async function runMutualMergers(ctx: PhaseContext): Promise<MutualMergersOut> {
  const { login } = await ctx.get<UserOut>("user");
  const { canon } = await ctx.get<RepoMetaOut>("repo_meta");
  const prSamples = await ctx.get<PrSamplesOut>("pr_samples");
  const { prsByRepo } = await ctx.get<PrDetailsOut>("pr_details");
  // contract v8: who merged the user's PRs; reciprocity of the top external repos' mergers
  const mergers = Object.fromEntries(Object.entries(prsByRepo).map(([r, prs]) => [r, prMergers(prs, login)]));
  const external: Record<string, Record<string, number>> = {};
  for (const [r, mg] of Object.entries(mergers)) if (mg && !owns(canon[r], login)) external[r] = mg;
  const pairs = mutualMergerPairs(external, mergedByRepo(prsByRepo, prSamples));
  ctx.log(`  mutual-merger check for ${pairs.length} mergers`);
  const mutual = await fetchMutualMergers(ctx.http, login, pairs);
  const mutualByRepo: Record<string, string[]> = {};
  for (const [r, mg] of pairs) {
    const ok = mutual.get(`${r}#${mg}`);
    if (ok === undefined) continue;
    const list = (mutualByRepo[r] ??= []);
    if (ok) list.push(mg);
  }
  return { mergers, mutualByRepo };
}

/** Everything the priority/per-repo phases derive from the earlier outputs. */
async function repoContext(ctx: PhaseContext) {
  const user = await ctx.get<UserOut>("user");
  const meta = await ctx.get<RepoMetaOut>("repo_meta");
  const prSamples = await ctx.get<PrSamplesOut>("pr_samples");
  const prDetails = await ctx.get<PrDetailsOut>("pr_details");
  const login = user.login;
  const graphCommits = Object.fromEntries(Object.entries(meta.cgCommits).map(([r, months]) => [r, sumValues(months)]));
  const merged = mergedByRepo(prDetails.prsByRepo, prSamples);
  // lower bound before history: graph commits (recent years only), merged PRs (each lands
  // >= 1 commit), 1 if owned
  const knownCommits = (r: string, m: RepoMeta) => Math.max(graphCommits[r] ?? 0, merged[r] ?? 0, owns(m, login) ? 1 : 0);
  return { user, login, meta, prSamples, prDetails, graphCommits, knownCommits };
}

export async function runHistories(ctx: PhaseContext): Promise<HistoriesOut> {
  const { user, meta, knownCommits } = await repoContext(ctx);
  // history only for the top HISTORY_REPOS by priority
  const pre: Record<string, number> = {};
  for (const [r, m] of Object.entries(meta.canon)) if (!m.isFork) pre[r] = repoPriority(m, knownCommits(r, m));
  const histRepos = sortBy(Object.keys(pre), (r) => [-pre[r], r])
    .filter((r) => pre[r] > 0)
    .slice(0, HISTORY_REPOS);
  ctx.log(`  commit history (GraphQL) for ${histRepos.length} of ${Object.keys(pre).length} repos`);
  return fetchCommitHistories(ctx.http, user.id, histRepos);
}

/** signals cursor: the finished signal query results and each repo's dependents. */
interface SignalsCursor {
  signals: SignalsOut["signals"] | null;
  dependents: SignalsOut["dependents"];
}

export async function runSignals(ctx: PhaseContext): Promise<SignalsOut> {
  const { login, meta, knownCommits } = await repoContext(ctx);
  const histories = await ctx.get<HistoriesOut>("histories");
  const { canon } = meta;
  const prio: Record<string, number> = {};
  for (const [r, m] of Object.entries(canon)) {
    if (!m.isFork) prio[r] = repoPriority(m, Math.max(knownCommits(r, m), histories[r]?.total ?? 0));
  }
  const ranked = sortBy(Object.keys(prio), (r) => [-prio[r], r]).filter((r) => prio[r] > 0);
  // contract v11: the top MAINT_SIGNAL_REPOS maintainer repos always get importance signals
  const signalSet = new Set([...ranked.slice(0, SIGNAL_REPOS), ...meta.maintSignal.filter((r) => !canon[r].isFork)]);
  const top = [...signalSet].sort();
  ctx.log(`  repo signals for ${top.length} repos, dependents via ecosyste.ms`);
  // resumable: a cached rerun still re-reads every ecosyste.ms answer (tens of MB for big
  // monorepos), which can alone outlast a step, so finished work is kept in the cursor
  const prior = ctx.state.cursor as SignalsCursor | null;
  const cursor: SignalsCursor = { signals: prior?.signals ?? null, dependents: { ...prior?.dependents } };
  const [signals, dependents] = await Promise.all([
    (async () => {
      cursor.signals ??= Object.fromEntries(await fetchRepoSignals(ctx.http, login, top));
      ctx.saveCursor(cursor);
      return cursor.signals;
    })(),
    fetchDependents(ctx.http, top, cursor.dependents, (r, value) => {
      cursor.dependents[r] = value;
      ctx.saveCursor(cursor);
    }),
  ]);
  return {
    signalSet: top,
    contribSet: ranked.slice(0, CONTRIB_REPOS).sort(),
    sampleSet: ranked.slice(0, COMMIT_SAMPLE_REPOS).sort(),
    signals,
    dependents,
  };
}

/** per_repo cursor: the network results of the repos done so far. */
interface PerRepoCursor {
  cs: Record<string, ContribStanding>;
  sample: Record<string, SampleCommit[]>;
}

export async function runPerRepo(ctx: PhaseContext): Promise<PerRepoOut> {
  const { user, login, meta, prDetails, graphCommits } = await repoContext(ctx);
  const histories = await ctx.get<HistoriesOut>("histories");
  const { mergers } = await ctx.get<MutualMergersOut>("mutual_mergers");
  const sig = await ctx.get<SignalsOut>("signals");
  const { canon, cgCommits, cgPrs, cgReviews } = meta;
  const { prsByRepo } = prDetails;
  const names = new Set([login, user.name || ""].map((n) => n.trim().toLowerCase()).filter(Boolean));
  const contribSet = new Set(sig.contribSet);
  const sampleSet = new Set(sig.sampleSet);
  const since = heatSince(ctx.state.startedAt);
  const prior = ctx.state.cursor as PerRepoCursor | null;
  const cursor: PerRepoCursor = { cs: { ...prior?.cs }, sample: { ...prior?.sample } };
  ctx.log(`  contributors for ${contribSet.size} repos, commit diff sample for ${sampleSet.size} repos`);

  const perRepo = async (r: string): Promise<PerRepoExtra> => {
    const m = canon[r];
    const owned = owns(m, login);
    const h = histories[r] ?? null;
    let cs = NO_STANDING;
    if (contribSet.has(r)) {
      if (!cursor.cs[r]) {
        const indep = owned ? [] : Object.keys(mergers[r] ?? {}).filter((k) => !k.startsWith("["));
        cursor.cs[r] = await contributorsCommits(ctx.http, r, login, names, indep);
        ctx.saveCursor(cursor);
      }
      cs = cursor.cs[r];
    }
    const cgSum = graphCommits[r] ?? 0;
    // user_commits = max over the known counts (contract v6); first key wins ties
    const counts: [string, number | null][] = [
      ["contrib_graph", cgSum > 0 ? cgSum : null],
      ["history", h ? h.total : null],
      ["contributors", cs.uc],
    ];
    let src: string | null = null;
    let uc: number | null = null;
    for (const [k, v] of counts) {
      if (v !== null && (uc === null || v > uc)) [src, uc] = [k, v];
    }
    if (uc === 0 && Object.keys(prsByRepo[r] ?? {}).length > 0) {
      // merged PRs but no linked commits: commits under an email GitHub can't link -> unknown
      uc = src = null;
    }
    const months = new Set<string>(Object.keys(cgCommits[r] ?? {}));
    for (const c of h?.nodes ?? []) if (c.date) months.add(monthKey(c.date));
    for (const mk of Object.keys(cgPrs[r] ?? {})) months.add(mk);
    for (const p of Object.values(prsByRepo[r] ?? {})) months.add(monthKey(p.createdAt));
    let sample: SampleCommit[] | null = null;
    if (h && sampleSet.has(r)) {
      if (!cursor.sample[r]) {
        cursor.sample[r] = await commitHeat(ctx.http, r, await sampleCommits(ctx.http, r, h.nodes), since);
        ctx.saveCursor(cursor);
      }
      sample = cursor.sample[r];
    }
    const codeByYear: Record<string, number> = {};
    for (const mk of months) codeByYear[mk.slice(0, 4)] = (codeByYear[mk.slice(0, 4)] ?? 0) + 1;
    const revByYear: Record<string, number> = {};
    for (const [mk, c] of Object.entries(cgReviews[r] ?? {})) revByYear[mk.slice(0, 4)] = (revByYear[mk.slice(0, 4)] ?? 0) + c;
    return {
      uc,
      src,
      cg: cgSum,
      months: [...months].sort(),
      owned,
      rank: cs.rank,
      ctotal: cs.total,
      top: cs.top,
      standing: cs.standing,
      code_months_by_year: sortedKeys(codeByYear),
      reviews_by_year: sortedKeys(revByYear),
      sizes: h ? h.sizes : null,
      sample,
    };
  };
  const repos = Object.keys(canon);
  const extras = await pool(repos, PER_REPO_WORKERS, perRepo);
  return Object.fromEntries(repos.map((r, i) => [r, extras[i]]));
}

export async function runOwnerTypes(ctx: PhaseContext): Promise<OwnerTypesOut> {
  const { canon } = await ctx.get<RepoMetaOut>("repo_meta");
  return ownerTypes(ctx.http, [...new Set(Object.values(canon).map((m) => m.owner.login))].sort());
}

/**
 * Contract fields the collector does not collect: never scored, never used for selection
 * (parseDeveloper reads them as null / false).
 */
type Uncollected = "archived" | "primary_language" | "issues_total" | "prs_total" | "created_at" | "review_depth" | "dependent_repos";

/** One output repo record: the v15 contract fields it collects plus the extras collect.py writes. */
export interface AssembledRepo extends Omit<Repo, Uncollected> {
  maint_events_by_year: Record<string, number> | null;
  user_additions: number | null;
  user_deletions: number | null;
  recent_months: number | null;
  user_commits_source: string | null;
  user_commits_contrib_graph: number | null;
  pr_kinds_sample: number;
  pr_detail_sample: number;
  additions_estimated: boolean;
  description: string | null;
}

/** The collector's output: Developer plus the extras collect.py writes. */
export type CollectedDeveloper = Omit<Developer, "repos" | "ext_prs"> & {
  repos: AssembledRepo[];
  ext_prs: CollectedExtPr[] | null;
  prs_closed_unmerged_external: number;
  notes: string[];
};

/**
 * collect()'s repos list (without star_history), sorted by (-stars, name): every canonical repo
 * with any evidence of contribution, from the per-repo phases' outputs.
 */
async function assembleRepos(ctx: PhaseContext): Promise<Omit<AssembledRepo, "star_history">[]> {
  const { meta, prSamples, prDetails } = await repoContext(ctx);
  const { maint: maintRaw } = await ctx.get<GapFillOut>("gap_fill");
  const { mergers, mutualByRepo } = await ctx.get<MutualMergersOut>("mutual_mergers");
  const { signals, dependents } = await ctx.get<SignalsOut>("signals");
  const extra = await ctx.get<PerRepoOut>("per_repo");
  const org = await ctx.get<OwnerTypesOut>("owner_types");
  const { canon, kinds, maint, maintAll, cgCommits } = meta;
  const { prsByRepo, details } = prDetails;
  const recent = recentFrom(ctx.state.startedAt);

  const repos: Omit<AssembledRepo, "star_history">[] = [];
  for (const [r, m] of Object.entries(canon) as [string, Meta][]) {
    const e = extra[r];
    const sample = prSamples[r];
    const prs = prsByRepo[r] ?? {};
    const nMerged = sample ? sample.issueCount : Object.keys(prs).length;
    const kind = kindWithEvidence(kinds[r], r, e.sample);
    let prKinds: Record<string, number> = { core: 0, test: 0, docs: 0, site: 0, chore: 0, merge: 0, data: 0 };
    let adds = 0;
    let dels = 0;
    let nDetail = 0;
    const substance: number[] = [];
    for (const [num, p] of Object.entries(prs)) {
      const d = details[`${r}#${num}`];
      const k = classifyPr(p.title, d ? d.files : null, kind);
      prKinds[k] += 1;
      if (d) {
        adds += d.additions;
        dels += d.deletions;
        nDetail += 1;
        substance.push(d.substance);
      }
    }
    const nClassified = sumValues(prKinds);
    if (nClassified && nMerged > nClassified) prKinds = scaleCounts(prKinds, nMerged);
    let userAdd: number | null;
    let userDel: number | null;
    let additionsEstimated = false;
    if (nMerged === 0) userAdd = userDel = 0;
    else if (nDetail === 0) userAdd = userDel = null;
    else {
      const scale = nMerged / nDetail;
      userAdd = pyRound(adds * scale);
      userDel = pyRound(dels * scale);
      additionsEstimated = nDetail < nMerged;
    }
    const mt = maint[r];
    if (e.uc === null && !e.months.length && nMerged === 0 && !e.owned && !Object.keys(e.reviews_by_year).length && !mt) {
      continue; // no evidence of any contribution
    }
    let maintMonthsByYear: Record<string, number> | null = null;
    let maintEventsByYear: Record<string, number> | null = null;
    if (mt) {
      const mm: Record<string, number> = {};
      const me: Record<string, number> = {};
      for (const [mk, c] of Object.entries(mt.months)) {
        const y = mk.slice(0, 4);
        me[y] = (me[y] ?? 0) + c;
        mm[y] = (mm[y] ?? 0) + (c >= MAINT_MONTH_MIN ? 1 : 0);
      }
      maintMonthsByYear = sortedKeys(mm);
      maintEventsByYear = sortedKeys(me);
    }
    const months = e.months;
    const hist = m.defaultBranchRef?.target?.history;
    const root = m.object?.entries;
    const sig = signals[r] ?? {};
    const dep = dependents[r] ?? [null, null];
    repos.push({
      name: r,
      owned: e.owned,
      is_fork: m.isFork,
      kind,
      stars: m.stargazerCount,
      forks: m.forkCount,
      repo_total_commits: hist ? hist.totalCount : null,
      pr_batch_share: prBatchShare(Object.values(prs)),
      // contract v10: engineering quality and scale evidence (null = unknown)
      releases_total: m.releases?.totalCount ?? null,
      has_ci: hasCi(root, m.workflows?.entries),
      has_tests: hasTests(root),
      issue_authors: sig.issue_authors ?? null,
      dependents: dep[0],
      last_push_at: m.pushedAt ?? null,
      // contract v11: maintainer track (GH Archive; null = no verified role or unknown)
      maint_role: mt ? mt.role : null,
      maint_months_by_year: maintMonthsByYear,
      maint_events_by_year: maintEventsByYear,
      merged_others: maintRaw !== null ? (maintAll[r]?.merged_others ?? 0) : null,
      user_commits: e.uc,
      user_merged_prs: nMerged,
      user_additions: userAdd,
      user_deletions: userDel,
      pr_kinds: prKinds as unknown as Repo["pr_kinds"],
      first_contrib_at: months.length ? monthStart(months[0]) : null,
      last_contrib_at: months.length ? monthEnd(months[months.length - 1]) : null,
      active_months: months.length ? months.length : null,
      // distinct active months within the 24 months before collection
      recent_months: months.length ? months.filter((x) => x >= recent).length : null,
      code_months_by_year: e.code_months_by_year,
      reviews_by_year: e.reviews_by_year,
      pr_substance: nDetail ? [...substance].sort((a, b) => b - a) : null,
      commit_sizes: e.sizes,
      commit_merge_share: e.sizes?.length ? e.sizes.filter((c) => c.merge).length / e.sizes.length : null,
      commit_sample: e.sample,
      user_rank: e.rank,
      // /contributors refuses huge repos: GitHub's mentionable users stand in
      contributors_total: e.ctotal !== null ? e.ctotal : (m.mentionableUsers?.totalCount ?? null),
      top_contributor_commits: e.top,
      owner_is_org: org[m.owner.login] ?? null,
      pr_mergers: mergers[r] ?? null,
      mutual_mergers: mutualByRepo[r] ?? null,
      merger_standing: e.standing,
      // extras (not in the core contract; the scorer ignores unknown fields)
      user_commits_source: e.src,
      user_commits_contrib_graph: r in cgCommits ? e.cg : null,
      pr_kinds_sample: nClassified,
      pr_detail_sample: nDetail,
      additions_estimated: additionsEstimated,
      description: m.description ?? null,
    });
  }
  return sortBy(repos, (x) => [-(x.stars ?? 0), x.name]);
}

export async function runStarHistory(ctx: PhaseContext): Promise<StarHistoryOut> {
  // contract v15: weekly star gains of the owned/led top repos, only where rule F's F4 spike
  // can decide the hype verdict (hypeNeedsStarHistory); every other repo's history is null
  const repos = await assembleRepos(ctx);
  const now = fractionalYear(ctx.state.startedAt);
  const byName = new Map(repos.map((r) => [r.name, r]));
  const candidates = starHistoryCandidates(repos).filter((r) => hypeNeedsStarHistory(byName.get(r)!, now));
  ctx.log(`  star history for ${candidates.length} repos`);
  const res = await pool(candidates, STAR_WORKERS, (r) => fetchStarHistory(ctx.http, r));
  return { candidates, history: Object.fromEntries(candidates.map((r, i) => [r, res[i]])) };
}

/**
 * fetch_ext_prs: the `merged_prs` scan's ext window, closed_by and sizes only when the slop
 * rule can use them (slopNeedsClosers; read by the `rejected` phase) and reviewers only for
 * MERGED PRs of repos where rule H1 can apply (unreviewedCandidate over the assembled repos).
 * Everything else stays null.
 */
export async function runExtPrs(ctx: PhaseContext): Promise<ExtPrsOut> {
  const { login } = await ctx.get<UserOut>("user");
  const { ext } = await ctx.get<MergedPrsOut>("merged_prs");
  const { ids, complete } = ext;
  const prs = ext.prs.map((x) => ({ ...x }));
  if (slopNeedsClosers(prs)) {
    const { closers, sizes } = await ctx.get<RejectedOut>("rejected");
    prs.forEach((x, i) => {
      if (x.state === "CLOSED") x.closed_by = closers[ids[i]] ?? null;
      const s = sizes[ids[i]];
      if (s) [x.additions, x.deletions, x.changed_files] = s;
    });
  }
  const h1 = (await assembleRepos(ctx)).filter((r) => unreviewedCandidate(r, prs)).map((r) => r.name);
  const merged = prs.flatMap((x, i) => (x.state === "MERGED" && h1.some((r) => eqlIgnoreCase(r, x.repo)) ? [i] : []));
  if (merged.length) {
    ctx.log(`  reviewers for ${merged.length} merged PRs in ${h1.length} repos`);
    const reviewers = await fetchReviewers(ctx.http, login, merged.map((i) => ids[i]));
    for (const i of merged) prs[i].reviewers = reviewers.get(ids[i]) ?? null;
  }
  return { prs, complete };
}

export async function runAssemble(ctx: PhaseContext): Promise<CollectedDeveloper> {
  const user = await ctx.get<UserOut>("user");
  const gap = await ctx.get<GapFillOut>("gap_fill");
  const merged = await ctx.get<MergedPrsOut>("merged_prs");
  const meta = await ctx.get<RepoMetaOut>("repo_meta");
  const stars = await ctx.get<StarHistoryOut>("star_history");
  const { closedExt, scanned, byOther } = await ctx.get<RejectedOut>("rejected");
  const ext = await ctx.get<ExtPrsOut>("ext_prs");
  const repos: AssembledRepo[] = (await assembleRepos(ctx)).map((x) => ({ ...x, star_history: stars.history[x.name] ?? null }));

  const notes = [...meta.notes];
  let rejected: number | null;
  if (scanned === closedExt) rejected = byOther;
  else {
    rejected = scanned ? pyRound((byOther * closedExt) / scanned) : null;
    notes.push(`prs_rejected_by_maintainer extrapolated from ${scanned}/${closedExt} closed-unmerged PRs`);
  }
  const heat = heatSince(ctx.state.startedAt);
  notes.push(
    "prs_rejected_by_maintainer = closed-unmerged PRs to repos not owned by the user whose last " +
      "ClosedEvent actor is not the author (ghost/unknown actor counts as maintainer)",
    "user_commits: max of the monthly contributionsCollection commit counts over ALL contribution " +
      "years, the GraphQL default-branch history totalCount (author = user id) and REST /contributors " +
      `page 1 (top ${CONTRIB_REPOS} repos only; anonymous entries named like the login/profile name ` +
      "are added to the login's count); excludes commits GitHub could not link to the account",
    `user_additions/deletions: summed from up to ${PR_DETAIL_CAP} detailed merged PRs per user, ` +
      "scaled to user_merged_prs when sampled (additions_estimated=true)",
    "first/last_contrib_at are month granularity (contribution graph months, PR creation months, " +
      `GraphQL history commit dates of up to ${HISTORY_PAGES * 100} commits)`,
    "adoption: forks, contributors_total, issue_authors (last 50 issues), dependents (ecosyste.ms, " +
      `by repository_url and same-owner package names) for the top ${SIGNAL_REPOS} repos; package ` +
      "downloads, release downloads, Docker pulls and Homebrew installs are not collected",
    starHistoryNote(stars.candidates.length),
    "user_rank / contributors_total: REST /contributors?anon=1 page 1 (users + anonymous emails) " +
      `for the top ${CONTRIB_REPOS} repos by priority; rank = position of the first matched entry ` +
      "in the first 100 (null beyond), total from the Link rel=last page; null when not fetched or " +
      "the endpoint fails (e.g. 403 on huge repos)",
    "maint_*: GH Archive github_events via ClickHouse play (not GitHub quota); maintainer events = PR " +
      "reviews, issue/PR review comments, others' PRs merged by the user, issues closed; role = strongest " +
      "author_association (only recorded 2017-01..2025-10, NONE outside) or COLLABORATOR when the user " +
      "merged others' PRs (merged_by empty after 2025-10; from 2025-12 'merged' events by the user on " +
      "PRs they did not open count); up to " +
      `${MAINT_REPOS} verified repos added as candidates, top ${MAINT_SIGNAL_REPOS} get adoption signals` +
      (gap.maint !== null ? "" : "; ClickHouse query FAILED: maint_* and merged_others unknown"),
    gapNote(gap.info),
    `merged PRs, closed-unmerged PRs (rejected_by_maintainer) and ext_prs come from one user.pullRequests ` +
      `pass (all states, ≤ ${PR_SCAN_REQUESTS} pages of 100); each list is cut where its own per-state scan would ` +
      "stop, closers read by node id; a list the page cap leaves undecided is marked incomplete",
    `commit_sample heat: share of default-branch commits since ${heat.slice(0, 10)} touching the ` +
      "commit's busiest core area (directory truncated to 2 path components)",
    `ext_prs: the user's PRs to repos they do not own created since ${extPrSince(ctx.state.startedAt).slice(0, 10)}, newest first, ` +
      `≤ ${EXT_PR_CAP}, from ≤ ${EXT_PR_PAGES} pages of 100 of user.pullRequests (all states); closed_by and ` +
      "additions/deletions/changed_files only when rule A can use them (≥ slop rej_min CLOSED PRs, else null), " +
      "reviewers only on MERGED PRs of repos rule H1 can apply to (not owned, few contributors, ≥ unrev_min_prs " +
      "merged PRs, else null)" +
      (ext.complete ? "" : "; list INCOMPLETE (page cap or a failing page)"),
  );

  return {
    login: user.login,
    collected_at: ctx.state.startedAt,
    repos,
    prs_rejected_by_maintainer: rejected,
    prs_merged_total: merged.total,
    // extras
    prs_merged_external: meta.mergedExternal,
    prs_closed_unmerged_external: closedExt,
    // contract v12 (null = unknown): influencer/slop detector inputs
    followers: user.followers,
    ext_prs: ext.prs,
    notes,
  };
}
