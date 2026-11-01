import { afterEach, expect, it, vi } from "vitest";
import { collectEstimatedContributionLanguages, type ContribRepoAgg } from "../github";

afterEach(() => vi.unstubAllGlobals());

it("fetches the same 50 language samples with bounded overlap and stable weights", async () => {
  const repos: ContribRepoAgg[] = Array.from({ length: 55 }, (_, i) => ({
    repo: `owner/repo${i}`, owner_login: "owner", stars: 100,
    is_private: false, is_fork: false, commits: 100 - i, prs: 0, active_years: 1,
  }));
  let active = 0;
  let peak = 0;
  const seen: number[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const index = Number(url.match(/repo(\d+)\/languages$/)?.[1]);
    expect(Number.isInteger(index)).toBe(true);
    seen.push(index);
    peak = Math.max(peak, ++active);
    // Finish out of order, so parallel accumulation would be detectable.
    await new Promise((resolve) => setTimeout(resolve, 4 - index % 4));
    active--;
    return new Response(JSON.stringify(index % 2 ? { Go: 3, Python: 1 } : { TypeScript: 2, Go: 2 }));
  });
  const result = await collectEstimatedContributionLanguages(repos);
  expect(peak).toBe(4);
  expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i));
  const weights = new Map<string, number>();
  for (let i = 0; i < 50; i++) {
    const languages = i % 2 ? { Go: 3, Python: 1 } : { TypeScript: 2, Go: 2 };
    for (const [name, bytes] of Object.entries(languages)) {
      weights.set(name, (weights.get(name) ?? 0) + Math.log1p(100 - i) * bytes! / 4);
    }
  }
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  expect(result).toEqual({
    languages: [...weights].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, weight]) => ({ name, pct: Math.round(weight / total * 100) })),
    candidate_repo_count: 55, selected_repo_count: 50, sampled_repo_count: 50,
  });
});
