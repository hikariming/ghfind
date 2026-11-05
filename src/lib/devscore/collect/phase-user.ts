/**
 * User-level phases of the devscore collector (port of collect.py fetch_user,
 * fetch_monthly_contribs, fetch_user_prs, rejected_by_maintainer) and the fetchers of
 * fetch_ext_prs (one PR-list scan for merged/rejected/ext windows, PR details by node id;
 * the `ext_prs` phase itself is in phase-repos).
 */
import { slopNeedsClosers } from "../engine/slop";
import type { PhaseContext } from "./index";
import { ApiError, chunks, GQL_CONCURRENCY, monthEnd, monthStart, pool, type Http } from "./http";
import type { CollectedExtPr, ContribsOut, MergedPrNode, MergedPrsOut, RejectedOut, RepoMonths, UserOut } from "./outputs";

export const OWN_REPO_CAP = 30;
// Windows of the one PR-list scan, in the page units of collect.py's per-state scans (scanUserPrs):
/** merged list: pages of 100 of the user's merged PRs (newest first) */
export const MERGED_PR_PAGES = 20;
/** rejected: closed-unmerged external PRs scanned for closer identity */
export const REJECTED_SCAN_CAP = 300;
/** rejected: pages of 50 closed-unmerged PRs at most */
export const REJECTED_PAGES = 20;
/** contract v12: ext_prs = the user's PRs to repos they do not own created since extPrSince, at most EXT_PR_CAP */
export const EXT_PR_CAP = 500;
export const EXT_PR_PAGES = 10;
/** requests of 100 the one PR-list scan makes at most (a partial-size retry counts its share) */
export const PR_SCAN_REQUESTS = 40;
const MERGED_BY = "mergedBy { login __typename }";

/** EXT_PR_SINCE: the collection date 24 months back, "YYYY-MM-DDT00:00:00Z" (no calendar check, like Python). */
export function extPrSince(startedAt: string): string {
  return `${Number(startedAt.slice(0, 4)) - 2}${startedAt.slice(4, 10)}T00:00:00Z`;
}

/** _external: PR node to a repo not owned by the user (repository { owner { login } }). */
export function isExternal(node: { repository?: { owner?: { login?: string | null } | null } | null }, login: string): boolean {
  return (node.repository?.owner?.login ?? "").toLowerCase() !== login.toLowerCase();
}

/** Python round(): half to even (exported for repo_meta / per_repo extrapolations). */
export function pyRound(x: number): number {
  return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : Math.round(x);
}

// ---------------------------------------------------------------- user

interface GqlUser {
  id: string;
  login: string;
  name: string | null;
  followers: { totalCount: number } | null;
  contributionsCollection: { contributionYears: number[] };
  pushed: { nodes: { nameWithOwner: string }[] };
  starred: { nodes: { nameWithOwner: string }[] };
}

export async function runUser(ctx: PhaseContext): Promise<UserOut> {
  const q = `query($login: String!) { user(login: $login) {
      id login name followers { totalCount }
      contributionsCollection { contributionYears }
      pushed: repositories(first: ${OWN_REPO_CAP}, ownerAffiliations: OWNER, isFork: false,
                           orderBy: {field: PUSHED_AT, direction: DESC}) { nodes { nameWithOwner } }
      starred: repositories(first: ${OWN_REPO_CAP}, ownerAffiliations: OWNER, isFork: false,
                            orderBy: {field: STARGAZERS, direction: DESC}) { nodes { nameWithOwner } }
    } }`;
  const u = (await ctx.http.graphql<{ user: GqlUser | null }>(q, { login: ctx.state.login })).user;
  if (!u) throw new Error(`user ${ctx.state.login} not found`);
  return {
    id: u.id,
    login: u.login,
    name: u.name,
    followers: u.followers?.totalCount ?? null,
    contributionYears: u.contributionsCollection.contributionYears,
    pushed: u.pushed.nodes.map((n) => n.nameWithOwner),
    starred: u.starred.nodes.map((n) => n.nameWithOwner),
  };
}

// ---------------------------------------------------------------- monthly contributions

type ByRepo = { contributions: { totalCount: number }; repository: { nameWithOwner: string } | null }[];
interface MonthCC {
  commitContributionsByRepository: ByRepo;
  pullRequestContributionsByRepository: ByRepo;
  pullRequestReviewContributionsByRepository: ByRepo;
}

/** One year of fetch_monthly_contribs, already folded (merging years in order gives Python's maps and key order). */
export interface ContribYear {
  commits: RepoMonths;
  prs: RepoMonths;
  reviews: RepoMonths;
}

const CONTRIB_FRAG = `fragment RC on ContributionsCollection {
      commitContributionsByRepository(maxRepositories: 100) {
        contributions { totalCount } repository { nameWithOwner } }
      pullRequestContributionsByRepository(maxRepositories: 100) {
        contributions { totalCount } repository { nameWithOwner } }
      pullRequestReviewContributionsByRepository(maxRepositories: 100) {
        contributions { totalCount } repository { nameWithOwner } } }`;

function addMonth(sink: RepoMonths, repo: string, month: string, n: number): void {
  const months = (sink[repo] ??= {});
  months[month] = (months[month] ?? 0) + n;
}

/**
 * One contribution year: one aliased contributionsCollection per month (months up to `now`,
 * "YYYY-MM"), halving the batch on API errors; a month that keeps failing is left out.
 */
export async function fetchContribYear(http: Http, login: string, year: number, now: string): Promise<ContribYear> {
  const run = async (months: string[]): Promise<Map<string, MonthCC | null>> => {
    const decl = months.map((_, i) => `$f${i}: DateTime!, $t${i}: DateTime!`).join(", ");
    const alias = months.map((_, i) => `m${i}: contributionsCollection(from: $f${i}, to: $t${i}) { ...RC }`).join("\n");
    const vars: Record<string, unknown> = { login };
    months.forEach((m, i) => {
      vars[`f${i}`] = monthStart(m);
      vars[`t${i}`] = monthEnd(m);
    });
    const data = await http.graphql<{ user: Record<string, MonthCC | null> }>(
      `query($login: String!, ${decl}) { user(login: $login) { ${alias} } }\n${CONTRIB_FRAG}`,
      vars,
    );
    const u = data.user;
    return new Map(months.map((m, i) => [m, u[`m${i}`] ?? null]));
  };
  const wanted: string[] = [];
  for (let mo = 1; mo <= 12; mo += 1) {
    const m = `${year}-${String(mo).padStart(2, "0")}`;
    if (m <= now) wanted.push(m);
  }
  const res = await http.halving(wanted, run, `contrib ${login} ${year}`);
  const out: ContribYear = { commits: {}, prs: {}, reviews: {} };
  for (const [m, cc] of res) {
    if (!cc) continue;
    const sinks: [ByRepo, RepoMonths][] = [
      [cc.commitContributionsByRepository, out.commits],
      [cc.pullRequestContributionsByRepository, out.prs],
      [cc.pullRequestReviewContributionsByRepository, out.reviews],
    ];
    for (const [list, sink] of sinks) {
      for (const n of list) if (n.repository) addMonth(sink, n.repository.nameWithOwner, m, n.contributions.totalCount);
    }
  }
  return out;
}

/** Folds per-year results in year order into fetch_monthly_contribs' commit/PR/review maps. */
export function mergeContribYears(years: [number, ContribYear][]): ContribsOut {
  const out: ContribsOut = { commits: {}, prs: {}, reviews: {} };
  for (const [, part] of [...years].sort((a, b) => a[0] - b[0])) {
    for (const key of ["commits", "prs", "reviews"] as const) {
      for (const [repo, months] of Object.entries(part[key])) {
        for (const [m, n] of Object.entries(months)) addMonth(out[key], repo, m, n);
      }
    }
  }
  return out;
}

/** Cursor of `contribs`: the years finished so far (a step holds ~2 years of 12 aliased months). */
interface ContribsCursor {
  done: [number, ContribYear][];
}

export async function runContribs(ctx: PhaseContext): Promise<ContribsOut> {
  const user = await ctx.get<UserOut>("user");
  const now = ctx.state.startedAt.slice(0, 7);
  const prior = (ctx.state.cursor as ContribsCursor | null)?.done ?? [];
  const done = new Map<number, ContribYear>(prior);
  const todo = [...user.contributionYears].sort((a, b) => a - b).filter((y) => !done.has(y));
  await pool(todo, GQL_CONCURRENCY, async (y) => {
    done.set(y, await fetchContribYear(ctx.http, user.login, y, now));
    ctx.saveCursor({ done: [...done] } satisfies ContribsCursor);
  });
  return mergeContribYears([...done]);
}

// ---------------------------------------------------------------- the user's PR list

interface PrPage<N> {
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes?: (N | null)[];
}

/** A node of the one PR-list scan: MergedPrNode plus what the rejected and ext_prs windows need. */
interface ListNode extends MergedPrNode {
  id: string;
  state: string;
}

const LIST_FIELDS = `id number title state createdAt mergedAt ${MERGED_BY} repository { nameWithOwner owner { login } }`;

/** Where a per-state page scan stops: `take` leading nodes of the stream; `last`: the stream ended in them. */
export interface PageWindow {
  take: number;
  last: boolean;
}

/**
 * The nodes a per-state scan (pages of `pageSize`, at most `maxPages`, stopping after a page
 * once stop(nodes so far) holds, exhausted when a page ends the stream) returns on a stream of
 * which the first `seen` nodes are known; null while that depends on nodes not listed yet.
 * `ended`: no more nodes will come; `total`: the stream's totalCount.
 */
export function pageWindow(
  seen: number,
  ended: boolean,
  total: number,
  pageSize: number,
  maxPages: number,
  stop?: (end: number) => boolean,
): PageWindow | null {
  for (let k = 1; k <= maxPages; k++) {
    const end = k * pageSize;
    if (seen < end) return ended || seen >= total ? { take: seen, last: true } : null;
    if (seen === end && (ended || total <= end)) return { take: end, last: true };
    if (stop?.(end)) return { take: end, last: false };
  }
  return { take: maxPages * pageSize, last: false };
}

/**
 * The user's PRs (all states), newest first, in ONE user.pullRequests pass of light fields,
 * split into the windows the per-state scans of collect.py paged (fetch_user_prs MERGED in
 * pages of 100 ≤ MERGED_PR_PAGES; rejected_by_maintainer's CLOSED in pages of 50 ≤
 * REJECTED_PAGES up to REJECTED_SCAN_CAP external; fetch_ext_prs' all-states pages of 100 ≤
 * EXT_PR_PAGES up to `since` or EXT_PR_CAP external): each window is what its own scan
 * would have returned, page granularity included. The pass stops once every window is decided
 * or the list ends, at most PR_SCAN_REQUESTS requests; a window the cap (or a failing page)
 * leaves undecided keeps what was listed and is incomplete. A failing page is retried at half
 * the size down to 1; a single PR GitHub cannot render is then stepped over (the undecided
 * windows become incomplete). Throws ApiError when not even the first page can be read.
 */
export async function scanUserPrs(http: Http, login: string, since: string): Promise<MergedPrsOut> {
  // the first request also reads the MERGED and CLOSED totals; the cursor-only form steps over a PR that fails to render
  const query = (first: boolean, cursorOnly: boolean) => `query($login: String!${cursorOnly ? "" : ", $n: Int!"}, $after: String) { user(login: $login) {
      pullRequests(states: [OPEN, CLOSED, MERGED], first: ${cursorOnly ? 1 : "$n"}, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
        totalCount pageInfo { hasNextPage endCursor }${cursorOnly ? "" : ` nodes { ${LIST_FIELDS} }`} }${
          first ? "\n      m: pullRequests(states: [MERGED]) { totalCount } c: pullRequests(states: [CLOSED]) { totalCount }" : ""
        } } }`;
  type Doc = { user: { pullRequests: PrPage<ListNode>; m?: { totalCount: number }; c?: { totalCount: number } } };
  const all: ListNode[] = [];
  const merged: ListNode[] = [];
  const closed: ListNode[] = [];
  const ext = (n: ListNode) => isExternal(n, login);
  const extDone = (ns: ListNode[]) => ns[ns.length - 1].createdAt < since || ns.filter(ext).length >= EXT_PR_CAP;
  type Slot = { win: PageWindow | null; tainted: boolean };
  const slots: Record<"merged" | "closed" | "ext", Slot> = {
    merged: { win: null, tainted: false },
    closed: { win: null, tainted: false },
    ext: { win: null, tainted: false },
  };
  const undecided = () => Object.values(slots).filter((s) => s.win === null);
  let totals = null as { all: number; merged: number; closed: number } | null;
  let after: string | null = null;
  let ended = false;
  let pages = 0;
  scan: while (pages < PR_SCAN_REQUESTS && undecided().length) {
    let n = 100;
    let doc: Doc;
    while (true) {
      try {
        doc = await http.graphql<Doc>(query(after === null, false), { login, n, after });
        break;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (n > 1) {
          n = Math.max(1, Math.floor(n / 2));
          continue;
        }
        try {
          // this one PR cannot be rendered: step over it
          doc = await http.graphql<Doc>(query(after === null, true), { login, after });
        } catch (skipError) {
          if (!(skipError instanceof ApiError) || totals === null) throw skipError;
          http.env.log?.(`  user PRs page failed after ${all.length} nodes: ${error.message}`);
          break scan;
        }
        http.env.log?.(`  user PRs: skipped 1 unreadable PR after ${all.length} nodes`);
        for (const s of undecided()) s.tainted = true;
        break;
      }
    }
    pages += n / 100;
    const c = doc.user.pullRequests;
    totals = {
      all: c.totalCount,
      merged: doc.user.m?.totalCount ?? totals?.merged ?? 0,
      closed: doc.user.c?.totalCount ?? totals?.closed ?? 0,
    };
    for (const x of c.nodes ?? []) {
      if (!x) continue;
      all.push(x);
      if (x.state === "MERGED") merged.push(x);
      else if (x.state === "CLOSED") closed.push(x);
    }
    ended = !c.pageInfo.hasNextPage;
    slots.merged.win ??= pageWindow(merged.length, ended, totals.merged, 100, MERGED_PR_PAGES);
    slots.closed.win ??= pageWindow(closed.length, ended, totals.closed, 50, REJECTED_PAGES, (end) =>
      closed.slice(0, end).filter(ext).length >= REJECTED_SCAN_CAP,
    );
    slots.ext.win ??= pageWindow(all.length, ended, totals.all, 100, EXT_PR_PAGES, (end) => extDone(all.slice(0, end)));
    after = c.pageInfo.endCursor;
  }
  if (totals === null) throw new Error("devscore collect: PR scan made no request");
  // the request cap or a failing page: undecided windows keep what was listed, incomplete
  const win = (s: Slot, seen: number) => s.win ?? { take: seen, last: false };
  const complete = (s: Slot, w: PageWindow) => w.last && !s.tainted;

  const mw = win(slots.merged, merged.length);
  const nodes = merged.slice(0, mw.take).map(({ number, title, createdAt, mergedAt, mergedBy, repository }) => ({
    number,
    title,
    createdAt,
    mergedAt,
    mergedBy,
    repository,
  }));

  const cw = win(slots.closed, closed.length);
  const closedWin = closed.slice(0, cw.take);

  const ew = win(slots.ext, all.length);
  const extWin = all.slice(0, ew.take);
  const prs: CollectedExtPr[] = [];
  const ids: string[] = [];
  for (const x of extWin) {
    if (x.createdAt < since) break;
    if (!ext(x)) continue;
    ids.push(x.id);
    prs.push({
      repo: x.repository.nameWithOwner,
      title: x.title,
      state: x.state,
      created_at: x.createdAt,
      additions: null,
      deletions: null,
      changed_files: null,
      merged_by: x.mergedBy?.login ?? null,
      closed_by: null,
      reviewers: null,
    });
    if (prs.length >= EXT_PR_CAP) break;
  }

  return {
    total: totals.merged,
    nodes,
    complete: complete(slots.merged, mw),
    closed: {
      total: totals.closed,
      listed: closedWin.length,
      ext: closedWin.filter(ext).map((x) => x.id),
      complete: complete(slots.closed, cw),
    },
    ext: { prs, ids, complete: complete(slots.ext, ew) || (extWin.length > 0 && extDone(extWin)) },
  };
}

export async function runMergedPrs(ctx: PhaseContext): Promise<MergedPrsOut> {
  const { login } = await ctx.get<UserOut>("user");
  return scanUserPrs(ctx.http, login, extPrSince(ctx.state.startedAt));
}

// ---------------------------------------------------------------- rejected / external PRs

/** The last ClosedEvent's actor of a PR node. */
const CLOSED_EVENT = "timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { actor { login } } } }";
const SIZES = "additions deletions changedFiles";

interface DetailNode {
  timelineItems?: { nodes?: ({ actor?: { login?: string | null } | null } | null)[] | null } | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

/** PR node ids per `nodes(ids:)` query. */
const NODE_BATCH = 50;

/**
 * `nodes(ids:)` for each [fields, ids] group (fields on each PullRequest), all groups' batches
 * GQL_CONCURRENCY at a time, halving failing batches; id → node (failed ids absent).
 */
async function fetchPrNodes<N>(http: Http, groups: [string, string[]][], label: string): Promise<Map<string, N | null>> {
  const parts = groups.flatMap(([fields, ids]) => chunks(ids, NODE_BATCH).map((c) => [fields, c] as const));
  const results = await pool(parts, GQL_CONCURRENCY, ([fields, ids]) =>
    http.halving(
      ids,
      async (chunk) => {
        const data = await http.graphql<{ nodes: (N | null)[] }>(
          `query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest { ${fields} } } }`,
          { ids: chunk },
        );
        return new Map(chunk.map((id, i) => [id, data.nodes[i] ?? null]));
      },
      label,
    ),
  );
  const out = new Map<string, N | null>();
  for (const part of results) for (const [k, v] of part) out.set(k, v);
  return out;
}

/**
 * rejected_by_maintainer on the scan's CLOSED window: (closed-unmerged external PRs, scanned,
 * closed by someone other than the author). The external total is exact when the window
 * holds every CLOSED PR, else extrapolated from its external share. Closers are read by node
 * id for the window's external PRs and, when rule A can use them (slopNeedsClosers), for
 * ext_prs' CLOSED entries, with ext_prs' sizes in the same pass (null elsewhere).
 */
export async function runRejected(ctx: PhaseContext): Promise<RejectedOut> {
  const { login } = await ctx.get<UserOut>("user");
  const { closed, ext } = await ctx.get<MergedPrsOut>("merged_prs");
  const closerIds = new Set(closed.ext);
  const sizeIds = new Set<string>();
  if (slopNeedsClosers(ext.prs)) {
    ext.ids.forEach((id, i) => {
      sizeIds.add(id);
      if (ext.prs[i].state === "CLOSED") closerIds.add(id);
    });
  }
  const both = [...closerIds].filter((id) => sizeIds.has(id));
  const closersOnly = [...closerIds].filter((id) => !sizeIds.has(id));
  const sizesOnly = [...sizeIds].filter((id) => !closerIds.has(id));
  ctx.log(`  closers for ${closerIds.size} closed PRs, sizes for ${sizeIds.size} ext PRs`);
  const nodes = await fetchPrNodes<DetailNode>(
    ctx.http,
    [
      [CLOSED_EVENT, closersOnly],
      [`${CLOSED_EVENT} ${SIZES}`, both],
      [SIZES, sizesOnly],
    ],
    "PR closers/sizes",
  );
  const closers: Record<string, string | null> = {};
  for (const id of closerIds) closers[id] = nodes.get(id)?.timelineItems?.nodes?.[0]?.actor?.login ?? null;
  const sizes: Record<string, [number, number, number]> = {};
  for (const id of sizeIds) {
    const n = nodes.get(id);
    if (typeof n?.additions === "number") sizes[id] = [n.additions, n.deletions ?? 0, n.changedFiles ?? 0];
  }
  const scanned = closed.ext.length;
  const closedExt = closed.complete ? scanned : closed.listed ? pyRound((scanned / closed.listed) * closed.total) : 0;
  const lo = login.toLowerCase();
  // a ghost/unknown/unreadable closer counts as someone else
  const byOther = closed.ext.filter((id) => (closers[id] ?? "").toLowerCase() !== lo).length;
  return { closedExt, scanned, byOther, closers, sizes };
}

type ReviewNode = { reviews?: { nodes?: ({ author?: { login?: string | null; __typename?: string } | null } | null)[] | null } | null };

/** Human reviewers other than `login` (first 10 reviews, deduplicated) of each PR in `ids`; unreadable PRs absent. */
export async function fetchReviewers(http: Http, login: string, ids: string[]): Promise<Map<string, string[]>> {
  const nodes = await fetchPrNodes<ReviewNode>(http, [["reviews(first: 10) { nodes { author { login __typename } } }", ids]], "PR reviewers");
  const lo = login.toLowerCase();
  const out = new Map<string, string[]>();
  for (const [id, n] of nodes) {
    const reviewers: string[] = [];
    for (const rv of n?.reviews?.nodes ?? []) {
      const a = rv?.author;
      const who = a?.login;
      if (who && a.__typename !== "Bot" && who.toLowerCase() !== lo && !reviewers.includes(who)) reviewers.push(who);
    }
    out.set(id, reviewers);
  }
  return out;
}
