import "./_env.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { assertPopulationTable, estimateAtLeast, type PopulationTable } from "../src/lib/github-population";

/**
 * Rebuild src/generated/github-population.json: survival tables ("how many
 * accounts/repos have at least t") for the whole of GitHub, used by
 * src/lib/github-standing.ts to show "top X% of GitHub" without crawling users.
 *
 *   pnpm tsx scripts/github-population.mts
 *
 * Every count is a GitHub Search `total_count` (per_page=1, no paging, so the
 * 1,000-result cap does not apply). On 2026-11-01 a run took 78 requests:
 * 18 star thresholds, plus 30 creation-date windows each for the user and
 * repository totals (more when a window has to be split). GITHUB_TOKEN
 * raises the limit from 10 to 30/min. Wide queries time out and return a
 * partial count (`incomplete_results`), so population totals, and any
 * threshold that comes back incomplete, are summed from creation-date windows
 * that are bisected until each window is complete. Only tables the site
 * reads are built: repo stars and account age (the age table reuses the user
 * windows).
 *
 * Nothing is written when a request fails, counts are not monotone, or a
 * count drifts more than 25% from the previous build (`--force` accepts the
 * drift).
 */

const OUT = "src/generated/github-population.json";

export interface MetricTable extends PopulationTable {
  population: string;
  source: "github_search";
  /** Human-readable definition of the measured value. */
  definition: string;
  as_of: string;
  /** Thresholds whose count came back with `incomplete_results`. */
  incomplete?: number[];
}

export interface PopulationFile {
  version: 1;
  generated_at: string;
  populations: Record<string, { total: number; definition: string; source: string; as_of: string }>;
  metrics: Record<string, MetricTable>;
}

const today = new Date().toISOString().slice(0, 10);

const token = process.env.GITHUB_TOKEN;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function searchCount(kind: "users" | "repositories", q: string): Promise<{ count: number; complete: boolean }> {
  const url = `https://api.github.com/search/${kind}?per_page=1&q=${encodeURIComponent(q)}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ghfind-github-population",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (res.ok) {
      const body = (await res.json()) as { total_count: number; incomplete_results: boolean };
      if (res.headers.get("x-ratelimit-remaining") === "0") await waitForReset(res);
      return { count: body.total_count, complete: !body.incomplete_results };
    }
    if (res.status === 403 || res.status === 429) {
      await waitForReset(res);
      continue;
    }
    if (res.status >= 500 || res.status === 422) {
      // 422 is GitHub's "query timed out" for some wide searches.
      await sleep(5_000 * (attempt + 1));
      continue;
    }
    throw new Error(`search ${q}: HTTP ${res.status}`);
  }
  throw new Error(`search ${q}: retries exhausted`);
}

async function waitForReset(res: Response): Promise<void> {
  const retryAfter = Number(res.headers.get("retry-after"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const ms = retryAfter > 0
    ? retryAfter * 1000
    : reset > 0 ? Math.max(1_000, reset * 1000 - Date.now() + 1_000) : 60_000;
  console.error(`  rate limited; waiting ${Math.ceil(ms / 1000)}s`);
  await sleep(ms);
}

const day = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Windowed {
  count: number;
  complete: boolean;
  /** Per-window counts in date order; `to` is the inclusive last creation day. */
  windows: { to: number; count: number }[];
}

/**
 * Count `base` over every creation date by summing windows: one per year,
 * then one per month for the current year. A window whose count is
 * incomplete is split in half until it is complete or one day wide.
 */
async function windowedTotal(kind: "users" | "repositories", base: string): Promise<Windowed> {
  const start = Date.UTC(2007, 9, 1); // before GitHub's first account
  const year = Number(today.slice(0, 4));
  const end = Date.parse(`${today}T00:00:00Z`);
  const pending: [number, number][] = [];
  for (let y = 2007; y < year; y++) pending.push([Math.max(start, Date.UTC(y, 0, 1)), Date.UTC(y, 11, 31)]);
  for (let mo = 0; Date.UTC(year, mo, 1) <= end; mo++) {
    pending.push([Date.UTC(year, mo, 1), Math.min(end, Date.UTC(year, mo + 1, 0))]);
  }
  const windows: Windowed["windows"] = [];
  let complete = true;
  while (pending.length) {
    const [from, to] = pending.shift()!;
    const res = await searchCount(kind, `${base} created:${iso(from)}..${iso(to)}`);
    if (!res.complete && to - from >= day) {
      const mid = from + Math.floor((to - from) / day / 2) * day;
      pending.unshift([from, mid], [mid + day, to]);
      continue;
    }
    windows.push({ to, count: res.count });
    complete &&= res.complete;
  }
  return { count: windows.reduce((sum, w) => sum + w.count, 0), complete, windows };
}

/**
 * Account-age survival table from the population windows, at no extra
 * request: accounts at least d days old are those created on or before
 * as_of - d, i.e. the running total up to each window's last day.
 */
function ageTable(users: Windowed): { thresholds: number[]; at_least: number[] } {
  const asOf = Date.parse(`${today}T00:00:00Z`);
  const points = new Map<number, number>([[0, users.count]]);
  let running = 0;
  for (const w of users.windows) {
    running += w.count;
    const age = Math.round((asOf - w.to) / day);
    if (age > 0) points.set(age, running);
  }
  const sorted = [...points.entries()].sort((a, b) => a[0] - b[0]);
  return { thresholds: sorted.map(([age]) => age), at_least: sorted.map(([, n]) => n) };
}

const REPO_STARS = [0, 1, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000, 200_000];

async function searchTable(
  kind: "users" | "repositories",
  base: string,
  thresholds: number[],
  qualifier: (t: number) => string,
  total: { count: number; complete: boolean },
): Promise<{ at_least: number[]; incomplete: number[] }> {
  const at_least: number[] = [];
  const incomplete: number[] = [];
  for (const t of thresholds) {
    if (t === thresholds[0]) {
      at_least.push(total.count);
      if (!total.complete) incomplete.push(t);
      continue;
    }
    const q = `${base} ${qualifier(t)}`.trim();
    let res = await searchCount(kind, q);
    // A timed-out count is a partial count: re-count it by creation windows.
    if (!res.complete) res = await windowedTotal(kind, q);
    console.error(`  ${q} → ${res.count}${res.complete ? "" : " (incomplete)"}`);
    const prev = at_least[at_least.length - 1];
    // Counts at a higher threshold can only be smaller; a larger one means the
    // index moved mid-run or a count is wrong. Fail and keep the old file.
    if (res.count > prev) throw new Error(`${q}: ${res.count} exceeds the previous threshold's ${prev}`);
    at_least.push(res.count);
    if (!res.complete) incomplete.push(t);
  }
  return { at_least, incomplete };
}

async function buildSearch(file: PopulationFile): Promise<void> {
  console.error("search: user population (windowed)…");
  const users = await windowedTotal("users", "type:user");
  console.error(`  type:user → ${users.count}${users.complete ? "" : " (incomplete)"}`);
  file.populations.github_users = {
    total: users.count,
    definition: "GitHub personal accounts (type:user) in the search index",
    source: "github_search",
    as_of: today,
  };

  const age = ageTable(users);
  file.metrics.account_age_days = {
    population: "github_users", source: "github_search", definition: "days since the account was created, at as_of",
    as_of: today, ...age, total: users.count,
    ...(users.complete ? {} : { incomplete: [0] }),
  };

  console.error("search: repository population (windowed)…");
  const repos = await windowedTotal("repositories", "stars:>=0");
  console.error(`  stars:>=0 → ${repos.count}${repos.complete ? "" : " (incomplete)"}`);
  file.populations.github_repos = {
    total: repos.count,
    definition: "public non-fork repositories in the search index",
    source: "github_search",
    as_of: today,
  };
  console.error("search: repo_stars…");
  // No base qualifier here: with two `stars:` qualifiers GitHub honours only the first.
  const stars = await searchTable("repositories", "", REPO_STARS, (t) => `stars:>=${t}`, repos);
  file.metrics.repo_stars = {
    population: "github_repos", source: "github_search", definition: "stargazers of one repository", as_of: today,
    thresholds: REPO_STARS, at_least: stars.at_least, total: repos.count,
    ...(stars.incomplete.length ? { incomplete: stars.incomplete } : {}),
  };
}

/**
 * Population sizes move a few percent a month. A larger jump between builds
 * almost always means a broken count (index outage, partial windows), so the
 * new file is refused unless `--force` is passed.
 */
const MAX_DRIFT = 0.25;

/**
 * Compare every old count of 1,000 or more with the new table at the same
 * point. Account-age thresholds are ages at `as_of`, so they move with each
 * run: an old age `a` is the set of accounts created before old as_of − a,
 * which the new table holds at age `a + days between the two runs`.
 */
function checkDrift(previous: PopulationFile, next: PopulationFile): void {
  for (const [key, table] of Object.entries(next.metrics)) {
    const old = previous.metrics[key];
    if (!old) continue;
    const shift = key === "account_age_days"
      ? Math.round((Date.parse(`${table.as_of}T00:00:00Z`) - Date.parse(`${old.as_of}T00:00:00Z`)) / day)
      : 0;
    for (let j = 0; j < old.thresholds.length; j++) {
      if (old.at_least[j] < 1_000) continue;
      const at = old.thresholds[j] + shift;
      const count = estimateAtLeast(table, at).count;
      const drift = Math.abs(count / old.at_least[j] - 1);
      if (drift > MAX_DRIFT) {
        throw new Error(`${key} >= ${at}: ${old.at_least[j]} → ${Math.round(count)} (${Math.round(drift * 100)}% drift; --force to accept)`);
      }
    }
  }
}

function load(): PopulationFile {
  try {
    return JSON.parse(readFileSync(OUT, "utf8")) as PopulationFile;
  } catch {
    return { version: 1, generated_at: "", populations: {}, metrics: {} };
  }
}

async function main() {
  const previous = load();
  // Built from scratch: a table the script no longer builds is dropped, not carried over.
  const file: PopulationFile = { version: 1, generated_at: "", populations: {}, metrics: {} };
  await buildSearch(file);
  for (const [key, table] of Object.entries(file.metrics)) assertPopulationTable(table, key);
  if (!process.argv.includes("--force")) checkDrift(previous, file);
  file.generated_at = new Date().toISOString();
  writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`);
  console.error(`wrote ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
