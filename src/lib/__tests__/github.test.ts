import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collect, GitHubDataUnavailableError } from "../github";

const originalToken = process.env.GITHUB_TOKEN;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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
});
