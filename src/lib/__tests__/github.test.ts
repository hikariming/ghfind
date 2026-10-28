import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRoastMessages } from "../prompt";
import { score } from "../score";
import {
  boundedContributionYearsActive,
  collect,
  collectImpactCodeSamples,
  fetchDurablePullRequestPage,
  fetchExternalMergedPrs,
  fetchImpactRepoSignals,
  firstCommitHistoryAfter,
  ghFetch,
  githubTokens,
  GitHubDataUnavailableError,
  hasGithubToken,
  parseGithubNoreplyLogin,
  resolveFirstCommitGithubLogin,
} from "../github";

const originalToken = process.env.GITHUB_TOKEN;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function graphqlQuery(init?: RequestInit): string {
  return (JSON.parse(String(init?.body ?? "{}")) as { query?: string }).query ?? "";
}

function coCreatorResponse(commits: number, association = "MEMBER") {
  return jsonResponse({data:{repository:{pullRequests:{totalCount:20},defaultBranchRef:{target:{history:{totalCount:commits*2}}}},search:{issueCount:10,nodes:Array.from({length:3},()=>({authorAssociation:association,changedFiles:1,files:{nodes:[{path:"src/main.go",additions:500,deletions:10}]}}))}}});
}

function firstCommitOrgCollectFetch(input: {
  login: string;
  owner: string;
  name: string;
  stars: number;
  commits: number;
  firstCommitLogin: string;
  member?: boolean;
}) {
  const nameWithOwner = `${input.owner}/${input.name}`;
  const repoNode = {
    nameWithOwner,
    stargazerCount: input.stars,
    isPrivate: false,
    isFork: false,
    owner: { login: input.owner },
  };
  return vi.fn(async (raw: string | URL | Request, init?: RequestInit) => {
    const url = typeof raw === "string" ? raw : raw instanceof URL ? raw.toString() : raw.url;

    if (url === `https://api.github.com/users/${input.login}`) {
      return jsonResponse({
        login: input.login,
        id: 1,
        html_url: `https://github.com/${input.login}`,
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
    if (url.includes(`/users/${input.login}/repos`)) return jsonResponse([]);
    if (url.includes(`/users/${input.login}/events/public`)) return jsonResponse([]);
    if (url === `https://api.github.com/repos/${nameWithOwner}`) {
      return jsonResponse({
        name: input.name,
        full_name: nameWithOwner,
        private: false,
        fork: false,
        size: 400,
        stargazers_count: input.stars,
        forks_count: 2,
        open_issues_count: 1,
        language: "Go",
        description: "Production filesystem runtime with API and tests",
        pushed_at: "2026-01-01T00:00:00Z",
        owner: { login: input.owner, type: "Organization" },
        topics: [],
      });
    }
    if (url.includes(`/repos/${nameWithOwner}/contributors?`)) return jsonResponse([{login:input.login,contributions:input.commits},{login:"other",contributions:input.commits}]);
    if (url.startsWith(`https://api.github.com/repos/${nameWithOwner}/releases`)) {
      return jsonResponse([]);
    }
    if (url.startsWith(`https://api.github.com/repos/${nameWithOwner}/tags`)) {
      return jsonResponse([]);
    }
    if (url === `https://api.github.com/repos/${nameWithOwner}/readme`) {
      return jsonResponse({
        path: "README.md",
        sha: "abc",
        size: 200,
        html_url: null,
        content: Buffer.from(
          "# runtime\n\nInstall the service, configure it, use the API, and run tests.\n",
        ).toString("base64"),
        encoding: "base64",
      });
    }
    if (url === `https://api.github.com/repos/${nameWithOwner}/languages`) {
      return jsonResponse({ Go: 1000 });
    }
    if (url === "https://api.github.com/graphql") {
      const query = graphqlQuery(init);
      if (query.includes("authorAssociation changedFiles")) return coCreatorResponse(input.commits);
      if (query.includes("contributionsCollection(from:")) {
        return jsonResponse({
          data: {
            user: {
              y0: {
                commitContributionsByRepository: [
                  { repository: repoNode, contributions: { totalCount: input.commits } },
                ],
              },
            },
          },
        });
      }
      if (query.includes("organizations(first:")) {
        return jsonResponse({ data: { user: { organizations: { nodes: input.member ? [{login: input.owner}] : [] } } } });
      }
      if (query.includes("pullRequests(first:") && query.includes("states: MERGED")) {
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
      if (query.includes("issues(states: OPEN)")) {
        return jsonResponse({ data: { r0: { issues: { totalCount: 0 } } } });
      }
      if (query.includes("pullRequests(first:")) {
        return jsonResponse({ data: { user: { pullRequests: { nodes: [] } } } });
      }
      if (query.includes("isFork") && query.includes("defaultBranchRef")) {
        return jsonResponse({
          data: {
            repository: {
              isFork: false,
              defaultBranchRef: {
                target: { oid: "cafebabe", history: { totalCount: input.commits } },
              },
            },
          },
        });
      }
      if (query.includes("authoredDate")) {
        return jsonResponse({
          data: {
            repository: {
              defaultBranchRef: {
                target: {
                  history: {
                    nodes: [
                      {
                        oid: "deadbeef",
                        url: `https://github.com/${nameWithOwner}/commit/deadbeef`,
                        authoredDate: "2024-01-01T00:00:00Z",
                        messageHeadline: "init",
                        author: {
                          name: input.firstCommitLogin,
                          email: `1+${input.firstCommitLogin}@users.noreply.github.com`,
                          user: { login: input.firstCommitLogin },
                        },
                        committer: {
                          name: "GitHub",
                          email: "noreply@github.com",
                          user: null,
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        });
      }
      if (query.includes("repository(owner:")) {
        return jsonResponse({
          data: {
            repository: {
              stargazerCount: input.stars,
              hasIssuesEnabled: true,
              isMirror: false,
              watchers: { totalCount: 10 },
              issues: { totalCount: 10 },
              pullRequests: { totalCount: 10 },
            },
          },
        });
      }
      return jsonResponse({
        data: {
          user: {
            pinnedItems: { nodes: [] },
            mergedPRs: { totalCount: 0 },
            allPRs: { totalCount: 0 },
            closedPRs: { totalCount: 0, nodes: [] },
            issues: { totalCount: 0 },
            contributionsCollection: {
              totalCommitContributions: input.commits,
              totalPullRequestContributions: 0,
              totalIssueContributions: 0,
              totalPullRequestReviewContributions: 0,
              restrictedContributionsCount: 0,
              contributionCalendar: { totalContributions: input.commits },
            },
            contributionYears: { contributionYears: [2025] },
          },
        },
      });
    }
    return jsonResponse({}, 404);
  });
}

describe("first-commit identity", () => {
  it("builds the default-branch history cursor from tip oid and length", () => {
    expect(firstCommitHistoryAfter("abc", 1)).toBeNull();
    expect(firstCommitHistoryAfter("abc", 2)).toBe("abc 0");
    expect(firstCommitHistoryAfter("abc", 2706)).toBe("abc 2704");
  });

  it("parses only GitHub noreply mailbox logins", () => {
    expect(parseGithubNoreplyLogin("48499089+fixture-account-070@users.noreply.github.com")).toBe(
      "fixture-account-070",
    );
    expect(parseGithubNoreplyLogin("fixture-account-057@users.noreply.github.com")).toBe("fixture-account-057");
    expect(parseGithubNoreplyLogin("person@example.com")).toBeNull();
  });

  it("resolves GitHub login in author, committer, then noreply order", () => {
    expect(
      resolveFirstCommitGithubLogin({
        authorLogin: "alice",
        committerLogin: "bot",
        authorEmail: "1+other@users.noreply.github.com",
      }),
    ).toEqual({ login: "alice", source: "author.user" });
    expect(
      resolveFirstCommitGithubLogin({
        authorLogin: null,
        committerLogin: "bob",
      }),
    ).toEqual({ login: "bob", source: "committer.user" });
    expect(
      resolveFirstCommitGithubLogin({
        authorEmail: "12+fixture-account-017@users.noreply.github.com",
      }),
    ).toEqual({ login: "fixture-account-017", source: "noreply-email" });
    expect(resolveFirstCommitGithubLogin({ authorEmail: "fixture-account-017@example.com" })).toEqual({
      login: null,
      source: "none",
    });
  });
});

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

  it.each(["she/her", null])("collects profile pronouns (%s) alongside public activity", async (pronouns) => {
    let overviewQuery = "";
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
            overviewQuery = query;
            return jsonResponse({
              data: {
                user: {
                  pronouns,
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
    expect(overviewQuery).toMatch(/\bpronouns\b/);
    expect(result.metrics.pronouns).toBe(pronouns);
    const [, writerInput] = buildRoastMessages({ ...result, scoring: score(result.metrics) }, "en");
    const writerPayload = JSON.parse(writerInput.content.match(/```json\n([\s\S]*)\n```/)![1]);
    expect(writerPayload.metrics.pronouns).toBe(pronouns);
    expect(writerPayload.context_notes.pronoun_usage).toContain("they/them");
  });

  it("splits the contribution query when GitHub reports RESOURCE_LIMITS_EXCEEDED", async () => {
    let overviewQuery = "";
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
            overviewQuery = query;
            return jsonResponse({
              data: {
                user: {
                  pronouns: "they/them",
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

          if (query.includes("pullRequests(first: $count, states: MERGED, after:") && !query.includes("files(first:")) {
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
    expect(overviewQuery).toMatch(/\bpronouns\b/);
    expect(result.metrics.pronouns).toBe("they/them");
    expect(result.metrics.last_year_contributions).toBe(7810);
    expect(result.metrics.merged_pr_count).toBe(480);
    expect(result.metrics.issues_created).toBe(220);
    expect(result.metrics.merged_pr_contribution_aggregation_incomplete).toBe(true);
    expect(boundedMergedAggregationCalls).toBe(1);
    // Approximated diversity: contributions + PRs + issues (reviews unknowable).
    expect(result.metrics.activity_type_count).toBe(3);
  });

  it("keeps the newest 300 merged PRs as an impact lower bound when history is larger", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "https://api.github.com/users/prolific") {
          return jsonResponse({
            login: "prolific",
            id: 4,
            html_url: "https://github.com/prolific",
            avatar_url: null,
            name: null,
            bio: null,
            company: null,
            created_at: "2018-01-01T00:00:00Z",
            followers: 0,
            following: 0,
            public_repos: 0,
          });
        }

        if (url.includes("/users/prolific/repos")) {
          return jsonResponse([]);
        }

        if (url === "https://api.github.com/graphql") {
          const query = graphqlQuery(init);
          if (query.includes("contributionsCollection(from:")) {
            return jsonResponse({
              data: { user: { y0: { commitContributionsByRepository: [] } } },
            });
          }
          if (query.includes("organizations(first:")) {
            return jsonResponse({ data: { user: { organizations: { nodes: [] } } } });
          }
          if (query.includes("pullRequests(first:") && query.includes("states: MERGED") && query.includes("$after")) {
            return jsonResponse({
              data: {
                user: {
                  pullRequests: {
                    nodes: [
                      {
                        mergedAt: "2026-01-02T00:00:00Z",
                        repository: {
                          nameWithOwner: "acme/core",
                          stargazerCount: 12000,
                          isPrivate: false,
                          isFork: false,
                          owner: { login: "acme" },
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            });
          }
          if (query.includes("pullRequests(first:")) {
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
          return jsonResponse({
            data: {
              user: {
                pinnedItems: { nodes: [] },
                mergedPRs: { totalCount: 400 },
                allPRs: { totalCount: 420 },
                closedPRs: { totalCount: 0, nodes: [] },
                issues: { totalCount: 0 },
                contributionsCollection: {
                  totalCommitContributions: 0,
                  totalPullRequestContributions: 0,
                  totalIssueContributions: 0,
                  totalPullRequestReviewContributions: 0,
                  contributionCalendar: { totalContributions: 0 },
                },
                contributionYears: { contributionYears: [2026] },
              },
            },
          });
        }

        return jsonResponse({}, 404);
      }),
    );

    const result = await collect("prolific");

    expect(result.metrics.merged_pr_count).toBe(400);
    expect(result.metrics.merged_pr_contribution_aggregation_incomplete).toBe(true);
    expect(result.metrics.impact_pr_count).toBe(1);
    expect(result.metrics.impact_commit_count).toBe(0);
    expect(result.metrics.max_impact_repo_stars).toBe(12000);
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

      if (url.includes("repos/acme/core/contributors?")) return jsonResponse([{login:"dev",contributions:75},{login:"other",contributions:25}]);
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
        if (query.includes("authorAssociation changedFiles")) return coCreatorResponse(75);
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
    expect(result.metrics.total_stars).toBeGreaterThan(0);
    expect(result.metrics.total_stars).toBeLessThan(12345);
    expect(result.metrics.total_stars).toBeCloseTo(12345*result.top_repos[0].attribution_share!,8);
    // Engagement of the top-starred repo: (300 + 800 + 400) / 12345
    expect(result.metrics.top_repo_engagement_ratio).toBeCloseTo(0.1215, 3);
    expect(result.top_repos[0]).toMatchObject({
      name: "core",
      owner_login: "acme",
      name_with_owner: "acme/core",
      attributed_original: true,
      open_issue_count: 0,
    });
    expect(result.top_repos[0].attribution_evidence?.join(" ")).toContain("75/");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/core/readme",
      expect.anything(),
    );
  });

  it.each([false, true])("preserves founding evidence with organization membership=%s", async (member) => {
    vi.stubGlobal(
      "fetch",
      firstCommitOrgCollectFetch({
        login: "alice",
        owner: "lab",
        name: "layerfs",
        stars: 80,
        commits: 200,
        firstCommitLogin: "alice",
        member,
      }),
    );

    const result = await collect("alice");

    expect(result.metrics.attributed_original_repo_count).toBe(1);
    expect(result.top_repos[0]).toMatchObject({
      name: "layerfs",
      owner_login: "lab",
      name_with_owner: "lab/layerfs",
      attributed_original: true,
    });
    expect(result.top_repos[0].attribution_evidence?.join(" ")).toContain(
      "first commit author is alice",
    );
  });

  it("attributes a substantive co-builder without claiming first authorship", async () => {
    vi.stubGlobal(
      "fetch",
      firstCommitOrgCollectFetch({
        login: "alice",
        owner: "lab",
        name: "sandbox",
        stars: 400,
        commits: 2000,
        firstCommitLogin: "other-dev",
      }),
    );

    const result = await collect("alice");

    expect(result.metrics.attributed_original_repo_count).toBe(1);
    expect(result.top_repos[0].attribution_share).toBeGreaterThan(0);
    expect(result.top_repos[0].attribution_evidence?.join(" ")).not.toContain("first commit author is alice");
    expect(result.top_repos).toHaveLength(1);
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
    expect(result.metrics.github_user_id).toBe("1");
  });
});

describe("fetchImpactRepoSignals", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "test-token";
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    vi.unstubAllGlobals();
  });

  const agg = (repo: string, stars: number, commits: number) => ({
    repo,
    stars,
    is_private: false,
    is_fork: false,
    owner_login: repo.split("/")[0],
    commits,
    prs: 0,
    active_years: 1,
  });
  const repos = [agg("org/engine", 9000, 40), agg("org/tiny", 50, 40), agg("me/own", 500, 40)];

  it("queries only impact-eligible repos and counts multi-parent commits", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
      expect(body.query).toContain("history(first: 100, author: { id: $author })");
      expect(body.variables).toEqual({ author: "U_me", o0: "org", n0: "engine" });
      return jsonResponse({
        data: {
          r0: {
            repositoryTopics: { nodes: [{ topic: { name: "awesome" } }] },
            defaultBranchRef: {
              target: {
                history: {
                  nodes: [
                    { parents: { totalCount: 2 } },
                    { parents: { totalCount: 1 } },
                    { parents: { totalCount: 1 } },
                    { parents: { totalCount: 1 } },
                  ],
                },
              },
            },
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const signals = await fetchImpactRepoSignals(repos, "me", "U_me");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signals.get("org/engine")).toEqual({
      topics: ["awesome"],
      sampled_commits: 4,
      merge_commits: 1,
    });
  });

  it("measures community engagement alongside the merge sample", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: {
            r0: {
              repositoryTopics: { nodes: [] },
              stargazerCount: 9000,
              hasIssuesEnabled: true,
              isMirror: false,
              watchers: { totalCount: 30 },
              issues: { totalCount: 40 },
              pullRequests: { totalCount: 20 },
              defaultBranchRef: null,
            },
          },
        }),
      ),
    );
    const signals = await fetchImpactRepoSignals(repos, "me", "U_me");
    expect(signals.get("org/engine")?.engagement).toBe(0.01);
  });

  it("degrades to no signals on query errors but surfaces rate limits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ errors: [{ message: "timeout" }] })));
    expect((await fetchImpactRepoSignals(repos, "me", "U_me")).size).toBe(0);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "rate limited" }, 429)));
    await expect(fetchImpactRepoSignals(repos, "me", "U_me")).rejects.toThrow();
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

describe("external merged PRs and per-repo code samples", () => {
  beforeEach(() => {
    process.env.GITHUB_TOKEN = "test-token";
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    vi.unstubAllGlobals();
  });

  const repoNode = (nameWithOwner: string, stargazerCount: number) => ({
    nameWithOwner,
    stargazerCount,
    isPrivate: false,
    isFork: false,
    owner: { login: nameWithOwner.split("/")[0] },
  });

  it("searches public merged PRs outside the user's repos", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: { q: string } };
      expect(body.variables.q).toBe("is:pr is:merged is:public author:alice -user:alice sort:created-desc");
      return jsonResponse({
        data: {
          search: {
            issueCount: 2,
            nodes: [
              { id: "PR_1", mergedAt: "2026-01-02T00:00:00Z", repository: repoNode("org/engine", 900) },
              { id: "PR_2", mergedAt: "2026-02-02T00:00:00Z", repository: repoNode("bob/tiny", 3) },
              {},
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchExternalMergedPrs("alice");
    expect(result?.total).toBe(2);
    expect(result?.nodes.map((n) => n.id)).toEqual(["PR_1", "PR_2"]);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ errors: [{ message: "boom" }] })));
    expect(await fetchExternalMergedPrs("alice")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "rate limited" }, 429)));
    await expect(fetchExternalMergedPrs("alice")).rejects.toThrow();
  });

  it("fetches code samples only for impact repos the recent window under-covers", async () => {
    const agg = (repo: string, stars: number, prs: number) => ({
      repo,
      stars,
      is_private: false,
      is_fork: false,
      owner_login: repo.split("/")[0],
      commits: 0,
      prs,
      active_years: 1,
    });
    const codePr = (repo: string) => ({
      title: "fix scheduler",
      repo,
      repo_stars: 5000,
      churn: 40,
      changed_files: 1,
      trivial: false,
      files: ["src/scheduler.ts"],
    });
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
      expect(body.variables).toEqual({ q0: "repo:org/docsy is:pr is:merged author:alice sort:created-desc" });
      return jsonResponse({
        data: {
          s0: {
            nodes: [
              {
                title: "docs: update guide",
                additions: 10,
                deletions: 0,
                changedFiles: 1,
                repository: { nameWithOwner: "org/docsy", stargazerCount: 5000, isPrivate: false },
                files: { nodes: [{ path: "docs/guide.md" }] },
              },
            ],
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const samples = await collectImpactCodeSamples(
      [agg("org/engine", 9000, 1), agg("org/docsy", 5000, 3), agg("org/tiny", 50, 9)],
      "alice",
      [codePr("org/engine")],
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(samples.get("org/engine")).toEqual({ pr_sample: 1, code_pr_sample: 1 });
    expect(samples.get("org/docsy")).toEqual({ pr_sample: 1, code_pr_sample: 0 });
    expect(samples.has("org/tiny")).toBe(false);
  });
});
