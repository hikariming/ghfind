import { describe, expect, it } from "vitest";
// 400 without data: an ApiError the transport neither retries (5xx would back off for seconds) nor hides
import { memoryCollectStore } from "@/lib/devscore-store";
import { Http } from "../http";
import type { PhaseContext } from "../index";
import type { MergedPrsOut, UserOut } from "../outputs";
import { fetchContribYear, fetchReviewers, mergeContribYears, pageWindow, runRejected, scanUserPrs } from "../phase-user";

type Gql = { query: string; variables: Record<string, unknown> };

/** Http over a fake GitHub GraphQL endpoint: `answer` returns [status, body JSON]. */
function fakeHttp(answer: (req: Gql) => [number, unknown]): { http: Http; calls: Gql[] } {
  const calls: Gql[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as Gql;
    calls.push(req);
    const [status, body] = answer(req);
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { http: new Http({ fetch, githubTokens: ["t"], store: memoryCollectStore(() => 0), now: () => 0 }, Infinity), calls };
}

type Pr = { id: string; state: string; createdAt: string; repository: { nameWithOwner: string; owner: { login: string } } };

const SINCE = "2024-09-28T00:00:00Z";
const RECENT = "2026-01-01T00:00:00Z";
const OLD = "2020-01-01T00:00:00Z";

/** A PR list node (the scan's light fields). */
const node = (id: string, state: string, owner = "o", createdAt = RECENT) => ({
  id, number: 1, title: "t", state, createdAt, mergedAt: null,
  mergedBy: state === "MERGED" ? { login: "m", __typename: "User" } : null,
  repository: { nameWithOwner: `${owner}/r`, owner: { login: owner } },
});

/**
 * GitHub serving `list` as the user's PR list (cursor = index); `fail(after, n)` makes a page
 * request fail. Records the cursors of the page requests.
 */
function prList(list: Pr[], fail: (after: number, n: number | null) => boolean = () => false) {
  const count = (s: string) => list.filter((x) => x.state === s).length;
  const fake = fakeHttp(({ query, variables }) => {
    const after = variables.after === null ? 0 : Number(variables.after);
    const n = (variables.n as number | undefined) ?? null;
    if (fail(after, n)) return [400, { message: "bad" }];
    const end = Math.min(list.length, after + (n ?? 1));
    const c = { totalCount: list.length, pageInfo: { hasNextPage: end < list.length, endCursor: String(end) }, nodes: n === null ? undefined : list.slice(after, end) };
    const extra = query.includes("m: pullRequests") ? { m: { totalCount: count("MERGED") }, c: { totalCount: count("CLOSED") } } : {};
    return [200, { data: { user: { pullRequests: c, ...extra } } }];
  });
  const pages = () => fake.calls.filter((c) => c.variables.n !== undefined).map((c) => c.variables.after);
  return { ...fake, pages };
}

const times = <T,>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));

describe("pageWindow (a per-state page scan on a partly listed stream)", () => {
  it("waits for the next page, stops after a full page, exhausts on the total or the list end", () => {
    expect(pageWindow(30, false, 80, 50, 20)).toBeNull();
    expect(pageWindow(30, true, 80, 50, 20)).toEqual({ take: 30, last: true });
    expect(pageWindow(50, false, 50, 50, 20)).toEqual({ take: 50, last: true });
    expect(pageWindow(120, false, 500, 50, 20, (end) => end >= 100)).toEqual({ take: 100, last: false });
    expect(pageWindow(1000, false, 5000, 50, 20)).toEqual({ take: 1000, last: false });
  });
});

describe("scanUserPrs (one pass, three windows)", () => {
  it("merged: exactly MERGED_PR_PAGES × 100 merged PRs are complete, one more is not", async () => {
    const tail = times(5, (i) => node(`o${i}`, "OPEN", "o", OLD));
    const exact = await scanUserPrs(prList([...times(2000, (i) => node(`m${i}`, "MERGED", "u", OLD)), ...tail]).http, "u", SINCE);
    expect([exact.nodes.length, exact.total, exact.complete]).toEqual([2000, 2000, true]);
    const over = await scanUserPrs(prList([...times(2001, (i) => node(`m${i}`, "MERGED", "u", OLD)), ...tail]).http, "u", SINCE);
    expect([over.nodes.length, over.total, over.complete]).toEqual([2000, 2001, false]);
    // list nodes are reduced to the merged-PR shape later phases read
    expect(Object.keys(over.nodes[0]).sort()).toEqual(["createdAt", "mergedAt", "mergedBy", "number", "repository", "title"]);
  });

  it("rejected: stops after the virtual page of 50 CLOSED PRs that reaches REJECTED_SCAN_CAP external", async () => {
    // every other CLOSED PR is external: 300 external after 600 CLOSED (12 pages of 50), then 400 more
    const list = times(1000, (i) => node(`c${i}`, "CLOSED", i % 2 ? "u" : "o", OLD));
    const gh = prList(list);
    const { closed } = await scanUserPrs(gh.http, "u", SINCE);
    expect([closed.total, closed.listed, closed.ext.length, closed.complete]).toEqual([1000, 600, 300, false]);
    expect(closed.ext.slice(0, 2)).toEqual(["c0", "c2"]);
    // the other windows were decided on page 1; the scan ends once the CLOSED window is
    expect(gh.pages()).toEqual([null, "100", "200", "300", "400", "500"]);
  });

  it("ext: pages of 100 up to the first page ending before `since`, then only PRs since, external, ≤ EXT_PR_CAP", async () => {
    const list = [
      ...times(150, (i) => node(`a${i}`, i % 3 ? "OPEN" : "CLOSED", i % 5 ? "o" : "u")),
      ...times(100, (i) => node(`z${i}`, "OPEN", "o", OLD)),
    ];
    const gh = prList(list);
    const { ext } = await scanUserPrs(gh.http, "u", SINCE);
    // page 2 (a100..a149, z0..z49) ends before since: listed through it, only the 120 external recent PRs kept
    expect(ext.prs).toHaveLength(120);
    expect(ext.ids.every((id) => id.startsWith("a"))).toBe(true);
    expect(ext.prs.every((p) => p.additions === null && p.changed_files === null && p.closed_by === null && p.reviewers === null)).toBe(true);
    expect(ext.complete).toBe(true);
    expect(gh.pages()).toEqual([null, "100"]);

    const many = await scanUserPrs(prList(times(700, (i) => node(`e${i}`, "OPEN"))).http, "u", SINCE);
    expect([many.ext.prs.length, many.ext.complete]).toEqual([500, true]);
  });

  it("a window the request cap leaves undecided keeps what was listed and is incomplete", async () => {
    // 1 merged PR per 100 own recent PRs: 50 merged in 5000, the scan stops at 40 requests
    const list = times(5000, (i) => node(`p${i}`, i % 100 === 99 ? "MERGED" : "OPEN", "u"));
    const gh = prList(list);
    const out = await scanUserPrs(gh.http, "u", SINCE);
    expect(gh.pages()).toHaveLength(40);
    expect([out.nodes.length, out.total, out.complete]).toEqual([40, 50, false]);
    // ext decided at its own page cap (10 pages): no external PR, incomplete like before
    expect([out.ext.prs.length, out.ext.complete]).toEqual([0, false]);
    expect(out.closed).toEqual({ total: 0, listed: 0, ext: [], complete: true });
  });

  it("halves a failing page down to 1, steps over the unreadable PR; undecided windows become incomplete", async () => {
    const list = [node("m0", "MERGED"), node("c0", "CLOSED"), node("bad", "OPEN"), node("m1", "MERGED"), node("c1", "CLOSED", "u")];
    // every page holding the third PR fails: pages shrink to 1 before it, then it is stepped over
    const gh = prList(list, (after, n) => n !== null && after <= 2 && after + n > 2);
    const out = await scanUserPrs(gh.http, "u", SINCE);
    expect(gh.calls.filter((c) => c.variables.after === "2").map((c) => c.variables.n ?? "skip")).toEqual([100, 50, 25, 12, 6, 3, 1, "skip"]);
    expect(out.nodes).toHaveLength(2);
    expect([out.complete, out.closed.complete, out.ext.complete]).toEqual([false, false, false]);
    expect([out.closed.listed, out.closed.ext]).toEqual([2, ["c0"]]);
  });

  it("throws when not even the first page can be read; keeps what it has when a later step-over fails", async () => {
    await expect(scanUserPrs(prList([node("a", "OPEN")], () => true).http, "u", SINCE)).rejects.toThrow(/api error/);
    const list = [...times(100, (i) => node(`m${i}`, "MERGED")), node("x", "MERGED")];
    const out = await scanUserPrs(prList(list, (after) => after === 100).http, "u", SINCE);
    expect([out.nodes.length, out.total, out.complete, out.ext.prs.length, out.ext.complete]).toEqual([100, 101, false, 100, false]);
  });
});

describe("monthly contributions", () => {
  const cc = (repo: string, commits: number) => ({
    commitContributionsByRepository: [{ contributions: { totalCount: commits }, repository: { nameWithOwner: repo } }],
    pullRequestContributionsByRepository: [],
    pullRequestReviewContributionsByRepository: [{ contributions: { totalCount: 1 }, repository: null }],
  });

  it("stops at the collection month, halves a failing batch and leaves out a month that keeps failing", async () => {
    const { http } = fakeHttp(({ variables }) => {
      const months = Object.keys(variables).filter((k) => k.startsWith("f")).map((k) => String(variables[k]).slice(0, 7));
      // 2026-02 can never be read: the batch halves down to it alone
      if (months.includes("2026-02")) return [400, { message: "bad" }];
      return [200, { data: { user: Object.fromEntries(months.map((m, i) => [`m${i}`, cc("o/r", Number(m.slice(5))) ])) } }];
    });
    const y26 = await fetchContribYear(http, "u", 2026, "2026-03");
    expect(y26.commits).toEqual({ "o/r": { "2026-01": 1, "2026-03": 3 } });
    expect(y26.reviews).toEqual({});
    const y25 = await fetchContribYear(http, "u", 2025, "2026-03");
    expect(Object.keys(y25.commits["o/r"])).toHaveLength(12);
    const merged = mergeContribYears([
      [2026, y26],
      [2025, y25],
    ]);
    expect(Object.keys(merged.commits["o/r"])[0]).toBe("2025-01");
    expect(merged.commits["o/r"]["2026-03"]).toBe(3);
  });
});

describe("rejected and PR details", () => {
  const ctx = (merged: MergedPrsOut, http: Http): PhaseContext => {
    const user: UserOut = { id: "U", login: "u", name: null, followers: 0, contributionYears: [], pushed: [], starred: [] };
    const outputs: Record<string, unknown> = { user, merged_prs: merged };
    return {
      http,
      state: { runId: "r", login: "u", startedAt: "2026-09-28T10:00:00Z", phase: "rejected", progress: 0, waitUntil: null, cursor: null },
      get: async <T,>(p: string) => outputs[p] as T,
      saveCursor: () => {},
      log: () => {},
    };
  };
  /** nodes(ids:) server: closer `closer-<id>` (none for "ghost", self for "self"), sizes [id length, 0, 1]; "bad" fails. */
  function nodesServer() {
    return fakeHttp(({ query, variables }) => {
      const ids = variables.ids as string[];
      if (ids.includes("bad")) return [400, { message: "bad" }];
      return [200, { data: { nodes: ids.map((id) => ({
        ...(query.includes("timelineItems") ? { timelineItems: { nodes: id === "ghost" ? [] : [{ actor: { login: id === "self" ? "U" : `closer-${id}` } }] } } : {}),
        ...(query.includes("changedFiles") ? { additions: id.length, deletions: 0, changedFiles: 1 } : {}),
      })) } }];
    });
  }
  const extScan = (states: string[]) => ({
    prs: states.map((state) => ({ repo: "o/r", title: "t", state, created_at: RECENT, additions: null, deletions: null, changed_files: null, merged_by: null, closed_by: null, reviewers: null })),
    ids: states.map((s, i) => `${s[0]}${i}`),
    complete: true,
  });

  it("extrapolates the external closed total from an incomplete window (Python round); ghost/unreadable closers count as others", async () => {
    const { http, calls } = nodesServer();
    const merged: MergedPrsOut = {
      total: 0, nodes: [], complete: true,
      closed: { total: 10, listed: 8, ext: ["self", "x", "ghost", "bad"], complete: false },
      ext: extScan(["CLOSED", "MERGED"]),
    };
    const out = await runRejected(ctx(merged, http));
    // 4 external of 8 listed, 10 CLOSED → round(5) = 5; by others: x, ghost, bad
    expect(out).toEqual({ closedExt: 5, scanned: 4, byOther: 3, closers: { self: "U", x: "closer-x", ghost: null, bad: null }, sizes: {} });
    // rule A cannot fire (1 CLOSED ext PR): closers of the window only, no sizes
    expect(calls.every((c) => !c.query.includes("changedFiles"))).toBe(true);
  });

  it("reads ext_prs closers and sizes in one pass when rule A can use them, one query per id", async () => {
    const { http, calls } = nodesServer();
    const ext = extScan([...times(20, () => "CLOSED"), "MERGED", "OPEN"]);
    const merged: MergedPrsOut = { total: 0, nodes: [], complete: true, closed: { total: 3, listed: 3, ext: ["C0", "w"], complete: true }, ext };
    const out = await runRejected(ctx(merged, http));
    expect([out.closedExt, out.scanned]).toEqual([2, 2]);
    expect(Object.keys(out.closers).sort()).toEqual([...ext.ids.slice(0, 20), "w"].sort());
    expect(Object.keys(out.sizes).sort()).toEqual([...ext.ids].sort());
    expect(out.sizes.M20).toEqual([3, 0, 1]);
    const asked = calls.flatMap((c) => c.variables.ids as string[]);
    expect(asked.sort()).toEqual([...ext.ids, "w"].sort());
  });

  it("reads human reviewers by node id, halving a failing batch and dropping the unreadable PR", async () => {
    const bot = { author: { login: "ci", __typename: "Bot" } };
    const me = { author: { login: "U", __typename: "User" } };
    const rv = { author: { login: "a", __typename: "User" } };
    const { http } = fakeHttp(({ variables }) => {
      const ids = variables.ids as string[];
      if (ids.includes("bad")) return [400, { message: "bad" }];
      return [200, { data: { nodes: ids.map((id) => ({ reviews: { nodes: id === "x" ? [bot, me, rv, rv] : [] } })) } }];
    });
    expect(await fetchReviewers(http, "u", ["x", "y", "bad"])).toEqual(new Map([["x", ["a"]], ["y", []]]));
  });
});
