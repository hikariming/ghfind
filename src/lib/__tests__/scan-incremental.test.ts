import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOriginalInventory, GITHUB_PAGE_SIZE, QUICK_REPO_PAGES } from "../github";
import {
  cursorBeforeWatermark,
  decideScanReconcile,
  emptyCursorBook,
  loadScanCursors,
  mergeInventoryRepos,
  planInventoryCursor,
  resetScanCursorSchemaForTests,
  SCAN_CURSOR_SCHEMA_VERSION,
  SCAN_CURSOR_STATUS_TTL_MS,
  scanIncrementalEnabled,
  scanIncrementalReconcileEveryN,
  type CursorRepo,
  type ScanCursorBook,
  type ScanCursorWatermark,
} from "../scan-cursor";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "../scan-run-types";

const LOGIN = "fiction-cursor";
const NOW = new Date("2026-08-03T00:00:00Z");

let tmpDir = "";

function repo(id: string, pushedAt: string, stars = 1): CursorRepo {
  return {
    id,
    name: `fiction-repo-${id}`,
    fullName: `${LOGIN}/fiction-repo-${id}`,
    size: 10,
    stars,
    forks: 0,
    openIssues: 0,
    description: "Fictional repo",
    pushedAt,
    language: "Go",
    topics: [],
  };
}

function mark(over: Partial<ScanCursorWatermark> = {}): ScanCursorWatermark {
  return {
    source: "repos",
    watermark: "2026-07-01T00:00:00Z",
    collection: PUBLIC_SCAN_COLLECTION_VERSION,
    incrementalRuns: 0,
    reconciledAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
    repos: [repo("1", "2026-07-01T00:00:00Z")],
    forkCount: 3,
    ...over,
  };
}

function book(repos: ScanCursorWatermark | null, revision = 0): ScanCursorBook {
  return { ...emptyCursorBook(LOGIN), repos, revision };
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ghfind-scan-cursor-"));
  process.env.TURSO_DATABASE_URL = `file:${join(tmpDir, "test.db")}`;
  delete process.env.TURSO_AUTH_TOKEN;
});

afterAll(() => {
  delete process.env.TURSO_DATABASE_URL;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetScanCursorSchemaForTests();
  delete process.env.GHFIND_SCAN_INCREMENTAL_ENABLED;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.GHFIND_SCAN_INCREMENTAL_ENABLED;
});

describe("scan incremental flag", () => {
  it("accepts 1, true, and on, and stays off otherwise", () => {
    expect(scanIncrementalEnabled({})).toBe(false);
    expect(scanIncrementalEnabled({ GHFIND_SCAN_INCREMENTAL_ENABLED: "" })).toBe(false);
    expect(scanIncrementalEnabled({ GHFIND_SCAN_INCREMENTAL_ENABLED: "0" })).toBe(false);
    expect(scanIncrementalEnabled({ GHFIND_SCAN_INCREMENTAL_ENABLED: "yes" })).toBe(false);
    for (const value of ["1", "true", "on", "TRUE", " On "]) {
      expect(scanIncrementalEnabled({ GHFIND_SCAN_INCREMENTAL_ENABLED: value })).toBe(true);
    }
  });

  it("reconciles after seven daily incremental runs or seven days", () => {
    expect(scanIncrementalReconcileEveryN()).toBe(7);
    expect(SCAN_CURSOR_STATUS_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    const fresh = book(mark({ incrementalRuns: 6 }));
    expect(decideScanReconcile(fresh, NOW)).toBe("");
    expect(decideScanReconcile(book(mark({ incrementalRuns: 7 })), NOW)).toBe("incremental_run_count");
    const aged = book(mark({
      reconciledAt: new Date(NOW.getTime() - SCAN_CURSOR_STATUS_TTL_MS).toISOString(),
    }));
    expect(decideScanReconcile(aged, NOW)).toBe("cursor_age");
  });
});

describe("inventory watermark", () => {
  it("keeps same-second siblings and dedupes by repo id", () => {
    const second = "2026-07-01T00:00:01Z";
    expect(cursorBeforeWatermark(second, second)).toBe(false);
    expect(cursorBeforeWatermark("2026-07-01T00:00:00Z", second)).toBe(true);
    const previous = [repo("1", second, 1), repo("2", "2026-06-01T00:00:00Z", 2)];
    const delta = [repo("1", second, 9), repo("3", second, 4)];
    const merged = mergeInventoryRepos(previous, delta);
    expect(merged.map((item) => item.id)).toEqual(["3", "1", "2"]);
    expect(merged.find((item) => item.id === "1")?.stars).toBe(9);
    expect(merged).toHaveLength(3);
  });

  it("stops a page once pushedAt is older than the watermark and keeps the boundary second", async () => {
    vi.stubEnv("GITHUB_TOKEN", "fiction-token");
    const since = "2026-07-01T00:00:01Z";
    const pages = [
      [
        { id: 11, pushedAt: "2026-07-02T00:00:00Z" },
        { id: 12, pushedAt: since },
        { id: 13, pushedAt: since },
      ],
      [{ id: 14, pushedAt: "2026-06-01T00:00:00Z" }],
    ];
    let calls = 0;
    vi.stubGlobal("fetch", async (_raw: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: { after?: string | null } };
      expect(body.query).toContain("orderBy: {field: PUSHED_AT, direction: DESC}");
      const page = pages[calls] ?? [];
      calls += 1;
      return Response.json({
        data: {
          user: {
            forks: { totalCount: 4 },
            repositories: {
              nodes: page.map((item) => ({
                databaseId: item.id,
                name: `fiction-repo-${item.id}`,
                nameWithOwner: `${LOGIN}/fiction-repo-${item.id}`,
                isFork: false,
                diskUsage: 8,
                stargazerCount: 1,
                forkCount: 0,
                description: null,
                pushedAt: item.pushedAt,
                primaryLanguage: null,
                issues: { totalCount: 0 },
                openPullRequests: { totalCount: 0 },
                repositoryTopics: { nodes: [] },
              })),
              pageInfo: { hasNextPage: calls < pages.length, endCursor: `page-${calls}` },
            },
          },
        },
      });
    });
    const page = await fetchOriginalInventory(LOGIN, { since });
    expect(calls).toBe(2);
    expect(page.incomplete).toBe(false);
    expect(page.repos.map((item) => item.id)).toEqual(["11", "12", "13"]);
    expect(page.forks).toBe(4);
  });

  it("keeps the two-page quick cap when no watermark is set", async () => {
    vi.stubEnv("GITHUB_TOKEN", "fiction-token");
    let calls = 0;
    vi.stubGlobal("fetch", async (_raw: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: { after?: string | null } };
      const start = Number(body.variables.after ?? 0);
      calls += 1;
      const end = start + GITHUB_PAGE_SIZE;
      return Response.json({
        data: {
          user: {
            forks: { totalCount: 0 },
            repositories: {
              nodes: Array.from({ length: GITHUB_PAGE_SIZE }, (_, index) => ({
                databaseId: start + index + 1,
                name: `fiction-repo-${start + index}`,
                nameWithOwner: `${LOGIN}/fiction-repo-${start + index}`,
                isFork: false,
                diskUsage: 1,
                stargazerCount: 0,
                forkCount: 0,
                description: null,
                pushedAt: "2026-07-01T00:00:00Z",
                primaryLanguage: null,
                issues: { totalCount: 0 },
                repositoryTopics: { nodes: [] },
              })),
              pageInfo: { hasNextPage: true, endCursor: String(end) },
            },
          },
        },
      });
    });
    const quick = await fetchOriginalInventory(LOGIN);
    expect(calls).toBe(QUICK_REPO_PAGES);
    expect(quick.incomplete).toBe(true);
    expect(quick.repos).toHaveLength(QUICK_REPO_PAGES * GITHUB_PAGE_SIZE);
  });
});

describe("cursor commit", () => {
  it("advances the watermark only through an explicit commit after a public scan", async () => {
    const db = await import("../db");
    const { buildScanResult, commitScanCursorsAfterPersist, discardIncrementalCursor } = await import("../scan-core");
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `DELETE FROM scan_source_cursors WHERE username = ?`,
      args: [LOGIN],
    }).catch(() => undefined);

    process.env.GHFIND_SCAN_INCREMENTAL_ENABLED = "1";
    vi.stubEnv("GITHUB_TOKEN", "fiction-token");
    installCollectFetch([
      { id: "21", pushedAt: "2026-07-02T00:00:00Z", stars: 4 },
      { id: "22", pushedAt: "2026-07-01T00:00:00Z", stars: 2 },
    ]);

    const scan = await buildScanResult(LOGIN, { now: NOW, deadlineMs: 60_000 });
    const before = await loadScanCursors(client, LOGIN);
    expect(before.book.repos).toBeNull();
    expect(JSON.stringify(scan)).not.toContain("pendingScanCursors");

    await commitScanCursorsAfterPersist(scan);
    const after = await loadScanCursors(client, LOGIN);
    expect(after.book.repos?.watermark).toBe("2026-07-02T00:00:00Z");
    expect(after.book.repos?.incrementalRuns).toBe(0);
    expect(after.book.repos?.repos.map((item) => item.id)).toEqual(["21", "22"]);
    expect(after.book.repos?.collection).toBe(PUBLIC_SCAN_COLLECTION_VERSION);
    expect(after.book.schema).toBe(SCAN_CURSOR_SCHEMA_VERSION);

    discardIncrementalCursor(scan);
    const revision = after.book.revision;
    await commitScanCursorsAfterPersist(scan);
    const unchanged = await loadScanCursors(client, LOGIN);
    expect(unchanged.book.revision).toBe(revision);
    expect(unchanged.book.repos?.watermark).toBe("2026-07-02T00:00:00Z");
    void db;
  });

  it("does not write a cursor when the flag is off", async () => {
    const { buildScanResult, commitScanCursorsAfterPersist } = await import("../scan-core");
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    delete process.env.GHFIND_SCAN_INCREMENTAL_ENABLED;
    vi.stubEnv("GITHUB_TOKEN", "fiction-token");
    installCollectFetch([{ id: "31", pushedAt: "2026-07-03T00:00:00Z", stars: 1 }]);
    const scan = await buildScanResult("fiction-flag-off", { now: NOW, deadlineMs: 60_000 });
    await commitScanCursorsAfterPersist(scan);
    const stored = await client.execute({
      sql: `SELECT username FROM scan_source_cursors WHERE username = ?`,
      args: ["fiction-flag-off"],
    });
    expect(stored.rows).toHaveLength(0);
  });

  it("discards a partial quick scan cursor and records only the deepened full page", async () => {
    const { buildScanResult, commitScanCursorsAfterPersist, discardIncrementalCursor } = await import("../scan-core");
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    const username = "fiction-partial";
    process.env.GHFIND_SCAN_INCREMENTAL_ENABLED = "1";
    vi.stubEnv("GITHUB_TOKEN", "fiction-token");
    const many = Array.from({ length: QUICK_REPO_PAGES * GITHUB_PAGE_SIZE + 1 }, (_, index) => ({
      id: String(400 + index),
      pushedAt: `2026-07-${String((index % 27) + 1).padStart(2, "0")}T00:00:00Z`,
      stars: index < 2 ? 3 : 0,
    }));
    installCollectFetch(many, { publicRepos: many.length + 50 });
    const partial = await buildScanResult(username, { now: NOW, deadlineMs: 60_000 });
    expect(partial.collection?.coverage).toBe("partial_public");
    await commitScanCursorsAfterPersist(partial);
    const staged = await loadScanCursors(client, username);
    expect(staged.book.repos).toBeNull();

    discardIncrementalCursor(partial);
    installCollectFetch(many.slice(0, 3), { publicRepos: 3, login: username });
    const full = await buildScanResult(username, { full: true, now: NOW, deadlineMs: 60_000 });
    expect(full.collection?.mode).toBe("full");
    await commitScanCursorsAfterPersist(full);
    const stored = await loadScanCursors(client, username);
    expect(stored.book.repos?.incrementalRuns).toBe(0);
    expect(stored.book.repos?.repos.map((item) => item.id)).toEqual(many.slice(0, 3).map((item) => item.id));
    expect(stored.book.repos?.watermark).toBe("2026-07-03T00:00:00Z");
  });

  it("reconciles a missing, corrupt, wrong-schema, or old cursor as a full inventory read", () => {
    expect(planInventoryCursor(book(null), NOW).full).toBe(true);
    expect(planInventoryCursor(book(null), NOW).reason).toBe("cursor_missing");
    expect(planInventoryCursor(book(mark({ watermark: "not-a-time" })), NOW).reason).toBe("cursor_corrupt");
    expect(planInventoryCursor(book(mark({ collection: "v6" })), NOW).reason).toBe("collection_version");
    const wrongSchema = book(mark());
    wrongSchema.schema = 0;
    expect(planInventoryCursor(wrongSchema, NOW).full).toBe(true);
    expect(planInventoryCursor(wrongSchema, NOW).since).toBe("");
    const usable = planInventoryCursor(book(mark()), NOW);
    expect(usable.full).toBe(false);
    expect(usable.since).toBe("2026-07-01T00:00:00Z");
  });
});

function installCollectFetch(
  inventory: { id: string; pushedAt: string; stars: number }[],
  options: { publicRepos?: number; login?: string } = {},
) {
  vi.stubGlobal("fetch", async (raw: string, init?: RequestInit) => {
    const url = new URL(raw);
    const login = url.pathname.split("/")[2] ?? LOGIN;
    if (url.pathname === `/users/${login}`) {
      return Response.json({
        login,
        id: 910001,
        public_repos: options.publicRepos ?? inventory.length,
        created_at: "2020-01-01T00:00:00Z",
        followers: 1,
        following: 1,
        bio: "Fictional cursor account",
        html_url: `https://github.com/${login}`,
        avatar_url: null,
        name: null,
        company: null,
      });
    }
    if (url.pathname.endsWith("events/public")) return Response.json([]);
    if (url.pathname !== "/graphql") return new Response("{}", { status: 404 });
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables?: { after?: string | null };
    };
    const pageInfo = { hasNextPage: false, endCursor: null };
    if (query.includes("query OriginalInventory")) {
      const start = Number(variables?.after ?? 0);
      const end = Math.min(inventory.length, start + GITHUB_PAGE_SIZE);
      return Response.json({
        data: {
          user: {
            forks: { totalCount: 0 },
            repositories: {
              nodes: inventory.slice(start, end).map((item) => ({
                databaseId: Number(item.id),
                name: `fiction-repo-${item.id}`,
                nameWithOwner: `${login}/fiction-repo-${item.id}`,
                isFork: false,
                diskUsage: 12,
                stargazerCount: item.stars,
                forkCount: 0,
                description: "Fictional repo",
                pushedAt: item.pushedAt,
                primaryLanguage: { name: "Go" },
                issues: { totalCount: 0 },
                openPullRequests: { totalCount: 0 },
                repositoryTopics: { nodes: [] },
              })),
              pageInfo: { hasNextPage: end < inventory.length, endCursor: end < inventory.length ? String(end) : null },
            },
          },
        },
      });
    }
    if (query.includes("totalCommitContributions")) {
      return Response.json({
        data: {
          user: {
            pinnedItems: { nodes: [] },
            mergedPRs: { totalCount: 0 },
            allPRs: { totalCount: 0 },
            closedPRs: { totalCount: 0, nodes: [] },
            issues: { totalCount: 0 },
            contributionYears: { contributionYears: [] },
            contributionsCollection: {
              totalCommitContributions: 0,
              totalPullRequestContributions: 0,
              totalIssueContributions: 0,
              totalPullRequestReviewContributions: 0,
              contributionCalendar: { totalContributions: 0 },
            },
          },
        },
      });
    }
    return Response.json({
      data: {
        user: { pullRequests: { nodes: [], pageInfo }, organizations: { nodes: [] } },
        search: { issueCount: 0, nodes: [], pageInfo },
        repository: null,
      },
    });
  });
}
