/**
 * Rebuild the Talent Match role-family benchmark's GitHub evidence
 * (src/lib/talent-match/__tests__/bench/candidates.json) with read-only
 * `gh api` calls: owned non-fork repos and the top external repos each login
 * landed merged PRs in, shaped like `loadVerifiedEvidence` rows. Labels in the
 * existing file are kept; only `languages` / `repos` are refreshed.
 *
 *   node --import tsx scripts/talent-match-bench-fetch.mts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src/lib/talent-match/__tests__/bench/candidates.json";
const OWNED_LIMIT = 15;
const CONTRIB_LIMIT = 8;

interface ApiRepo {
  full_name: string;
  fork: boolean;
  stargazers_count: number;
  language: string | null;
  topics?: string[];
}

const gh = <T,>(path: string): T => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 << 20 })) as T;
const repoCache = new Map<string, ApiRepo>();
const repo = (name: string) => {
  if (!repoCache.has(name)) repoCache.set(name, gh<ApiRepo>(`repos/${name}`));
  return repoCache.get(name)!;
};

const bench = JSON.parse(readFileSync(FILE, "utf8")) as { candidates: { login: string; languages: unknown; repos: unknown }[] };
for (const candidate of bench.candidates) {
  const owned = gh<ApiRepo[]>(`users/${candidate.login}/repos?type=owner&per_page=100&sort=pushed`)
    .filter((r) => !r.fork)
    .sort((a, b) => b.stargazers_count - a.stargazers_count);
  // developer_facets weights are byte shares; repo counts per language are the closest public proxy.
  const counts = new Map<string, number>();
  for (const r of owned) if (r.language) counts.set(r.language, (counts.get(r.language) ?? 0) + 1);
  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  const languages = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([language, n]) => ({ language, share: Math.round((100 * n) / total) }));

  const prs = gh<{ items: { repository_url: string }[] }>(
    `search/issues?q=${encodeURIComponent(`type:pr is:merged author:${candidate.login} -user:${candidate.login}`)}&per_page=100`,
  ).items;
  const byRepo = new Map<string, number>();
  for (const pr of prs) {
    const name = pr.repository_url.replace("https://api.github.com/repos/", "");
    byRepo.set(name, (byRepo.get(name) ?? 0) + 1);
  }
  const contributed = [...byRepo].sort((a, b) => b[1] - a[1]).slice(0, CONTRIB_LIMIT).map(([name, n]) => {
    const r = repo(name);
    return { nameWithOwner: r.full_name, relation: "contributor", stars: r.stargazers_count, language: r.language, topics: r.topics ?? [], prs: n };
  });
  candidate.languages = languages;
  candidate.repos = [
    ...owned.slice(0, OWNED_LIMIT).map((r) => ({ nameWithOwner: r.full_name, relation: "owner", stars: r.stargazers_count, language: r.language, topics: r.topics ?? [], prs: null })),
    ...contributed,
  ];
  console.error(`${candidate.login}: ${owned.length} owned, ${byRepo.size} contributed repos`);
}
writeFileSync(FILE, `${JSON.stringify(bench, null, 2)}\n`);
