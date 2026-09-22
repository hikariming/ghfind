import { afterEach, expect, it, vi } from "vitest";
import { fetchContribOverview, fetchRecentPrs, ghFetch, collect } from "../github";
const original = process.env.GITHUB_TOKEN;
afterEach(() => {
  if (original === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = original;
  vi.unstubAllGlobals();
});
const json = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } });

it("releases a failed response before issuing the next token request", async () => {
  process.env.GITHUB_TOKEN = "one,two";
  const cancel = vi.fn();
  const failed = new Response(new ReadableStream({ cancel }), { status: 502 });
  const mock = vi.fn().mockResolvedValueOnce(failed).mockImplementationOnce(() => {
    expect(cancel).toHaveBeenCalledOnce();
    return json({ ok: true });
  });
  vi.stubGlobal("fetch", mock);
  expect((await ghFetch("https://api.github.com/graphql")).status).toBe(200);
});

it("releases definitive 404 bodies without retrying or hiding the status", async () => {
  process.env.GITHUB_TOKEN = "one,two";
  const cancel = vi.fn();
  const mock = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 404 }));
  vi.stubGlobal("fetch", mock);
  await expect(collect("missing")).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();
  expect(mock).toHaveBeenCalledOnce();
});

it("keeps the full 100-PR scoring sample while fetching only 25 file lists per query", async () => {
  process.env.GITHUB_TOKEN = "one";
  const cursors: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const { variables } = JSON.parse(init.body);
    expect(variables.count).toBe(25);
    cursors.push(variables.after);
    const page = cursors.length;
    return json({ user: { pullRequests: {
      nodes: Array.from({ length: 25 }, (_, i) => ({ title: `PR ${25 * (page - 1) + i}`, additions: 7, deletions: 0, changedFiles: 1,
        repository: { nameWithOwner: "org/repo", stargazerCount: 1000, isPrivate: false }, files: { nodes: [{ path: "src/code.ts" }] } })),
      pageInfo: { hasNextPage: true, endCursor: `page${page}` },
    } } });
  }));
  const result = await fetchRecentPrs("active", 100);
  expect(result).toHaveLength(100);
  expect(new Set(result.map(x => x.title)).size).toBe(100);
  expect(cursors).toEqual([null, "page1", "page2", "page3"]);
  expect(result[99].files).toEqual(["src/code.ts"]);
});

it("fails closed if a PR page repeats its cursor", async () => {
  process.env.GITHUB_TOKEN = "one";
  vi.stubGlobal("fetch", vi.fn(async () => json({ user: { pullRequests: {
    nodes: [{ title: "PR", repository: null }], pageInfo: { hasNextPage: true, endCursor: "same" },
  } } })));
  await expect(fetchRecentPrs("active", 100)).rejects.toThrow("no progress");
});

it.each([502, 504])("splits HTTP %i overviews and retains all contribution and closed-PR signals", async status => {
  process.env.GITHUB_TOKEN = "one,two,three,four";
  let combinedCalls = 0;
  const closedCursors: unknown[] = [];
  const totals = { totalCommitContributions: 20, totalPullRequestContributions: 30, totalIssueContributions: 4,
    totalPullRequestReviewContributions: 5, contributionCalendar: { totalContributions: 59 } };
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("pinnedItems") && query.includes("totalCommitContributions")) {
      combinedCalls++;
      return new Response("gateway timeout", { status });
    }
    if (query.includes("pinnedItems")) {
      expect(query).not.toContain("closedPRs");
      return json({ user: { pinnedItems: { nodes: [] }, mergedPRs: { totalCount: 500 }, allPRs: { totalCount: 700 },
        issues: { totalCount: 4 }, contributionYears: { contributionYears: [2026, 2025] } } });
    }
    if (query.includes("totalCommitContributions")) return json({ user: { contributionsCollection: totals } });
    expect(query).toContain("first: 25, after: $after");
    closedCursors.push(variables.after);
    return json({ user: { closedPRs: { totalCount: 200,
      nodes: Array.from({ length: 25 }, (_, i) => ({ id: `${closedCursors.length}-${i}`, author: { login: "active" },
        repository: { owner: { login: "org" } }, timelineItems: { nodes: [{ actor: { login: "maintainer" } }] } })),
      pageInfo: { hasNextPage: true, endCursor: `closed${closedCursors.length}` },
    } } });
  }));
  const result = await fetchContribOverview("active");
  expect(combinedCalls).toBe(1);
  expect(result.statTotals).toEqual(totals);
  expect(result.lastYearContributions).toBe(59);
  expect(result.overview.closedPRs.totalCount).toBe(200);
  expect(result.overview.closedPRs.nodes).toHaveLength(100);
  expect(result.overview.mergedPRs.totalCount).toBe(500);
  expect(closedCursors).toEqual([null, "closed1", "closed2", "closed3"]);
});
