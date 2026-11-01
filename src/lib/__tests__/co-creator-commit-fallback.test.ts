import { afterEach, expect, it, vi } from "vitest";
import { fetchCoCreatorCommits } from "../github";

const originalToken = process.env.GITHUB_TOKEN;
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalToken;
});

it("recovers an empty author index with bounded, linked-author evidence", async () => {
  process.env.GITHUB_TOKEN = "fixture-token";
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    calls.push(String(input));
    return Response.json(calls.length === 1 ? [] : [
      { sha: "other", author: { login: "someone" }, committer: { login: "renamed" } },
      { sha: "unlinked", author: null, commit: { author: { name: "renamed", email: "renamed@example.com" } } },
      ...[1, 2, 3, 4].map(n => ({ sha: `mine${n}`, author: { login: "Renamed" }, parents: [{}] })),
    ]);
  }));
  expect((await fetchCoCreatorCommits("org", "tool", "renamed")).map(c => c.sha)).toEqual(["mine1", "mine2", "mine3"]);
  expect(calls).toEqual([
    "https://api.github.com/repos/org/tool/commits?author=renamed&per_page=3",
    "https://api.github.com/repos/org/tool/commits?per_page=30",
  ]);
});

it.each(["nonempty", "error", "no-match"])("handles %s without inventing evidence", async mode => {
  process.env.GITHUB_TOKEN = "fixture-token";
  const fetcher = vi.fn(async () => mode === "error"
    ? Response.json({}, { status: 404 })
    : Response.json(mode === "nonempty" ? [{ sha: "known" }] : []));
  vi.stubGlobal("fetch", fetcher);
  expect((await fetchCoCreatorCommits("org", "tool", "renamed")).map(c => c.sha)).toEqual(mode === "nonempty" ? ["known"] : []);
  expect(fetcher).toHaveBeenCalledTimes(mode === "no-match" ? 2 : 1);
});
