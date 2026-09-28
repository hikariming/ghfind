import { afterEach, expect, it, vi } from "vitest";
import { fetchContribOverview, fetchRecentPrs, ghFetch, collect, computeClosedPrBreakdown } from "../github";
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
  const totals = { contributionCalendar: { totalContributions: 59 } };
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("pinnedItems") && query.includes("contributionCalendar")) {
      combinedCalls++;
      return new Response("gateway timeout", { status });
    }
    if (query.includes("pinnedItems")) {
      expect(query).not.toContain("closedPRs");
      return json({ user: { pinnedItems: { nodes: [] }, mergedPRs: { totalCount: 500 }, allPRs: { totalCount: 700 },
        issues: { totalCount: 4 }, contributionYears: { contributionYears: [2026, 2025] } } });
    }
    if (query.includes("contributionCalendar")) return json({ user: { contributionsCollection: totals } });
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
  expect(result.lastYearContributions).toBe(59);
  expect(result.overview.closedPRs.totalCount).toBe(200);
  expect(result.overview.closedPRs.nodes).toHaveLength(100);
  expect(result.overview.mergedPRs.totalCount).toBe(500);
  expect(closedCursors).toEqual([null, "closed1", "closed2", "closed3"]);
});

it("degrades closedPRs to a count when GitHub fails the node list with INTERNAL", async () => {
  process.env.GITHUB_TOKEN = "one,two,three";
  const internal = () => new Response(JSON.stringify({
    errors: [{ type: "INTERNAL", message: "Something went wrong", path: ["user", "closedPRs", "nodes", 2] }],
    data: { user: null },
  }), { headers: { "Content-Type": "application/json" } });
  const totals = { contributionCalendar: { totalContributions: 59 } };
  let nodeAttempts = 0;
  let countOnlyAttempts = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const { query } = JSON.parse(init.body);
    const hasPinned = query.includes("pinnedItems");
    const hasCalendar = query.includes("contributionCalendar");
    if (hasPinned && hasCalendar) return internal(); // combined doc: poisoned by the closedPRs node
    if (hasCalendar) return json({ user: { contributionsCollection: totals } });
    if (hasPinned) return json({ user: { pinnedItems: { nodes: [] }, mergedPRs: { totalCount: 40 },
      allPRs: { totalCount: 55 }, issues: { totalCount: 4 }, contributionYears: { contributionYears: [2026] } } });
    if (query.includes("first: 25")) { nodeAttempts++; return internal(); } // node list fails the same way
    countOnlyAttempts++;
    return json({ user: { closedPRs: { totalCount: 3 } } });
  }));
  const result = await fetchContribOverview("poisoned");
  expect(result.overview.closedPRs.totalCount).toBe(3);
  expect(result.overview.closedPRs.nodes).toEqual([]);
  expect(result.overview.mergedPRs.totalCount).toBe(40);
  expect(result.lastYearContributions).toBe(59);
  expect(nodeAttempts).toBe(1);
  expect(countOnlyAttempts).toBe(1);
});

it.each([
  ["INTERNAL", 504, 5],
  [504, "INTERNAL", 5],
  ["RESOURCE_LIMITS_EXCEEDED", "RESOURCE_LIMITS_EXCEEDED", 6],
])("composes overview %s and closed nodes %s fallbacks", async (combined, closed, expectedCalls) => {
  process.env.GITHUB_TOKEN = "one,two,three";
  const fail = (error: string | number) => typeof error === "number"
    ? new Response("gateway timeout", { status: error })
    : new Response(JSON.stringify({ errors: [{ type: error, message: "query failed" }] }));
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const { query } = JSON.parse(init.body);
    calls.push(query);
    if (query.includes("pinnedItems") && query.includes("contributionCalendar")) return fail(combined);
    if (query.includes("pinnedItems") && query.includes("closedPRs")) return fail("INTERNAL");
    if (query.includes("pinnedItems")) return json({ user: { pinnedItems: { nodes: [] },
      mergedPRs: { totalCount: 40 }, allPRs: { totalCount: 55 }, issues: { totalCount: 4 },
      contributionYears: { contributionYears: [2026] } } });
    if (query.includes("contributionCalendar")) return json({ user: { contributionsCollection: {
      contributionCalendar: { totalContributions: 12345 },
    } } });
    if (query.includes("first: 25")) return fail(closed);
    return json({ user: { closedPRs: { totalCount: 3 } } });
  }));
  const result = await fetchContribOverview("poisoned");
  expect(result.lastYearContributions).toBe(12345);
  expect(result.overview.closedPRs).toEqual({ totalCount: 3, nodes: [] });
  expect(computeClosedPrBreakdown(result.overview.closedPRs.nodes, 3, "poisoned"))
    .toMatchObject({ unknown_closed_unmerged_pr_count: 3, maintainer_closed_unmerged_pr_count: 0 });
  expect(calls).toHaveLength(expectedCalls);
});

it.each(["missing", "rate-limit"])("does not turn %s closed counts into a zero score", async mode => {
  process.env.GITHUB_TOKEN = "one";
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const { query } = JSON.parse(init.body);
    if (query.includes("closedPRs") && query.includes("nodes")) {
      return new Response(JSON.stringify({ errors: [{ type: "INTERNAL", message: "query failed" }] }));
    }
    if (query.includes("pinnedItems")) return json({ user: {} });
    if (query.includes("contributionCalendar")) return json({ user: { contributionsCollection: {
      contributionCalendar: { totalContributions: 10 },
    } } });
    return mode === "missing" ? json({ user: {} }) : new Response("rate limit", { status: 429 });
  }));
  await expect(fetchContribOverview("poisoned")).rejects.toThrow();
});

it("bounds the closed-PR fallback even when GitHub returns short pages", async () => {
  process.env.GITHUB_TOKEN = "one";
  let pages = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const { query } = JSON.parse(init.body);
    if (query.includes("pinnedItems") && query.includes("contributionCalendar")) {
      return new Response("gateway timeout", { status: 504 });
    }
    if (query.includes("pinnedItems")) return json({ user: {} });
    if (query.includes("contributionCalendar")) return json({ user: { contributionsCollection: {
      contributionCalendar: { totalContributions: 10 },
    } } });
    pages++;
    return json({ user: { closedPRs: { totalCount: 100, nodes: [{ id: `pr${pages}` }],
      pageInfo: { hasNextPage: true, endCursor: `page${pages}` },
    } } });
  }));
  const result = await fetchContribOverview("active");
  expect(pages).toBe(4);
  expect(result.overview.closedPRs.nodes).toHaveLength(4);
  expect(computeClosedPrBreakdown(result.overview.closedPRs.nodes, 100, "active"))
    .toMatchObject({ unknown_closed_unmerged_pr_count: 100, maintainer_closed_unmerged_pr_count: 0 });
});
