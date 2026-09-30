import { describe, expect, it } from "vitest";
import { memoryCollectStore } from "@/lib/devscore-store";
import { Http } from "../http";
import type { MaintEvents } from "../outputs";
import { gapSeries, monthAdd } from "../classify";
import { fetchMaintainer, fillMaintGaps, gapFillRepos, gapNote } from "../phase-maint";

/** Http over fakes: ClickHouse answers `ch`, GitHub GraphQL answers `gql`. */
function fakeHttp(ch: (sql: string) => string, gql: (query: string) => unknown = () => ({})): Http {
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.includes("clickhouse")) return new Response(ch(String(init?.body)), { status: 200 });
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    return new Response(JSON.stringify({ data: gql(query) }), { status: 200 });
  }) as typeof globalThis.fetch;
  return new Http({ fetch, githubTokens: ["t"], store: memoryCollectStore(() => 0), now: () => 0 }, Infinity);
}

describe("gap helpers (values from collect.py)", () => {
  it("monthAdd crosses year boundaries both ways", () => {
    expect(monthAdd("2026-01", -13)).toBe("2024-12");
    expect(monthAdd("2025-12", 1)).toBe("2026-01");
  });

  it("gapSeries skips zero and gap months when building the trailing median", () => {
    const rate = Object.fromEntries([10, 10, 10, 0, 10, 10, 10, 4, 10, 3, 10, 6].map((v, i) => [monthAdd("2025-01", i), v]));
    expect(gapSeries(rate)).toEqual(["2025-08", "2025-10"]);
  });

  it("gapFillRepos keeps verified-role repos with events from 12 months before the first gap, by events", () => {
    const e = (role: string | null, merged_others: number, months: Record<string, number>): MaintEvents => ({
      role,
      merged_others,
      months,
      by_type: {},
    });
    const raw = {
      "x/a": e(null, 1, { "2024-01": 5, "2025-06": 3 }),
      "x/b": e("MEMBER", 0, { "2025-01": 3 }),
      "x/c": e("OWNER", 0, { "2023-01": 9 }),
      "x/d": e(null, 0, { "2025-05": 99 }),
    };
    expect(gapFillRepos(raw, "2025-12")).toEqual(["x/a", "x/b"]);
  });
});

describe("fetchMaintainer", () => {
  it("folds monthly rows per repo: families, merges of others and the strongest role", async () => {
    const rows = [
      { repo_name: "o/r", ym: 202601, reviews: "2", comments: "3", merged_others: "1", issue_closes: "0", roles: ["COLLABORATOR"] },
      { repo_name: "o/r", ym: 202602, reviews: "0", comments: "1", merged_others: "2", issue_closes: "1", roles: ["OWNER", "MEMBER"] },
    ];
    const http = fakeHttp(() => rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    expect(await fetchMaintainer(http, "u")).toEqual({
      "o/r": {
        role: "OWNER",
        months: { "2026-01": 6, "2026-02": 4 },
        merged_others: 3,
        by_type: {
          "2026-01": { reviews: 2, comments: 3, merged: 1, closes: 0 },
          "2026-02": { reviews: 0, comments: 1, merged: 2, closes: 1 },
        },
      },
    });
  });

  it("is unknown (null) for a login that is not a plain GitHub login", async () => {
    expect(await fetchMaintainer(fakeHttp(() => ""), "a'b")).toBeNull();
  });
});

describe("fillMaintGaps", () => {
  it("raises gap months per family to max(GH Archive, API) exactly like collect.py", async () => {
    // 24 months of totals: all-event gap from 2026-05, recorded-merge gap in 2025-10..11
    const rows = Array.from({ length: 24 }, (_, i) => {
      const m = monthAdd("2024-09", i);
      const total = m >= "2026-05" ? 10 : 100;
      const merged = m === "2025-10" || m === "2025-11" ? 0 : 50;
      return JSON.stringify({ ym: Number(m.replace("-", "")), days: 30, total: total * 30, merged: merged * 30 });
    });
    const gql = (query: string) => {
      if (query.includes("issueComments")) {
        const n = (createdAt: string, updatedAt: string, repo: string) => ({ createdAt, updatedAt, repository: { nameWithOwner: repo } });
        return {
          user: {
            issueComments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                n("2026-06-03T00:00:00Z", "2026-06-03T00:00:00Z", "O/R"),
                n("2026-06-04T00:00:00Z", "2026-06-04T00:00:00Z", "o/r"),
                n("2026-04-04T00:00:00Z", "2026-06-04T00:00:00Z", "o/r"),
              ],
            },
          },
        };
      }
      const out: Record<string, unknown> = {};
      [...query.matchAll(/closed:(\d{4}-\d\d)-01\.\.\S+?( involves:\w+)?\\?"/g)].forEach(([, mo, inv], i) => {
        if (mo === "2026-07" && !inv) out[`s${i}`] = { issueCount: 150, nodes: [] };
        else if (mo === "2026-07")
          out[`s${i}`] = { issueCount: 3, nodes: [{ merged: true, author: { login: "x" }, mergedBy: { login: "U" } }] };
        else
          out[`s${i}`] = {
            issueCount: 2,
            nodes: [
              { merged: true, author: { login: "x" }, mergedBy: { login: "u" } },
              { timelineItems: { nodes: [{ actor: { login: "u" } }] } },
              null,
            ],
          };
      });
      return out;
    };
    const raw: Record<string, MaintEvents> = {
      "o/r": {
        role: "MEMBER",
        merged_others: 1,
        months: { "2025-06": 4, "2026-06": 1 },
        by_type: {
          "2025-06": { reviews: 2, comments: 1, merged: 1, closes: 0 },
          "2026-06": { reviews: 1, comments: 0, merged: 0, closes: 0 },
        },
      },
    };
    const info = await fillMaintGaps(fakeHttp(() => rows.join("\n"), gql), "u", raw, { "O/R": { "2026-06": 5 } }, "2026-09");
    const late = ["2026-05", "2026-06", "2026-07", "2026-08"];
    expect(info).toEqual({
      gaps: { reviews: late, comments: late, merged: ["2025-10", "2025-11", ...late], closes: late },
      checked: 1,
      repos: { "o/r": ["2025-10", "2025-11", ...late] },
    });
    expect(raw["o/r"].merged_others).toBe(7);
    expect(raw["o/r"].months).toEqual({
      "2025-06": 4,
      "2026-06": 9,
      "2025-10": 1,
      "2025-11": 1,
      "2026-05": 2,
      "2026-07": 1,
      "2026-08": 2,
    });
    expect(raw["o/r"].by_type["2026-06"]).toEqual({ reviews: 5, comments: 2, merged: 1, closes: 1 });
    expect(raw["o/r"].by_type["2026-07"]).toEqual({ reviews: 0, comments: 0, merged: 1, closes: 0 });
  });

  it("is unknown when the monthly totals query fails", async () => {
    const fetch = (async () => new Response("quota", { status: 500 })) as typeof globalThis.fetch;
    const http = new Http({ fetch, githubTokens: ["t"], store: memoryCollectStore(() => 0), now: () => 0 }, Infinity);
    // ClickHouse maps non-2xx to status null; the transport's retry backoff is skipped by a zero-length setTimeout stub
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realTimeout(fn, 0)) as typeof setTimeout;
    try {
      expect(await fillMaintGaps(http, "u", {}, {}, "2026-09")).toBeNull();
    } finally {
      globalThis.setTimeout = realTimeout;
    }
  });
});

describe("gapNote", () => {
  it("matches collect.py's wording", () => {
    expect(
      gapNote({
        gaps: { reviews: ["2026-05"], comments: [], merged: ["2025-10", "2026-05"], closes: ["2026-05"] },
        checked: 2,
        repos: { "a/b": ["2026-05", "2025-10"] },
      }),
    ).toBe(
      "v15 gap fill: GH Archive gap months (daily rate < 50% of the trailing median, last 24 months): reviews 2026-05, comments none, merged 2025-10/2026-05, closes 2026-05; 2 verified-role repos (≤ 15) checked against the GitHub API, 1 raised in months 2025-10, 2026-05 (reviews: contributionsCollection; comments: user.issueComments, inline review comments not covered; merges of others' PRs and issue closes: search repo:R closed:<month> (≤ 100 items; larger months: + involves:<login>, a lower bound)); per family max(GH Archive, API)",
    );
    expect(gapNote(null)).toBe("v15 gap fill: GH Archive gap months unknown (ClickHouse failed); maint_* not filled");
  });
});
