import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  boundedContributionYearsActive,
  collect,
  GitHubDataUnavailableError,
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
          open_issues_count: 12,
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

        if (query.includes("pullRequests(first:")) {
          return jsonResponse({ data: { user: { pullRequests: { nodes: [] } } } });
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
    expect(result.top_repos[0]).toMatchObject({
      name: "core",
      owner_login: "acme",
      name_with_owner: "acme/core",
      attributed_original: true,
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
