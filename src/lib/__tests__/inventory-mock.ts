import { vi } from "vitest";

/** Adapt existing REST-shaped fixture inventories to the v7 GraphQL source.
 * New pagination/fork tests exercise the GraphQL contract directly. */
export function stubGithubFetch(fetcher: typeof fetch): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (!body.query?.includes("query OriginalInventory")) return fetcher(input, init);
    const response = await fetcher(`https://api.github.com/users/${body.variables.login}/repos?per_page=100&sort=pushed&page=1`);
    if (!response.ok) return response;
    const repos = await response.json();
    return Response.json({ data: { user: {
      forks: { totalCount: repos.filter((r: { fork?: boolean }) => r.fork).length },
      repositories: { pageInfo: { hasNextPage: false, endCursor: null },
        nodes: repos.filter((r: { fork?: boolean }) => !r.fork).map((r: Record<string, unknown>) => ({
          name: r.name, nameWithOwner: r.full_name, isFork: false, diskUsage: r.size ?? 0,
          stargazerCount: r.stargazers_count ?? 0, forkCount: r.forks_count ?? 0,
          description: r.description ?? null, pushedAt: r.pushed_at ?? null,
          primaryLanguage: r.language ? { name: r.language } : null,
          issues: { totalCount: r.open_issues_count ?? 0 },
          repositoryTopics: { nodes: ((r.topics ?? []) as string[]).map(name => ({ topic: { name } })) },
        })) },
    } } });
  });
}
