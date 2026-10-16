import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyOwnRepoCommunities,
  collectOwnRepoCommunities,
  computeImpactFromContribMap,
  computeOwnRepoCommunityFacts,
  ownPrCommunityShare,
  ownRepoCommunity,
  type CollectCache,
  type ContribRepoAgg,
  type OwnRepoCommunityContext,
  type OwnRepoCommunityFacts,
  type OwnRepoCommunityRaw,
} from "../github";
import { logRatio } from "../score";
import fixtures from "./community-fixtures.json";

// Shared with internal/backend: raw community samples must produce the same
// facts and community score in TypeScript and Go.
interface CommunityFixture {
  name: string;
  raw: OwnRepoCommunityRaw;
  context: OwnRepoCommunityContext;
  expected_facts: OwnRepoCommunityFacts;
  expected_community: number;
}

const facts = (over: Partial<OwnRepoCommunityFacts> = {}): OwnRepoCommunityFacts => ({
  weighted_contributors: 30,
  sustained_contributors: 10,
  outside_demand: 300,
  merge_latency_days: 1,
  owner_response_share: 1,
  outside_acceptance: 1,
  forks: 1000,
  days_since_outside_merge: 1,
  lead_share: 1,
  ...over,
});

const repo = (over: Partial<ContribRepoAgg>): ContribRepoAgg => ({
  repo: "me/tool",
  stars: 500,
  is_private: false,
  is_fork: false,
  owner_login: "me",
  commits: 300,
  prs: 100,
  active_years: 3,
  months: ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"],
  pr_sample: 10,
  code_pr_sample: 10,
  ...over,
});

describe("own-project community fixtures (TypeScript/Go parity)", () => {
  for (const fixture of fixtures as unknown as CommunityFixture[]) {
    it(fixture.name, () => {
      const computed = computeOwnRepoCommunityFacts(fixture.raw, fixture.context);
      expect(computed).toEqual(fixture.expected_facts);
      expect(ownRepoCommunity(computed)).toBe(fixture.expected_community);
    });
  }

  it("applies every anti-gaming filter in the own-account case", () => {
    const own = (fixtures as unknown as CommunityFixture[])[0];
    // Kept PRs: frank, bob (code), carol (plugin); trivial/doc: bob docs, carol typo.
    // Contributors: bob 1.0 + frank (mutual) 0.5·logRatio(8,10) + carol logRatio(6,10),
    // scaled by the 3/5 substantive share. Bots, the new account, the org
    // insider, the footprint-less and the profile-less accounts are excluded.
    const expected = (1 + 0.5 * logRatio(8, 10) + logRatio(6, 10)) * 0.6;
    expect(own.expected_facts.weighted_contributors).toBeCloseTo(expected, 4);
    expect(own.expected_facts.sustained_contributors).toBe(3);
    expect(own.expected_facts.merge_latency_days).toBe(1);
    expect(own.expected_facts.owner_response_share).toBe(0.5);
    const attributed = (fixtures as unknown as CommunityFixture[])[1];
    expect(attributed.expected_facts.lead_share).toBe(0.75);
  });
});

describe("ownRepoCommunity", () => {
  it("reaches 1 for a large, responsive, recent community", () => {
    expect(ownRepoCommunity(facts())).toBe(1);
  });

  it("is gated by contributors: an audience without builders scores 0", () => {
    expect(ownRepoCommunity(facts({ weighted_contributors: 0 }))).toBe(0);
  });

  it("decays with staleness to a 0.4 floor and scales with lead share", () => {
    expect(ownRepoCommunity(facts({ days_since_outside_merge: 730 }))).toBe(0.4);
    expect(ownRepoCommunity(facts({ days_since_outside_merge: null }))).toBe(0.4);
    expect(ownRepoCommunity(facts({ days_since_outside_merge: 410 }))).toBeCloseTo(0.7, 4);
    expect(ownRepoCommunity(facts({ lead_share: 0.5 }))).toBe(0.5);
  });

  it("lets the modulators move the score between 60% and 100% of the contributor term", () => {
    const bare = facts({
      sustained_contributors: 0,
      outside_demand: 0,
      merge_latency_days: null,
      owner_response_share: 0,
      outside_acceptance: 0,
      forks: 0,
    });
    expect(ownRepoCommunity(bare)).toBe(0.6);
  });
});

describe("community in ecosystem impact and contribution quality", () => {
  it("lets an own repo with a community qualify at 200★ and earn prestige and depth", () => {
    const without = computeImpactFromContribMap([repo({})], "me");
    expect(without.impact_repo_count).toBe(0);
    const withCommunity = computeImpactFromContribMap([repo({ community: 0.8 })], "me");
    expect(withCommunity.impact_repo_count).toBe(1);
    expect(withCommunity.impact_prestige_score).toBe(0.8);
    expect(withCommunity.impact_depth_raw).toBe(2);
  });

  it("never turns own-repo stars into prestige", () => {
    const popular = computeImpactFromContribMap([repo({ stars: 90_000 })], "me");
    expect(popular.impact_prestige_score).toBe(0);
    const engaged = computeImpactFromContribMap([repo({ stars: 90_000, community: 0.5 })], "me");
    expect(engaged.impact_prestige_score).toBe(0.5);
    // Legacy damped star depth stays and the community depth adds on top.
    expect(engaged.impact_depth_raw).toBeCloseTo(popular.impact_depth_raw + 1.25, 2);
  });

  it("credits attributed org originals through their community", () => {
    const attributed = repo({
      repo: "big-org/engine",
      owner_login: "big-org",
      attributed_original: true,
      stars: 70_000,
      community: 0.9,
    });
    expect(computeImpactFromContribMap([attributed], "me").impact_prestige_score).toBe(0.9);
  });

  it("zeroes community for star-inflation suspects", () => {
    const measured = new Map([["me/tool", facts()]]);
    expect(applyOwnRepoCommunities([repo({})], measured, false)[0].community).toBe(1);
    expect(applyOwnRepoCommunities([repo({})], measured, true)[0].community).toBe(0);
    expect(applyOwnRepoCommunities([repo({})], measured, true)[0].community_facts).toEqual(facts());
  });

  it("weights own PRs by the community of the repos they landed in", () => {
    const repos = [
      repo({ prs: 150, community: 0.8 }),
      repo({ repo: "me/side", prs: 50 }),
      repo({ repo: "big-org/engine", owner_login: "big-org", attributed_original: true, prs: 40, community: 1 }),
    ];
    expect(ownPrCommunityShare(repos, "me", 200)).toBe(0.6);
    expect(ownPrCommunityShare(repos, "me", 0)).toBe(0);
  });

});

describe("collectOwnRepoCommunities", () => {
  const originalToken = process.env.GITHUB_TOKEN;
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "test-token";
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    vi.unstubAllGlobals();
  });

  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ...headers } });

  function githubMock(restRemaining = "4000") {
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/repos/me/tool/contributors?per_page=100")) {
        return json(
          [
            { login: "me", type: "User", contributions: 300 },
            { login: "bob", type: "User", contributions: 40 },
          ],
          { "x-ratelimit-remaining": restRemaining },
        );
      }
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
      if (body.query.includes("c0: search")) {
        return json({ data: { rateLimit: { remaining: 4000 }, c0: { issueCount: 12 }, c1: { issueCount: 0 } } });
      }
      if (body.query.includes("forkCount")) {
        return json({ data: { rateLimit: { remaining: 4000 }, repository: { forkCount: 40 }, closed: { issueCount: 3 }, opened: { issueCount: 15 } } });
      }
      if (body.query.includes("... on PullRequest")) {
        return json({ data: { search: { issueCount: 12, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
          { createdAt: "2026-09-01T00:00:00Z", mergedAt: "2026-09-02T00:00:00Z", additions: 40, deletions: 2, title: "fix: retry", files: { nodes: [{ path: "src/net.ts" }] }, author: { __typename: "User", login: "bob" } },
        ] } } });
      }
      if (body.query.includes("... on Issue")) {
        return json({ data: { search: { issueCount: 4, nodes: [
          { createdAt: "2026-09-10T00:00:00Z", author: { __typename: "User", login: "bob" }, comments: { nodes: [{ author: { login: "me" } }] } },
        ] } } });
      }
      if (body.query.includes("u0: user(login:")) {
        expect(body.variables).toEqual({ l0: "bob" });
        return json({ data: { u0: { login: "bob", createdAt: "2018-01-01T00:00:00Z", followers: { totalCount: 50 }, pullRequests: { totalCount: 30 }, organizations: { nodes: [] } } } });
      }
      throw new Error(`unexpected request ${url} ${body.query.slice(0, 80)}`);
    });
  }

  const repos = [repo({}), repo({ repo: "me/quiet", stars: 900 }), repo({ repo: "org/lib", owner_login: "org", stars: 9000 })];

  it("measures own repos with outside merges, caching facts, counts and profiles", async () => {
    const fetchMock = githubMock();
    vi.stubGlobal("fetch", fetchMock);
    const store = new Map<string, { value: unknown; ttl: number }>();
    const cache: CollectCache = {
      get: async <T,>(key: string) => (store.get(key)?.value as T) ?? null,
      set: async (key, value, ttl) => {
        store.set(key, { value, ttl });
      },
    };
    const now = new Date("2026-10-13T12:00:00Z");
    const result = await collectOwnRepoCommunities({ repos, login: "me", ownerOrgs: [], now, cache });
    expect([...result.keys()]).toEqual(["me/tool"]);
    expect(result.get("me/tool")).toMatchObject({ weighted_contributors: 1, outside_acceptance: 0.8, forks: 40, owner_response_share: 1 });
    expect(store.get("community:counts:v1:me")?.ttl).toBe(86400);
    expect(store.get("community:facts:v1:me:me/tool")?.ttl).toBe(7 * 86400);
    expect(store.get("community:profile:v1:bob")?.ttl).toBe(30 * 86400);

    const calls = fetchMock.mock.calls.length;
    const again = await collectOwnRepoCommunities({ repos, login: "me", ownerOrgs: [], now, cache });
    expect(again).toEqual(result);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("stops at the REST floor read from the real response", async () => {
    vi.stubGlobal("fetch", githubMock("120"));
    const result = await collectOwnRepoCommunities({ repos, login: "me", ownerOrgs: [], now: new Date() });
    expect(result.size).toBe(0);
  });
});
