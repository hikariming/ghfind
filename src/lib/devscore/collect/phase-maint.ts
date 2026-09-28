/**
 * Maintainer phases of the devscore collector (port of collect.py fetch_maintainer and the
 * contract v15 GH Archive gap fill: gap_months, gap_fill_repos, fetch_gap_closed,
 * fetch_gap_comments, fill_maint_gaps, gap_note).
 */
import type { PhaseContext } from "./index";
import { ApiError, gqlStr, monthEnd, type Http } from "./http";
import {
  GAP_BATCH,
  GAP_RATIO,
  GAP_COMMENT_PAGES,
  GAP_REPOS,
  GAP_SAMPLE,
  GAP_WINDOW,
  MAINT_TYPES,
  ROLE_RANK,
  gapSeries,
  monthAdd,
} from "./classify";
import type { ContribsOut, GapFillOut, GapInfo, MaintEvents, MaintainerOut, MaintType, RepoMonths, UserOut } from "./outputs";

// ---------------------------------------------------------------- fetch_maintainer

/**
 * Contract v11/v15: repo (GH Archive name) → role, maintainer events per month, merges of
 * others' PRs and events by family, from ClickHouse's public github_events. null when the
 * login is not a plain GitHub login or the query fails (unknown, never 0).
 */
export async function fetchMaintainer(http: Http, login: string): Promise<MaintainerOut> {
  if (!/^[A-Za-z0-9-]+$/.test(login)) return null;
  const sql = `SELECT repo_name, toYYYYMM(created_at) ym,
  countIf(event_type='PullRequestReviewEvent') reviews,
  countIf(event_type IN ('IssueCommentEvent','PullRequestReviewCommentEvent')) comments,
  countIf(event_type='PullRequestEvent' AND ((action='closed' AND merged_by='${login}' AND creator_user_login!='${login}')
    OR (action='merged' AND (repo_name, number) NOT IN (SELECT repo_name, number FROM github_events
        WHERE actor_login='${login}' AND event_type='PullRequestEvent' AND action='opened')))) merged_others,
  countIf(event_type='IssuesEvent' AND action='closed') issue_closes,
  groupUniqArrayIf(author_association, author_association IN ('OWNER','MEMBER','COLLABORATOR')) roles
FROM github_events WHERE actor_login='${login}' AND event_type IN ('PullRequestReviewEvent','IssueCommentEvent','PullRequestReviewCommentEvent','PullRequestEvent','IssuesEvent')
GROUP BY repo_name, ym FORMAT JSONEachRow`;
  const res = await http.clickhouse(sql);
  if (res.status === null || res.status < 200 || res.status >= 300) {
    http.env.log?.(`  ! maintainer events: ClickHouse query failed: ${res.body.slice(0, 200)}`);
    return null;
  }
  const out: Record<string, MaintEvents> = {};
  for (const line of res.body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      repo_name: string;
      ym: number | string;
      reviews: number | string;
      comments: number | string;
      merged_others: number | string;
      issue_closes: number | string;
      roles: string[];
    };
    const e = (out[row.repo_name] ??= { role: null, months: {}, merged_others: 0, by_type: {} });
    const ym = String(row.ym);
    const mk = `${ym.slice(0, 4)}-${ym.slice(4)}`;
    // ClickHouse JSON renders UInt64 counts as strings
    const fam: Record<MaintType, number> = {
      reviews: Number(row.reviews),
      comments: Number(row.comments),
      merged: Number(row.merged_others),
      closes: Number(row.issue_closes),
    };
    const bt = (e.by_type[mk] ??= { reviews: 0, comments: 0, merged: 0, closes: 0 });
    let sum = 0;
    for (const k of MAINT_TYPES) {
      bt[k] += fam[k];
      sum += fam[k];
    }
    e.months[mk] = (e.months[mk] ?? 0) + sum;
    e.merged_others += fam.merged;
    for (const role of row.roles) {
      if ((ROLE_RANK[role] ?? 0) > (ROLE_RANK[e.role ?? ""] ?? 0)) e.role = role;
    }
  }
  return out;
}

export async function runMaintainer(ctx: PhaseContext): Promise<MaintainerOut> {
  const { login } = await ctx.get<UserOut>("user");
  return fetchMaintainer(ctx.http, login);
}

// ---------------------------------------------------------------- gap months

/**
 * Contract v15: family → GH Archive gap months (ascending) among the complete months before
 * `until` (the collection month): all-event daily rate gaps for every family, plus
 * recorded-merge rate gaps for merges. null when the ClickHouse query fails.
 */
export async function gapMonths(http: Http, until: string): Promise<Record<MaintType, string[]> | null> {
  const sql = `SELECT toYYYYMM(created_at) ym, uniqExact(toDate(created_at)) days, count() total,
  countIf(event_type='PullRequestEvent' AND ((action='closed' AND merged_by!='') OR action='merged')) merged
FROM github_events WHERE created_at < '${until}-01' AND event_type IN ('PullRequestReviewEvent','IssueCommentEvent','PullRequestReviewCommentEvent','PullRequestEvent','IssuesEvent')
GROUP BY ym ORDER BY ym FORMAT JSONEachRow`;
  const res = await http.clickhouse(sql);
  if (res.status === null || res.status < 200 || res.status >= 300) {
    http.env.log?.(`  ! GH Archive monthly totals: ClickHouse query failed: ${res.body.slice(0, 200)}`);
    return null;
  }
  const rows = res.body
    .split(/\r?\n/)
    .filter((x) => x.trim())
    .map((x) => JSON.parse(x) as Record<string, number | string>);
  const series = (col: string) =>
    gapSeries(
      Object.fromEntries(
        rows.map((r) => {
          const ym = String(r.ym);
          return [`${ym.slice(0, 4)}-${ym.slice(4)}`, Number(r[col]) / Math.max(1, Number(r.days))];
        }),
      ),
    );
  const total = series("total");
  const merged = [...new Set([...total, ...series("merged")])].sort();
  return { reviews: total, comments: total, merged, closes: total };
}

/**
 * GH Archive names of the up to GAP_REPOS verified-role repos (a role or merges of others'
 * PRs) with maintainer events from 12 months before `firstGap` on, by events there.
 */
export function gapFillRepos(maintRaw: Record<string, MaintEvents>, firstGap: string): string[] {
  const lo = monthAdd(firstGap, -12);
  const score = new Map<string, number>();
  for (const [r, e] of Object.entries(maintRaw)) {
    if (!(e.role || e.merged_others > 0)) continue;
    let s = 0;
    for (const [m, c] of Object.entries(e.months)) if (lo <= m) s += c;
    if (s > 0) score.set(r, s);
  }
  return [...score.keys()]
    .sort((a, b) => score.get(b)! - score.get(a)! || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, GAP_REPOS);
}

interface GapSearch {
  issueCount: number;
  nodes: ({
    merged?: boolean;
    author?: { login?: string | null } | null;
    mergedBy?: { login?: string | null } | null;
    timelineItems?: { nodes: ({ actor?: { login?: string | null } | null } | null)[] };
  } | null)[];
}

export interface GapClosed {
  merged: number;
  closes: number;
  complete: boolean;
}

/**
 * "repo#YYYY-MM" → others' PRs merged by the user and issues closed by the user (last
 * ClosedEvent actor) that month, from `repo:R closed:<month>` (first GAP_SAMPLE); larger months
 * are re-searched with `involves:<login>` (a lower bound, complete = false). One query at a
 * time; failed ones are absent.
 */
export async function fetchGapClosed(http: Http, login: string, pairs: [string, string][]): Promise<Map<string, GapClosed>> {
  const lo = login.toLowerCase();
  const counts = (s: GapSearch): [number, number] => {
    const nodes = s.nodes.filter((n) => n !== null);
    const merged = nodes.filter(
      (n) => n.merged && (n.mergedBy?.login ?? "").toLowerCase() === lo && (n.author?.login ?? "").toLowerCase() !== lo,
    ).length;
    const closes = nodes.filter(
      (n) => n.timelineItems !== undefined && n.timelineItems.nodes.some((ev) => (ev?.actor?.login ?? "").toLowerCase() === lo),
    ).length;
    return [merged, closes];
  };
  const search = (involves: boolean) => async (chunk: [string, string][]) => {
    const parts = chunk.map(([r, m], i) => {
      const q = `repo:${r} closed:${m}-01..${monthEnd(m).slice(0, 10)}` + (involves ? ` involves:${login}` : "");
      return `s${i}: search(query: ${gqlStr(q)}, type: ISSUE, first: ${GAP_SAMPLE}) { issueCount nodes {
                  ... on PullRequest { merged author { login } mergedBy { login } }
                  ... on Issue { timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {
                    nodes { ... on ClosedEvent { actor { login } } } } } } }`;
    });
    const data = await http.graphql<Record<string, GapSearch | null>>("query { " + parts.join("\n") + " }");
    const out = new Map<string, GapSearch>();
    chunk.forEach(([r, m], i) => {
      const s = data[`s${i}`];
      if (s !== null && s !== undefined) out.set(`${r}#${m}`, s);
    });
    return out;
  };
  const out = new Map<string, GapClosed>();
  const first = await http.parHalving(pairs, GAP_BATCH, search(false), "gap closed items", 1);
  for (const [key, s] of first) {
    if (s.issueCount <= GAP_SAMPLE) {
      const [merged, closes] = counts(s);
      out.set(key, { merged, closes, complete: true });
    }
  }
  const big = pairs.filter(([r, m]) => first.has(`${r}#${m}`) && !out.has(`${r}#${m}`));
  for (const [key, s] of await http.parHalving(big, GAP_BATCH, search(true), "gap closed items (involves)", 1)) {
    const [merged, closes] = counts(s);
    out.set(key, { merged, closes, complete: false });
  }
  return out;
}

/**
 * "repo lowercase#YYYY-MM" → the user's issue/PR conversation comments created since `since`,
 * from user.issueComments newest updated first (≤ GAP_COMMENT_PAGES pages of 100). null when
 * not even the first page is readable.
 */
export async function fetchGapComments(http: Http, login: string, since: string): Promise<Map<string, number> | null> {
  const q = `query($login: String!, $after: String) { user(login: $login) {
      issueComments(first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor } nodes { createdAt updatedAt repository { nameWithOwner } } } } }`;
  type Node = { createdAt: string; updatedAt: string; repository: { nameWithOwner: string } | null };
  type Doc = { user: { issueComments: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (Node | null)[] } } | null };
  const out = new Map<string, number>();
  let after: string | null = null;
  for (let page = 0; page < GAP_COMMENT_PAGES; page += 1) {
    let c: NonNullable<Doc["user"]>["issueComments"];
    try {
      const data: Doc = await http.graphql<Doc>(q, { login, after });
      if (!data.user) throw new TypeError("'NoneType' object is not subscriptable");
      c = data.user.issueComments;
    } catch (error) {
      if (!(error instanceof ApiError) && !(error instanceof TypeError)) throw error;
      if (page === 0) {
        http.env.log?.(`  ! gap comments: ${error.message}`);
        return null;
      }
      http.env.log?.(`  ~ gap comments: stopped at page ${page}: ${error.message}`);
      break;
    }
    const nodes = c.nodes.filter((n): n is Node => n !== null);
    for (const n of nodes) {
      if (n.createdAt.slice(0, 7) >= since && n.repository) {
        const key = `${n.repository.nameWithOwner.toLowerCase()}#${n.createdAt.slice(0, 7)}`;
        out.set(key, (out.get(key) ?? 0) + 1);
      }
    }
    if (!c.pageInfo.hasNextPage || nodes.length === 0 || nodes[nodes.length - 1].updatedAt.slice(0, 7) < since) break;
    after = c.pageInfo.endCursor;
  }
  return out;
}

/**
 * Contract v15: fill GH Archive gap months of the user's verified-role repos from the GitHub
 * API, in place: per repo-month and family in a gap, the count becomes max(GH Archive, API).
 * Only gap months within GAP_WINDOW months before `until`. null when nothing could be checked.
 */
export async function fillMaintGaps(
  http: Http,
  login: string,
  maintRaw: Record<string, MaintEvents> | null,
  reviews: RepoMonths,
  until: string,
): Promise<GapInfo | null> {
  if (maintRaw === null) return null;
  const allGaps = await gapMonths(http, until);
  if (allGaps === null) return null;
  const lo = monthAdd(until, -GAP_WINDOW);
  const gaps = Object.fromEntries(
    MAINT_TYPES.map((f) => [f, allGaps[f].filter((m) => lo <= m && m < until)]),
  ) as Record<MaintType, string[]>;
  const months = [...new Set(MAINT_TYPES.flatMap((f) => gaps[f]))].sort();
  const info: GapInfo = { gaps, checked: 0, repos: {} };
  if (months.length === 0) return info;
  const repos = gapFillRepos(maintRaw, months[0]);
  info.checked = repos.length;
  if (repos.length === 0) return info;
  http.env.log?.(`  GH Archive gap fill: ${repos.length} repos × ${months.length} months (${months.join(", ")})`);
  // the closed-item search only where GH Archive saw the user merge others' PRs or close issues
  // in that repo before (a repo where they only review or comment needs no search)
  const did = (r: string, fam: MaintType) =>
    Object.entries(maintRaw[r].by_type).some(([m, bt]) => bt[fam] && !gaps[fam].includes(m));
  const pairs: [string, string][] = [];
  for (const r of repos) {
    for (const m of months) {
      if ((gaps.merged.includes(m) && did(r, "merged")) || (gaps.closes.includes(m) && did(r, "closes"))) pairs.push([r, m]);
    }
  }
  const closed = await fetchGapClosed(http, login, pairs);
  const cmMonths = gaps.comments;
  const comments = cmMonths.length ? await fetchGapComments(http, login, cmMonths[0]) : new Map<string, number>();
  const revByName = new Map<string, Record<string, number>>();
  for (const [r, ms] of Object.entries(reviews)) revByName.set(r.toLowerCase(), ms);
  for (const r of repos) {
    const e = maintRaw[r];
    const filled: string[] = [];
    for (const m of months) {
      const c = closed.get(`${r}#${m}`);
      const api: Record<MaintType, number | null> = {
        reviews: gaps.reviews.includes(m) ? (revByName.get(r.toLowerCase())?.[m] ?? 0) : null,
        comments: cmMonths.includes(m) && comments !== null ? (comments.get(`${r.toLowerCase()}#${m}`) ?? 0) : null,
        merged: gaps.merged.includes(m) && c ? c.merged : null,
        closes: gaps.closes.includes(m) && c ? c.closes : null,
      };
      if (MAINT_TYPES.every((f) => api[f] === null)) continue;
      const bt = (e.by_type[m] ??= { reviews: 0, comments: 0, merged: 0, closes: 0 });
      for (const fam of MAINT_TYPES) {
        const v = api[fam];
        if (v !== null && v > bt[fam]) {
          if (fam === "merged") e.merged_others += v - bt[fam];
          e.months[m] = (e.months[m] ?? 0) + v - bt[fam];
          bt[fam] = v;
          if (!filled.includes(m)) filled.push(m);
        }
      }
    }
    if (filled.length) info.repos[r] = filled;
  }
  return info;
}

export async function runGapFill(ctx: PhaseContext): Promise<GapFillOut> {
  const { login } = await ctx.get<UserOut>("user");
  const contribs = await ctx.get<ContribsOut>("contribs");
  // a copy: the stored `maintainer` output stays the raw GH Archive data
  const maint = structuredClone(await ctx.get<MaintainerOut>("maintainer"));
  const info = await fillMaintGaps(ctx.http, login, maint, contribs.reviews, ctx.state.startedAt.slice(0, 7));
  return { maint, info };
}

/** The data note of contract v15's gap fill: which months were gaps and which were filled. */
export function gapNote(info: GapInfo | null): string {
  if (info === null) return "v15 gap fill: GH Archive gap months unknown (ClickHouse failed); maint_* not filled";
  const gaps = MAINT_TYPES.map((f) => `${f} ${info.gaps[f].join("/") || "none"}`).join(", ");
  const filled = [...new Set(Object.values(info.repos).flat())].sort();
  return (
    `v15 gap fill: GH Archive gap months (daily rate < ${Math.round(GAP_RATIO * 100)}% of the trailing median, last ` +
    `${GAP_WINDOW} months): ${gaps}; ${info.checked} verified-role repos (≤ ${GAP_REPOS}) checked against the ` +
    `GitHub API, ${Object.keys(info.repos).length} raised in months ${filled.join(", ") || "none"} (reviews: contributionsCollection; comments: ` +
    `user.issueComments, inline review comments not covered; merges of others' PRs and issue closes: search ` +
    `repo:R closed:<month> (≤ ${GAP_SAMPLE} items; larger months: + involves:<login>, a lower bound)); per family ` +
    "max(GH Archive, API)"
  );
}
