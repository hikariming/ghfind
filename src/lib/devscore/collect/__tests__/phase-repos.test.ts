import { describe, expect, it } from "vitest";
import { memoryCollectStore } from "@/lib/devscore-store";
import { Http } from "../http";
import type { PhaseContext } from "../index";
import type {
  CollectedExtPr,
  ContribsOut,
  ExtPrsOut,
  GapFillOut,
  HistoriesOut,
  HistoryNode,
  MergedPrNode,
  MergedPrsOut,
  MutualMergersOut,
  OwnerTypesOut,
  PerRepoOut,
  PrDetailsOut,
  PrSamplesOut,
  RejectedOut,
  RepoMeta,
  RepoMetaOut,
  SignalsOut,
  StarHistoryOut,
  UserOut,
} from "../outputs";
import {
  commitHeat,
  contributorsCommits,
  fetchCommitHistories,
  fetchDependents,
  fetchStarHistory,
  runAssemble,
  runExtPrs,
  runPerRepo,
  runStarHistory,
  sampleCommits,
} from "../phase-repos";
import type { CollectPhase, CollectState } from "../types";

type Answer = [number, unknown, Record<string, string>?];
type Req = { url: string; headers: Record<string, string>; body: { query: string; variables: Record<string, unknown> } | null };

/** Http over a fake network: `answer` gets the URL (GitHub REST path, "graphql", or a full URL) and the request. */
function fakeHttp(answer: (req: Req) => Answer): { http: Http; calls: Req[] } {
  const calls: Req[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const req: Req = {
      url: url.replace("https://api.github.com/", ""),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(req);
    const [status, body, headers] = answer(req);
    return new Response(JSON.stringify(body), { status, headers });
  }) as typeof globalThis.fetch;
  return { http: new Http({ fetch, githubTokens: ["t"], store: memoryCollectStore(() => 0), now: () => 0 }, Infinity), calls };
}

const noNetwork = () => fakeHttp((req) => {
  throw new Error(`unexpected request ${req.url}`);
}).http;

describe("contributorsCommits", () => {
  it("sums the login and anonymous entries named like the user, ranks the first, totals from the last page", async () => {
    const { http, calls } = fakeHttp(({ url }) => {
      if (url.endsWith("page=1")) {
        return [
          200,
          [
            { login: "lead", contributions: 300 },
            { type: "Anonymous", name: " Jane Doe ", contributions: 40 },
            { login: "Jane", contributions: 30 },
            { login: "maint", contributions: 100 },
          ],
          { link: '<https://api.github.com/x?per_page=100&anon=1&page=2>; rel="next", <https://api.github.com/x?per_page=100&anon=1&page=3>; rel="last"' },
        ];
      }
      return [200, new Array(7).fill({ login: "x", contributions: 1 })];
    });
    const out = await contributorsCommits(http, "o/r", "jane", new Set(["jane", "jane doe"]), ["Maint", "ghost"]);
    expect(out).toEqual({ uc: 70, rank: 2, total: 207, top: 300, standing: { Maint: 0.3333, ghost: 0 } });
    expect(calls.map((c) => c.url)).toEqual([
      "repos/o/r/contributors?per_page=100&anon=1&page=1",
      "repos/o/r/contributors?per_page=100&anon=1&page=3",
    ]);
  });

  it("is all unknown when the endpoint refuses the repo", async () => {
    const { http } = fakeHttp(() => [403, { message: "too large" }]);
    expect(await contributorsCommits(http, "o/r", "jane", new Set(["jane"]), [])).toEqual({
      uc: null,
      rank: null,
      total: null,
      top: null,
      standing: null,
    });
  });
});

describe("fetchCommitHistories", () => {
  it("follows cursors, flags merges by parents or branch-sync headline, drops unreadable repos", async () => {
    const commit = (oid: string, headline: string, parents = 1) => ({
      oid,
      additions: 3,
      deletions: null,
      committedDate: `2024-01-0${oid.length}T00:00:00Z`,
      messageHeadline: headline,
      parents: { totalCount: parents },
    });
    const hist = (nodes: unknown[], next: string | null) => ({
      defaultBranchRef: { target: { history: { totalCount: 3, pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } },
    });
    const { http, calls } = fakeHttp(({ body }) => {
      const q = body!.query;
      if (q.includes('after: "c1"')) return [200, { data: { h0: hist([commit("ccc", "fix")], null) } }];
      return [200, { data: { h0: hist([commit("a", "feat"), commit("bb", "Merge main into dev")], "c1"), h1: null } }];
    });
    const out = await fetchCommitHistories(http, "U1", ["o/a", "o/gone"]);
    expect(Object.keys(out)).toEqual(["o/a"]);
    expect(out["o/a"]!.total).toBe(3);
    expect(out["o/a"]!.nodes.map((n) => [n.oid, n.merge, n.lines])).toEqual([
      ["a", false, 3],
      ["bb", true, 3],
      ["ccc", false, 3],
    ]);
    expect(out["o/a"]!.sizes[2]).toEqual({ lines: 3, merge: false, at: "2024-01-03T00:00:00Z" });
    expect(calls).toHaveLength(2);
  });
});

describe("sampleCommits + commitHeat", () => {
  const nodes: HistoryNode[] = Array.from({ length: 30 }, (_, i) => ({
    oid: `c${i}`,
    date: `2024-01-${String(30 - i).padStart(2, "0")}T00:00:00Z`,
    merge: i % 5 === 0,
    lines: 1,
  }));

  it("diff-samples COMMIT_SAMPLE non-merge commits spread oldest to newest; failed diffs are skipped", async () => {
    const { http, calls } = fakeHttp(({ url }) => {
      if (url.endsWith("/c1")) return [404, { message: "no" }];
      return [200, { commit: { message: "feat: x" }, files: [{ filename: "src/app/main.rs", additions: 5, deletions: 1 }] }];
    });
    const sample = await sampleCommits(http, "o/r", nodes);
    // 24 non-merge commits, oldest first (c29 … c1): indices round(i*23/11) → 12 distinct picks
    expect(calls).toHaveLength(12);
    expect(calls[0].url).toBe("repos/o/r/commits/c29");
    expect(calls.at(-1)!.url).toBe("repos/o/r/commits/c1");
    expect(sample).toHaveLength(11);
    expect(sample[0]).toEqual({ kind: "core", substance: 6, lines: 6, areas: ["src/app"] });
  });

  it("heat is the busiest area's share of all commits since the window start; null without a total", async () => {
    const raw = [
      { kind: "core", substance: 6, lines: 6, areas: ["src/a", "src/b"] },
      { kind: "docs", substance: 0, lines: 2, areas: [] },
    ];
    const { http } = fakeHttp(({ body }) => {
      expect(body!.query).toContain('since: "2023-09-28T00:00:00Z"');
      return [200, { data: { repository: { defaultBranchRef: { target: { total: { totalCount: 40 }, a0: { totalCount: 10 }, a1: { totalCount: 30 } } } } } }];
    });
    expect(await commitHeat(http, "o/r", raw.map((c) => ({ ...c })), "2023-09-28T00:00:00Z")).toEqual([
      { kind: "core", substance: 6, lines: 6, heat: 0.75 },
      { kind: "docs", substance: 0, lines: 2, heat: null },
    ]);
    const failed = fakeHttp(() => [200, { data: { repository: null } }]).http;
    expect((await commitHeat(failed, "o/r", raw.map((c) => ({ ...c })), "x"))[0].heat).toBeNull();
  });
});

describe("fetchDependents", () => {
  it("counts same-owner packages found by name, and is unknown when every lookup fails", async () => {
    const { http } = fakeHttp(({ url }) => {
      if (url.includes("repository_url=https://github.com/g/lib-nodejs")) return [200, []];
      if (url.endsWith("name=lib-nodejs")) return [404, {}];
      if (url.endsWith("name=lib")) {
        return [200, [
          { name: "lib", repository_url: "https://github.com/g/monorepo", dependent_packages_count: 12, dependent_repos_count: 90 },
          { name: "lib", repository_url: "https://github.com/other/lib", dependent_packages_count: 999, dependent_repos_count: 999 },
        ]];
      }
      return [500, {}];
    });
    expect(await fetchDependents(http, ["g/lib-nodejs"])).toEqual({ "g/lib-nodejs": [12, 90] });
    const down = fakeHttp(() => [404, {}]).http;
    expect(await fetchDependents(down, ["g/x-js"])).toEqual({ "g/x-js": [null, null] });
  });
});

describe("fetchStarHistory", () => {
  it("pages with the star API version, drops zero weeks, sorts ascending; null when page 1 fails", async () => {
    const { http, calls } = fakeHttp(({ url }) =>
      url.includes("page=1")
        ? [200, [{ week: 1700352000, total: 4 }, { week: 1699747200, total: 0 }], { link: '<x?page=2>; rel="next"' }]
        : [200, [{ week: 1699142400, total: 2 }]],
    );
    expect(await fetchStarHistory(http, "o/r")).toEqual([
      ["2023-11-05", 2],
      ["2023-11-19", 4],
    ]);
    expect(calls.map((c) => c.headers["X-GitHub-Api-Version"])).toEqual(["2026-03-10", "2026-03-10"]);
    const failed = fakeHttp(() => [404, { message: "Not Found" }]).http;
    expect(await fetchStarHistory(failed, "o/r")).toBeNull();
  });
});

// ---------------------------------------------------------------- per_repo + assemble over stored outputs

const meta = (name: string, over: Partial<RepoMeta> = {}): RepoMeta => ({
  nameWithOwner: name,
  stargazerCount: 10,
  forkCount: 1,
  isFork: false,
  isPrivate: false,
  owner: { login: name.split("/")[0] },
  defaultBranchRef: { target: { history: { totalCount: 100 } } },
  object: { entries: [{ name: "src", type: "tree" }] },
  ...over,
});

const pr = (repo: string, number: number, title: string, mergedAt = "2025-01-02T00:00:00Z"): MergedPrNode => ({
  number,
  title,
  createdAt: "2025-01-01T00:00:00Z",
  mergedAt,
  mergedBy: { login: "boss", __typename: "User" },
  repository: { nameWithOwner: repo, owner: { login: repo.split("/")[0] } },
});

function fixture(): Partial<Record<CollectPhase, unknown>> {
  const prs = [pr("up/lib", 1, "feat: a"), pr("up/lib", 2, "docs: b")];
  const repoMeta: RepoMetaOut = {
    canon: { "me/tool": meta("me/tool", { stargazerCount: 5 }), "up/lib": meta("up/lib", { stargazerCount: 50 }), "up/idle": meta("up/idle") },
    alias: {},
    dropped: [],
    cgCommits: { "me/tool": { "2024-03": 0 } },
    cgPrs: {},
    cgReviews: {},
    maintAll: {},
    maint: {},
    maintSignal: [],
    kinds: { "me/tool": "code", "up/lib": "code", "up/idle": "code" },
    searched: ["up/lib"],
    mergedExternal: 2,
    notes: ["prs_merged_external extrapolated from 2/4 listed merged PRs"],
  };
  const user: UserOut = { id: "U", login: "me", name: null, followers: 3, contributionYears: [], pushed: [], starred: [] };
  return {
    user,
    contribs: { commits: {}, prs: {}, reviews: {} } satisfies ContribsOut,
    gap_fill: { maint: {}, info: null } satisfies GapFillOut,
    merged_prs: {
      total: 4,
      nodes: prs,
      complete: false,
      closed: { total: 10, listed: 4, ext: [], complete: false },
      ext: { prs: [], ids: [], complete: false },
    } satisfies MergedPrsOut,
    repo_meta: repoMeta,
    pr_samples: { "up/lib": { issueCount: 6, nodes: prs } } satisfies PrSamplesOut,
    pr_details: {
      prsByRepo: { "up/lib": { 1: prs[0], 2: prs[1] } },
      details: { "up/lib#1": { additions: 10, deletions: 3, files: ["src/a.ts"], substance: 13 } },
    } satisfies PrDetailsOut,
    mutual_mergers: { mergers: { "up/lib": { boss: 2 } }, mutualByRepo: {} } satisfies MutualMergersOut,
    histories: { "up/lib": { total: 0, nodes: [], sizes: [] } } satisfies HistoriesOut,
    signals: { signalSet: [], contribSet: [], sampleSet: [], signals: {}, dependents: {} } satisfies SignalsOut,
    owner_types: { me: false, up: true } satisfies OwnerTypesOut,
    star_history: { candidates: [], history: {} } satisfies StarHistoryOut,
    rejected: { closedExt: 10, scanned: 4, byOther: 3, closers: {}, sizes: {} } satisfies RejectedOut,
    ext_prs: { prs: [], complete: false } satisfies ExtPrsOut,
  };
}

function fakeCtx(outputs: Partial<Record<CollectPhase, unknown>>, http: Http = noNetwork()): PhaseContext {
  const state: CollectState = { runId: "r", login: "me", startedAt: "2026-09-28T10:00:00Z", phase: "per_repo", progress: 0, waitUntil: null, cursor: null };
  return {
    http,
    state,
    get: async <T,>(p: CollectPhase) => outputs[p] as T,
    saveCursor: () => {},
    log: () => {},
  };
}

describe("runPerRepo + runAssemble", () => {
  it("assembles evidence, scaling and unknowns like collect()", async () => {
    const outputs = fixture();
    outputs.per_repo = await runPerRepo(fakeCtx(outputs));
    const perRepo = outputs.per_repo as PerRepoOut;
    // history total 0 with merged PRs: commits exist under an unlinkable email → unknown
    expect([perRepo["up/lib"].uc, perRepo["up/lib"].src]).toEqual([null, null]);
    // graph months with 0 commits still count as active months
    expect(perRepo["me/tool"].months).toEqual(["2024-03"]);

    const dev = await runAssemble(fakeCtx(outputs));
    // up/idle: no commits, months, PRs, ownership, reviews or maintainer role → dropped
    expect(dev.repos.map((r) => r.name)).toEqual(["up/lib", "me/tool"]);
    const lib = dev.repos[0];
    // 2 PRs classified, 6 merged per the search: kinds scaled to 6, additions scaled from 1 detailed PR
    expect(lib.pr_kinds).toEqual({ core: 3, test: 0, docs: 3, site: 0, chore: 0, merge: 0, data: 0 });
    expect([lib.user_merged_prs, lib.user_additions, lib.user_deletions, lib.additions_estimated]).toEqual([6, 60, 18, true]);
    expect(lib.pr_substance).toEqual([13]);
    expect(lib.recent_months).toBe(1);
    expect(lib.owner_is_org).toBe(true);
    expect(lib.merged_others).toBe(0);
    const tool = dev.repos[1];
    expect([tool.user_merged_prs, tool.user_additions, tool.additions_estimated, tool.user_commits_contrib_graph]).toEqual([0, 0, false, 0]);
    expect(tool.recent_months).toBe(0);
    // rejected extrapolated from the scanned share: round(3 * 10 / 4) = round(7.5) → 8 (half to even)
    expect(dev.prs_rejected_by_maintainer).toBe(8);
    expect(dev.collected_at).toBe("2026-09-28T10:00:00Z");
    expect(dev.notes[0]).toMatch(/^prs_merged_external extrapolated/);
    expect(dev.notes[1]).toBe("prs_rejected_by_maintainer extrapolated from 4/10 closed-unmerged PRs");
    expect(dev.notes.at(-2)).toContain("since 2023-09-28 touching");
    expect(dev.notes.at(-1)).toMatch(/created since 2024-09-28,.*; list INCOMPLETE/);
  });
});

describe("gated enrichment", () => {
  it("star_history: only candidates whose F4 spike can decide rule F get a history", async () => {
    const outputs = fixture();
    const repoMeta = outputs.repo_meta as RepoMetaOut;
    // both owned with 8000 stars and unknown issue authors (F3 cannot settle it); busy was pushed 8 days ago
    repoMeta.canon["me/viral"] = meta("me/viral", { stargazerCount: 8000, pushedAt: "2026-03-01T00:00:00Z" });
    repoMeta.canon["me/busy"] = meta("me/busy", { stargazerCount: 8000, pushedAt: "2026-09-20T00:00:00Z" });
    repoMeta.kinds["me/viral"] = repoMeta.kinds["me/busy"] = "code";
    repoMeta.cgCommits["me/viral"] = { "2026-02": 5 };
    repoMeta.cgCommits["me/busy"] = { "2026-02": 5 };
    outputs.per_repo = await runPerRepo(fakeCtx(outputs));
    const { http, calls } = fakeHttp(() => [200, [{ week: 1772323200, total: 7000 }]]);
    const stars = await runStarHistory(fakeCtx(outputs, http));
    expect(stars.candidates).toEqual(["me/viral"]);
    expect(stars.history["me/viral"]).toEqual([["2026-03-01", 7000]]);
    expect(calls.map((c) => c.url)).toEqual(["repos/me/viral/stargazers/history?per_page=30&page=1"]);
  });

  const listed = (repo: string, state: string): CollectedExtPr => ({
    repo, title: "t", state, created_at: "2026-01-01T00:00:00Z", additions: null, deletions: null, changed_files: null,
    merged_by: state === "MERGED" ? "me" : null, closed_by: null, reviewers: null,
  });

  /** runExtPrs over the scan's ext window `list` (ids = keys) and a `rejected` output; records the node ids asked for. */
  async function extPrs(list: [string, CollectedExtPr][], rejected: Pick<RejectedOut, "closers" | "sizes">) {
    const outputs = fixture();
    outputs.per_repo = await runPerRepo(fakeCtx(outputs));
    const scan = outputs.merged_prs as MergedPrsOut;
    scan.ext = { prs: list.map(([, p]) => p), ids: list.map(([id]) => id), complete: true };
    outputs.rejected = { closedExt: 0, scanned: 0, byOther: 0, ...rejected } satisfies RejectedOut;
    const asked: string[][] = [];
    const { http } = fakeHttp(({ body }) => {
      const ids = body!.variables.ids as string[];
      asked.push(ids);
      return [200, { data: { nodes: ids.map(() => ({ reviews: { nodes: [{ author: { login: "rev", __typename: "User" } }] } })) } }];
    });
    const out = await runExtPrs(fakeCtx(outputs, http));
    // the stored scan output is not modified
    expect(scan.ext.prs.every((p) => p.closed_by === null && p.reviewers === null && p.additions === null)).toBe(true);
    return { ...out, by: new Map(list.map(([id], i) => [id, out.prs[i]])), asked };
  }

  it("ext_prs: closers and sizes once CLOSED PRs reach rej_min, reviewers only on merged PRs of H1 candidates", async () => {
    const merged = Array.from({ length: 20 }, (_, i): [string, CollectedExtPr] => [`m${i}`, listed(i % 2 ? "UP/LIB" : "up/lib", "MERGED")]);
    const closed = Array.from({ length: 20 }, (_, i): [string, CollectedExtPr] => [`c${i}`, listed("o/r", "CLOSED")]);
    const { by, asked } = await extPrs([...merged, ...closed, ["x", listed("other/x", "MERGED")]], {
      closers: { c0: "maint", c1: null, c7: "closer-c7" },
      sizes: { c0: [6000, 1, 60], m3: [5, 2, 1] },
    });
    expect([by.get("c0")!.closed_by, by.get("c1")!.closed_by, by.get("c7")!.closed_by]).toEqual(["maint", null, "closer-c7"]);
    expect([by.get("c0")!.additions, by.get("c0")!.deletions, by.get("c0")!.changed_files]).toEqual([6000, 1, 60]);
    expect([by.get("m3")!.additions, by.get("c1")!.additions]).toEqual([5, null]);
    expect(by.get("m3")!.reviewers).toEqual(["rev"]);
    // other/x is not an assembled repo: no H1, no reviewers; merged PRs get no closer
    expect([by.get("x")!.reviewers, by.get("m3")!.closed_by]).toEqual([null, null]);
    expect(asked.flat().sort()).toEqual(merged.map(([id]) => id).sort());
  });

  it("ext_prs: below rej_min CLOSED and unrev_min_prs merged nothing is fetched or filled in beyond the list", async () => {
    const merged = Array.from({ length: 19 }, (_, i): [string, CollectedExtPr] => [`m${i}`, listed("up/lib", "MERGED")]);
    const closed = Array.from({ length: 19 }, (_, i): [string, CollectedExtPr] => [`c${i}`, listed("o/r", "CLOSED")]);
    const { prs, asked } = await extPrs([...merged, ...closed], { closers: { c0: "maint" }, sizes: { c0: [1, 1, 1] } });
    expect(asked).toEqual([]);
    expect(prs.every((p) => p.closed_by === null && p.reviewers === null && p.additions === null)).toBe(true);
  });
});
