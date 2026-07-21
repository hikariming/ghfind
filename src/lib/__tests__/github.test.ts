import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  boundedContributionYearsActive,
  collect,
  fetchDurablePullRequestPage,
  ghFetch,
  githubTokens,
  GitHubDataUnavailableError,
  hasGithubToken,
} from "../github";

const originalToken = process.env.GITHUB_TOKEN;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("boundedContributionYearsActive", () => {
  const now = new Date("2026-07-01T00:00:00Z");

  it("counts contribution calendar years only within the account lifetime", () => {
    expect(
      boundedContributionYearsActive(
        [2027, 2026, 2025, 2024, 2023],
        "2024-05-01T00:00:00Z",
        now,
      ),
    ).toBe(3);
  });

  it("allows short-lived accounts to span adjacent calendar contribution years", () => {
    expect(
      boundedContributionYearsActive(
        [2026, 2025],
        "2025-12-31T00:00:00Z",
        new Date("2026-01-01T00:00:00Z"),
      ),
    ).toBe(2);
    expect(boundedContributionYearsActive([], "2025-12-31T00:00:00Z", now)).toBe(0);
  });

  it("dedupes repeated contribution years before bounding", () => {
    expect(boundedContributionYearsActive([2026, 2026, 2025], "2020-01-01T00:00:00Z", now)).toBe(2);
  });
});

describe("collect", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    vi.unstubAllGlobals();
  });

  it("fails when required GitHub GraphQL data is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "https://api.github.com/users/alice") {
          return jsonResponse({
            login: "alice",
            id: 1,
            html_url: "https://github.com/alice",
            avatar_url: null,
            name: null,
            bio: null,
            company: null,
            created_at: "2020-01-01T00:00:00Z",
            followers: 0,
            following: 0,
            public_repos: 0,
          });
        }

        if (url.includes("/users/alice/repos")) {
          return jsonResponse([]);
        }

        if (url === "https://api.github.com/graphql") {
          return jsonResponse({ errors: [{ message: "temporary outage" }] });
        }

        return jsonResponse({}, 404);
      }),
    );

    await expect(collect("alice")).rejects.toBeInstanceOf(GitHubDataUnavailableError);
  });

  it("uses public events for activity recency when owned repo pushes are stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00Z"));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "https://api.github.com/users/active") {
          return jsonResponse({
            login: "active",
            id: 3,
            html_url: "https://github.com/active",
            avatar_url: null,
            name: null,
            bio: null,
            company: null,
            created_at: "2020-01-01T00:00:00Z",
            followers: 0,
            following: 0,
            public_repos: 1,
          });
        }

        if (url.includes("/users/active/repos")) {
          return jsonResponse([
            {
              name: "old-fork",
              full_name: "active/old-fork",
              private: false,
              fork: true,
              size: 1,
              stargazers_count: 0,
              forks_count: 0,
              open_issues_count: 0,
              language: null,
              description: null,
              pushed_at: "2023-09-01T00:00:00Z",
              owner: { login: "active" },
              topics: [],
            },
          ]);
        }

        if (url === "https://api.github.com/users/active/events/public?per_page=30") {
          return jsonResponse([
            {
              type: "IssueCommentEvent",
              created_at: "2026-07-18T10:30:00Z",
              repo: { name: "upstream/project" },
            },
          ]);
        }

        if (url === "https://api.github.com/graphql") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
          const query = body.query ?? "";

          if (query.includes("organizations(first: 20)")) {
            return jsonResponse({ data: { user: { organizations: { nodes: [] } } } });
          }

          if (query.includes("pullRequests(first: $count, states: MERGED")) {
            return jsonResponse({
              data: {
                user: {
                  pullRequests: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            });
          }

          if (
            query.includes("pullRequests(first: $count, orderBy: {field: CREATED_AT, direction: DESC})")
          ) {
            return jsonResponse({ data: { user: { pullRequests: { nodes: [] } } } });
          }

          if (
            query.includes("mergedPRs: pullRequests") &&
            query.includes("pinnedItems(first: 6, types: REPOSITORY)")
          ) {
            return jsonResponse({
              data: {
                user: {
                  pinnedItems: { nodes: [] },
                  mergedPRs: { totalCount: 0 },
                  allPRs: { totalCount: 0 },
                  closedPRs: { totalCount: 0, nodes: [] },
                  issues: { totalCount: 0 },
                  contributionsCollection: {
                    totalCommitContributions: 0,
                    totalPullRequestContributions: 0,
                    totalIssueContributions: 1,
                    totalPullRequestReviewContributions: 0,
                    restrictedContributionsCount: 0,
                    contributionCalendar: { totalContributions: 1 },
                  },
                  contributionYears: { contributionYears: [] },
                },
              },
            });
          }

          return jsonResponse({ data: { user: null } });
        }

        return jsonResponse({}, 404);
      }),
    );

    const result = await collect("active");

    expect(result.metrics.days_since_last_activity).toBe(0);
  });

  it("splits the contribution query when GitHub reports RESOURCE_LIMITS_EXCEEDED", async () => {
    let combinedAttempts = 0;
    let boundedMergedAggregationCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "https://api.github.com/users/hyper") {
          return jsonResponse({
            login: "hyper",
            id: 2,
            html_url: "https://github.com/hyper",
            avatar_url: null,
            name: null,
            bio: null,
            company: null,
            created_at: "2019-07-21T00:00:00Z",
            followers: 189,
            following: 13,
            public_repos: 44,
          });
        }

        if (url.includes("/users/hyper/repos")) {
          return jsonResponse([]);
        }

        if (url === "https://api.github.com/graphql") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
          const query = body.query ?? "";

          // Combined overview+stats query: the account is too active for
          // GitHub's per-query resource budget.
          if (query.includes("totalCommitContributions")) {
            combinedAttempts += 1;
            return jsonResponse({
              data: { user: null },
              errors: [
                {
                  type: "RESOURCE_LIMITS_EXCEEDED",
                  message: "Resource limits for this query exceeded.",
                },
              ],
            });
          }

          // Degraded overview refetch (no stat fields).
          if (query.includes("contributionYears")) {
            return jsonResponse({
              data: {
                user: {
                  pinnedItems: { nodes: [] },
                  mergedPRs: { totalCount: 480 },
                  allPRs: { totalCount: 520 },
                  closedPRs: { totalCount: 0, nodes: [] },
                  issues: { totalCount: 220 },
                  contributionYears: { contributionYears: [2026, 2025] },
                },
              },
            });
          }

          // Single-field calendar query still succeeds on its own.
          if (query.includes("contributionCalendar")) {
            return jsonResponse({
              data: {
                user: {
                  contributionsCollection: {
                    contributionCalendar: { totalContributions: 7810 },
                  },
                },
              },
            });
          }

          if (query.includes("contributionsCollection(from:")) {
            return jsonResponse({
              data: {
                user: {
                  y0: { commitContributionsByRepository: [] },
                  y1: { commitContributionsByRepository: [] },
                },
              },
            });
          }

          if (query.includes("organizations(first:")) {
            return jsonResponse({ data: { user: { organizations: { nodes: [] } } } });
          }

          if (query.includes("pullRequests(first: $count, states: MERGED, after:")) {
            boundedMergedAggregationCalls += 1;
            return jsonResponse({ data: { user: { pullRequests: { nodes: [] } } } });
          }

          if (query.includes("pullRequests(first:")) {
            return jsonResponse({ data: { user: { pullRequests: { nodes: [] } } } });
          }

          return jsonResponse({ data: { user: null } });
        }

        return jsonResponse({}, 404);
      }),
    );

    const result = await collect("hyper");

    expect(combinedAttempts).toBe(1);
    expect(result.metrics.last_year_contributions).toBe(7810);
    expect(result.metrics.merged_pr_count).toBe(480);
    expect(result.metrics.issues_created).toBe(220);
    expect(result.metrics.merged_pr_contribution_aggregation_incomplete).toBe(true);
    expect(boundedMergedAggregationCalls).toBe(0);
    // Approximated diversity: contributions + PRs + issues (reviews unknowable).
    expect(result.metrics.activity_type_count).toBe(3);
  });

  it("attributes strongly maintained organization repos as original-project candidates", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url === "https://api.github.com/users/dev") {
        return jsonResponse({
          login: "dev",
          id: 1,
          html_url: "https://github.com/dev",
          avatar_url: null,
          name: null,
          bio: null,
          company: null,
          created_at: "2020-01-01T00:00:00Z",
          followers: 0,
          following: 0,
          public_repos: 0,
        });
      }

      if (url.includes("/users/dev/repos")) {
        return jsonResponse([]);
      }

      if (url === "https://api.github.com/repos/acme/core") {
        return jsonResponse({
          name: "core",
          full_name: "acme/core",
          private: false,
          fork: false,
          size: 5000,
          stargazers_count: 12345,
          forks_count: 100,
          // REST combines open Issues and open PRs in this aggregate.
          open_issues_count: 5,
          language: "Rust",
          description: "Production sync engine with API and tests",
          pushed_at: "2026-06-01T00:00:00Z",
          owner: { login: "acme" },
          topics: ["sync"],
        });
      }

      if (url === "https://api.github.com/repos/acme/core/releases?per_page=10") {
        return jsonResponse([{ author: { login: "dev" }, tag_name: "v1.0.0" }]);
      }

      if (url === "https://api.github.com/repos/acme/core/tags?per_page=5") {
        return jsonResponse([]);
      }

      if (url === "https://api.github.com/repos/acme/core/contents/MAINTAINERS") {
        return jsonResponse({
          content: Buffer.from("@dev maintains the core runtime").toString("base64"),
          encoding: "base64",
        });
      }

      if (url === "https://api.github.com/repos/acme/core/readme") {
        return jsonResponse({
          path: "README.md",
          sha: "abc",
          size: 2000,
          html_url: null,
          content: Buffer.from(`# Core

Production sync engine.

## Installation

Install and configure it.

## Usage

Use the API, run tests, deploy the service, and review the architecture.
${"Useful project detail. ".repeat(50)}
`).toString("base64"),
          encoding: "base64",
        });
      }

      if (url === "https://api.github.com/repos/acme/core/languages") {
        return jsonResponse({ Rust: 1000 });
      }

      if (url === "https://api.github.com/graphql") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
        const query = body.query ?? "";
        if (query.includes("contributionsCollection(from:")) {
          const repo = {
            nameWithOwner: "acme/core",
            stargazerCount: 12345,
            isPrivate: false,
            isFork: false,
            owner: { login: "acme" },
          };
          return jsonResponse({
            data: {
              user: {
                y0: {
                  commitContributionsByRepository: [
                    { repository: repo, contributions: { totalCount: 40 } },
                  ],
                  pullRequestContributionsByRepository: [
                    { repository: repo, contributions: { totalCount: 5 } },
                  ],
                },
                y1: {
                  commitContributionsByRepository: [
                    { repository: repo, contributions: { totalCount: 35 } },
                  ],
                  pullRequestContributionsByRepository: [
                    { repository: repo, contributions: { totalCount: 4 } },
                  ],
                },
              },
            },
          });
        }

        if (query.includes("pullRequests(states: MERGED, first:")) {
          return jsonResponse({ data: { user: { pullRequests: { nodes: [] } } } });
        }

        if (query.includes("issues(states: OPEN)")) {
          return jsonResponse({ data: { r0: { issues: { totalCount: 0 } } } });
        }

        if (query.includes("pullRequests(first:")) {
          return jsonResponse({ data: { user: { pullRequests: { nodes: [] } } } });
        }

        if (query.includes("repository(owner:")) {
          return jsonResponse({
            data: {
              repository: {
                stargazerCount: 12345,
                hasIssuesEnabled: true,
                isMirror: false,
                watchers: { totalCount: 300 },
                issues: { totalCount: 800 },
                pullRequests: { totalCount: 400 },
              },
            },
          });
        }

        return jsonResponse({
          data: {
            user: {
              pinnedItems: { nodes: [] },
              organizations: { nodes: [{ login: "acme" }] },
              mergedPRs: { totalCount: 0 },
              allPRs: { totalCount: 0 },
              closedPRs: { totalCount: 0, nodes: [] },
              issues: { totalCount: 0 },
              contributionsCollection: {
                totalCommitContributions: 0,
                totalPullRequestContributions: 0,
                totalIssueContributions: 0,
                totalPullRequestReviewContributions: 0,
                restrictedContributionsCount: 0,
                contributionCalendar: { totalContributions: 0 },
              },
              contributionYears: { contributionYears: [2026, 2025] },
            },
          },
        });
      }

      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await collect("dev");

    expect(result.metrics.attributed_original_repo_count).toBe(1);
    expect(result.metrics.nonempty_original_repo_count).toBe(1);
    expect(result.metrics.total_stars).toBe(12345);
    // Engagement of the top-starred repo: (300 + 800 + 400) / 12345
    expect(result.metrics.top_repo_engagement_ratio).toBeCloseTo(0.1215, 3);
    expect(result.top_repos[0]).toMatchObject({
      name: "core",
      owner_login: "acme",
      name_with_owner: "acme/core",
      attributed_original: true,
      open_issue_count: 0,
    });
    expect(result.top_repos[0].attribution_evidence?.join(" ")).toContain("75 commits");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/core/readme",
      expect.anything(),
    );
  });

  it("does not count unmerged PR contribution graph entries as high-star impact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "https://api.github.com/users/lamp") {
          return jsonResponse({
            login: "lamp",
            id: 1,
            html_url: "https://github.com/lamp",
            avatar_url: null,
            name: "Lamp",
            bio: null,
            company: null,
            created_at: "2020-01-01T00:00:00Z",
            followers: 0,
            following: 0,
            public_repos: 0,
          });
        }

        if (url.includes("/users/lamp/repos")) {
          return jsonResponse([]);
        }

        if (url === "https://api.github.com/graphql") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
          const query = body.query ?? "";

          if (query.includes("organizations(first: 20)")) {
            return jsonResponse({ data: { user: { organizations: { nodes: [] } } } });
          }

          if (query.includes("contributionsCollection(from:")) {
            expect(query).not.toContain("pullRequestContributionsByRepository");
            return jsonResponse({
              data: {
                user: {
                  y0: {
                    commitContributionsByRepository: [],
                    // This used to be the source of the bug: GitHub's PR
                    // contribution graph can include opened-but-unmerged PRs.
                    // The scanner must ignore it for landed impact.
                    pullRequestContributionsByRepository: [
                      {
                        contributions: { totalCount: 1 },
                        repository: {
                          nameWithOwner: "trekhleb/javascript-algorithms",
                          stargazerCount: 196000,
                          isPrivate: false,
                          isFork: false,
                          owner: { login: "trekhleb" },
                        },
                      },
                    ],
                  },
                },
              },
            });
          }

          if (
            query.includes("mergedPRs: pullRequests") &&
            query.includes("pinnedItems(first: 6, types: REPOSITORY)")
          ) {
            return jsonResponse({
              data: {
                user: {
                  pinnedItems: { nodes: [] },
                  mergedPRs: { totalCount: 0 },
                  allPRs: { totalCount: 1 },
                  closedPRs: {
                    totalCount: 1,
                    nodes: [
                      {
                        author: { login: "lamp" },
                        repository: { owner: { login: "trekhleb" } },
                        timelineItems: { nodes: [{ actor: { login: "lamp" } }] },
                      },
                    ],
                  },
                  issues: { totalCount: 0 },
                  contributionsCollection: {
                    totalCommitContributions: 0,
                    totalPullRequestContributions: 1,
                    totalIssueContributions: 0,
                    totalPullRequestReviewContributions: 0,
                    restrictedContributionsCount: 0,
                    contributionCalendar: { totalContributions: 1 },
                  },
                  contributionYears: { contributionYears: [2023] },
                },
              },
            });
          }

          if (query.includes("pullRequests(first: $count, states: MERGED")) {
            return jsonResponse({
              data: {
                user: {
                  pullRequests: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            });
          }

          if (
            query.includes("pullRequests(first: $count, orderBy: {field: CREATED_AT, direction: DESC})")
          ) {
            return jsonResponse({
              data: {
                user: {
                  pullRequests: {
                    nodes: [
                      {
                        title: "Add fastPoweringBitwise function",
                        repository: { nameWithOwner: "trekhleb/javascript-algorithms" },
                      },
                    ],
                  },
                },
              },
            });
          }
        }

        return jsonResponse({}, 404);
      }),
    );

    const result = await collect("lamp");

    expect(result.metrics.merged_pr_count).toBe(0);
    expect(result.metrics.self_closed_external_pr_count).toBe(1);
    expect(result.metrics.impact_pr_count).toBe(0);
    expect(result.metrics.max_impact_repo_stars).toBe(0);
    expect(result.impact_repos).toEqual([]);
  });

  it("degrades gracefully when organization lookup lacks read:org scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "https://api.github.com/users/alice") {
          return jsonResponse({
            login: "alice",
            id: 1,
            html_url: "https://github.com/alice",
            avatar_url: null,
            name: "Alice",
            bio: null,
            company: null,
            created_at: "2020-01-01T00:00:00Z",
            followers: 1,
            following: 0,
            public_repos: 0,
          });
        }

        if (url.includes("/users/alice/repos")) {
          return jsonResponse([]);
        }

        if (url === "https://api.github.com/graphql") {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            query?: string;
          };

          if (body.query?.includes("organizations(first: 20)")) {
            return jsonResponse({
              errors: [
                {
                  type: "INSUFFICIENT_SCOPES",
                  message:
                    "The 'login' field requires one of the following scopes: ['read:org']",
                },
              ],
            });
          }

          if (
            body.query?.includes("mergedPRs: pullRequests") &&
            body.query?.includes("pinnedItems(first: 6, types: REPOSITORY)")
          ) {
            return jsonResponse({
              data: {
                user: {
                  pinnedItems: { nodes: [] },
                  mergedPRs: { totalCount: 0 },
                  allPRs: { totalCount: 0 },
                  closedPRs: { totalCount: 0, nodes: [] },
                  issues: { totalCount: 0 },
                  contributionsCollection: {
                    totalCommitContributions: 0,
                    totalPullRequestContributions: 0,
                    totalIssueContributions: 0,
                    totalPullRequestReviewContributions: 0,
                    restrictedContributionsCount: 0,
                    contributionCalendar: { totalContributions: 0 },
                  },
                  contributionYears: { contributionYears: [] },
                },
              },
            });
          }

          if (body.query?.includes("pullRequests(first: $count, states: MERGED")) {
            return jsonResponse({
              data: {
                user: {
                  pullRequests: { nodes: [] },
                },
              },
            });
          }

          if (
            body.query?.includes("pullRequests(first: $count, orderBy: {field: CREATED_AT, direction: DESC})")
          ) {
            return jsonResponse({
              data: {
                user: {
                  pullRequests: { nodes: [] },
                },
              },
            });
          }
        }

        return jsonResponse({}, 404);
      }),
    );

    const result = await collect("alice");

    expect(result.organizations).toEqual([]);
    expect(result.metrics.username).toBe("alice");
  });
});

describe("fetchDurablePullRequestPage", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "test-token";
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    vi.unstubAllGlobals();
  });

  it("returns durable merged PR facts and an opaque resume cursor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://api.github.com/graphql") {
          return jsonResponse({
            data: {
              user: {
                pullRequests: {
                  nodes: [
                    {
                      id: "PR_node_1",
                      title: "refactor: durable history",
                      createdAt: "2024-01-01T00:00:00Z",
                      mergedAt: "2024-01-02T00:00:00Z",
                      closedAt: "2024-01-02T00:00:00Z",
                      additions: 30,
                      deletions: 10,
                      changedFiles: 4,
                      labels: null,
                      repository: {
                        nameWithOwner: "upstream/project",
                        stargazerCount: 900,
                        isPrivate: false,
                        isFork: false,
                        owner: { login: "upstream" },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "opaque-cursor" },
                },
              },
            },
          });
        }
        return jsonResponse({}, 404);
      }),
    );

    await expect(
      fetchDurablePullRequestPage({ username: "history-heavy", state: "MERGED" }),
    ).resolves.toEqual({
      facts: [
        {
          pullRequestId: "PR_node_1",
          source: "native_merged",
          repoKey: "upstream/project",
          ownerLogin: "upstream",
          stars: 900,
          isPrivate: false,
          isFork: false,
          createdAt: "2024-01-01T00:00:00Z",
          mergedAt: "2024-01-02T00:00:00Z",
          closedAt: "2024-01-02T00:00:00Z",
          title: "refactor: durable history",
          additions: 30,
          deletions: 10,
          changedFiles: 4,
          labels: [],
        },
      ],
      hasNextPage: true,
      endCursor: "opaque-cursor",
    });
  });
});

describe("githubTokens / token pool", () => {
  afterEach(() => {
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    vi.unstubAllGlobals();
  });

  it("parses a single token", () => {
    process.env.GITHUB_TOKEN = "ghp_solo";
    expect(githubTokens()).toEqual(["ghp_solo"]);
    expect(hasGithubToken()).toBe(true);
  });

  it("parses a comma-separated pool, trimming whitespace and dropping empties", () => {
    process.env.GITHUB_TOKEN = " ghp_a , ghp_b ,, ghp_c ,";
    expect(githubTokens()).toEqual(["ghp_a", "ghp_b", "ghp_c"]);
  });

  it("treats an absent or blank token as an empty pool", () => {
    delete process.env.GITHUB_TOKEN;
    expect(githubTokens()).toEqual([]);
    expect(hasGithubToken()).toBe(false);
    process.env.GITHUB_TOKEN = "   ,  , ";
    expect(githubTokens()).toEqual([]);
    expect(hasGithubToken()).toBe(false);
  });
});

describe("ghFetch rotation + failover", () => {
  afterEach(() => {
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    vi.unstubAllGlobals();
  });

  function authOf(init?: RequestInit): string | undefined {
    return (init?.headers as Record<string, string> | undefined)?.Authorization;
  }

  it("round-robins the Authorization token across sequential requests", async () => {
    process.env.GITHUB_TOKEN = "t1,t2,t3";
    const seen: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        seen.push(authOf(init));
        return jsonResponse({ ok: true });
      }),
    );

    // Three successful (non-retried) requests should touch three distinct tokens.
    await ghFetch("https://api.github.com/x");
    await ghFetch("https://api.github.com/x");
    await ghFetch("https://api.github.com/x");

    expect(new Set(seen)).toEqual(new Set(["Bearer t1", "Bearer t2", "Bearer t3"]));
  });

  it("fails over to the next token on a drained rate limit and returns the eventual 200", async () => {
    process.env.GITHUB_TOKEN = "t1,t2";
    const auths: (string | undefined)[] = [];
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      auths.push(authOf(init));
      if (auths.length === 1) {
        // Hard rate limit: 403 with the quota drained → retryable.
        return new Response("{}", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        });
      }
      return jsonResponse({ recovered: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await ghFetch("https://api.github.com/x");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recovered: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry used a *different* token than the rate-limited attempt.
    expect(auths[0]).not.toBe(auths[1]);
  });

  it("fails over past a rejected (401) token to a live one", async () => {
    process.env.GITHUB_TOKEN = "dead,live";
    const auths: (string | undefined)[] = [];
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      auths.push(authOf(init));
      if (auths.length === 1) return new Response("{}", { status: 401 });
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await ghFetch("https://api.github.com/x");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auths[0]).not.toBe(auths[1]);
  });

  it("does not retry a definitive 404", async () => {
    process.env.GITHUB_TOKEN = "t1,t2";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await ghFetch("https://api.github.com/x");

    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
