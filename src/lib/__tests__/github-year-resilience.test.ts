import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchCommitContribReposByYear, GitHubInternalQueryError, GitHubQueryTimeoutError } from "../github";

beforeEach(() => vi.stubEnv("GITHUB_TOKEN", "test-token"));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const json = (body: unknown) => new Response(JSON.stringify(body));
const failure = (kind: number | string) => typeof kind === "number"
  ? new Response("gateway timeout", { status: kind })
  : json({ errors: [{ type: kind, message: kind }] });
const yearData = (commits: number) => json({ data: { user: { y0: {
  commitContributionsByRepository: [{ contributions: { totalCount: commits }, repository: {
    nameWithOwner: "org/project", stargazerCount: 500, isPrivate: false, isFork: false, owner: { login: "org" },
  } }],
} } } });

it.each([502, 504, "INTERNAL", "RESOURCE_LIMITS_EXCEEDED"])("splits oversized year query on %s once and preserves each year's contribution", async (kind) => {
  const calls: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const { variables } = JSON.parse(init.body);
    const count = Object.keys(variables).filter((key) => key.startsWith("from")).length;
    calls.push(count);
    if (count > 1) return failure(kind);
    return yearData(variables.from0.startsWith("2026") ? 10 : 20);
  }));
  const result = await fetchCommitContribReposByYear("busy", [2025, 2026]);
  expect(calls).toEqual([2, 1, 1]);
  expect(result).toEqual([expect.objectContaining({ commits: 30, active_years: 2, repo: "org/project" })]);
});

it.each([502, 504, "INTERNAL"])("does not silently drop a single year still failing with %s", async (kind) => {
  const fetchMock = vi.fn(async () => failure(kind)); vi.stubGlobal("fetch", fetchMock);
  await expect(fetchCommitContribReposByYear("busy", [2026, 2025])).rejects.toBeInstanceOf(
    typeof kind === "number" ? GitHubQueryTimeoutError : GitHubInternalQueryError,
  );
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("preserves existing resource-limit degradation for an unqueryable split year", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const { variables } = JSON.parse(init.body);
    if (variables.from1 || variables.from0.startsWith("2025")) return failure("RESOURCE_LIMITS_EXCEEDED");
    return yearData(10);
  }));
  expect(await fetchCommitContribReposByYear("busy", [2026, 2025])).toEqual([
    expect.objectContaining({ commits: 10, active_years: 1 }),
  ]);
});

it("does not retry or recursively split a single-year timeout", async () => {
  const fetchMock = vi.fn(async () => failure(504)); vi.stubGlobal("fetch", fetchMock);
  await expect(fetchCommitContribReposByYear("busy", [2026])).rejects.toBeInstanceOf(GitHubQueryTimeoutError);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
