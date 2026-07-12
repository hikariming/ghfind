/**
 * Repo research pipeline (ops-plan 线 3).
 * One command per repo: fetch top contributors → score the missing/stale ones
 * (results persist to scores/profile_snapshots/repos/repo_developers as usual)
 * → aggregate stats vs the 19k baseline into a data.json for the article.
 *
 * Usage:
 *   npx tsx scripts/repo-research/run.mts <owner>/<name> [--max=100] [--stale-days=30] [--no-ingest] [--aggregate-only]
 *
 * Output: scripts/repo-research/out/<owner>__<name>/{contributors.json,data.json}
 * Read-only against GitHub except the scoring scans; DB writes go through the
 * same recordScore/recordProfileSnapshot path as the website.
 */
import "../_env.mjs";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { collect } from "../../src/lib/github";
import { score, spamBotScore, tierFor } from "../../src/lib/score";
import { recordScore, recordProfileSnapshot } from "../../src/lib/db";
import type { RawMetrics, ScanResult } from "../../src/lib/types";

const repoArg = process.argv[2];
if (!repoArg?.includes("/")) {
  console.error("usage: npx tsx scripts/repo-research/run.mts <owner>/<name> [--max=100] [--stale-days=30] [--no-ingest] [--aggregate-only]");
  process.exit(1);
}
const [owner, name] = repoArg.split("/");
const flags = new Map(process.argv.slice(3).map((a) => {
  const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? "true"] : [a, "true"];
}) as [string, string][]);
const MAX = Number(flags.get("max") ?? 100);
const STALE_MS = Number(flags.get("stale-days") ?? 30) * 24 * 3600 * 1000;
const NO_INGEST = flags.has("no-ingest") || flags.has("aggregate-only");
const AGG_ONLY = flags.has("aggregate-only");

const OUT_DIR = path.join(import.meta.dirname, "out", `${owner.toLowerCase()}__${name.toLowerCase()}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
const BASELINE_PATH = path.join(import.meta.dirname, "../../content/blog/we-scored-19000-github-accounts/data.json");

const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const gh = async <T>(url: string): Promise<{ data: T; res: Response }> => {
  const res = await fetch(`https://api.github.com/${url}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ghfind-repo-research",
    },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`);
  return { data: (await res.json()) as T, res };
};

// ---------- phase 1: repo meta + contributors ----------
type Contributor = { login: string; contributions: number; type: string };
type RepoMeta = {
  full_name: string; description: string | null; stargazers_count: number;
  forks_count: number; open_issues_count: number; created_at: string;
  language: string | null; topics?: string[];
};

const contributorsPath = path.join(OUT_DIR, "contributors.json");
let meta: RepoMeta;
let humans: Contributor[];
let bots: Contributor[];

if (AGG_ONLY && fs.existsSync(contributorsPath)) {
  const saved = JSON.parse(fs.readFileSync(contributorsPath, "utf8"));
  meta = saved.meta; humans = saved.humans; bots = saved.bots;
  console.log(`[fetch] reusing ${contributorsPath}`);
} else {
  console.log(`[fetch] repo meta + top ${MAX} contributors for ${owner}/${name}…`);
  meta = (await gh<RepoMeta>(`repos/${owner}/${name}`)).data;
  const all: Contributor[] = [];
  for (let page = 1; all.length < MAX; page++) {
    const { data } = await gh<Contributor[]>(`repos/${owner}/${name}/contributors?per_page=100&page=${page}`);
    if (!data.length) break;
    all.push(...data);
    if (data.length < 100) break;
  }
  const top = all.slice(0, MAX);
  bots = top.filter((c) => c.type === "Bot" || /\[bot\]$/i.test(c.login));
  humans = top.filter((c) => !(c.type === "Bot" || /\[bot\]$/i.test(c.login)));
  fs.writeFileSync(contributorsPath, JSON.stringify({ fetched_at: new Date().toISOString(), meta, humans, bots }, null, 2));
  console.log(`[fetch] ${meta.full_name}: ${meta.stargazers_count} stars, top-${top.length} contributors → ${humans.length} humans, ${bots.length} bots`);
}

// ---------- phase 2: freshness check ----------
const logins = humans.map((c) => c.login.toLowerCase());
const placeholders = logins.map(() => "?").join(",");
const existing = await db.execute({
  sql: `SELECT username, scanned_at FROM scores WHERE username IN (${placeholders})`,
  args: logins,
});
const scannedAt = new Map(existing.rows.map((r) => [String(r.username), Number(r.scanned_at)]));
const now = Date.now();
const toScan = humans.filter((c) => {
  const at = scannedAt.get(c.login.toLowerCase());
  return at === undefined || now - at > STALE_MS;
});
console.log(`[check] in DB fresh: ${humans.length - toScan.length}/${humans.length}; to scan: ${toScan.length}`);

// ---------- phase 3: ingest (same retry/backoff discipline as _ingest-openclaw) ----------
if (!NO_INGEST && toScan.length) {
  const EMPTY = { zh: [] as string[], en: [] as string[] };
  const SPACING = 8000;
  const BACKOFFS = [15000, 40000, 90000];
  for (let i = 0; i < toScan.length; i++) {
    if (i > 0) await sleep(SPACING);
    const u = toScan[i].login;
    let line = "";
    for (let attempt = 0; ; attempt++) {
      try {
        const collected = await collect(u);
        const scoring = score(collected.metrics);
        const scan: ScanResult = { ...collected, scoring };
        const { tier } = tierFor(scoring.final_score);
        await recordScore({
          username: collected.metrics.username,
          display_name: collected.metrics.name,
          avatar_url: collected.metrics.avatar_url,
          profile_url: collected.metrics.profile_url,
          final_score: scoring.final_score, tier, tags: EMPTY,
          roast_line: { zh: "", en: "" },
          bot_score: spamBotScore(collected.metrics),
          sub_scores: scoring.sub_scores, scanned_at: Date.now(),
        });
        await recordProfileSnapshot(scan);
        line = `OK  ${collected.metrics.username.padEnd(20)} score=${String(scoring.final_score).padStart(5)} ${tier}`;
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const transient = /invalid JSON|rate limit|ECONN|502|503|timeout/i.test(msg);
        if (transient && attempt < BACKOFFS.length) {
          console.log(`... ${u} backoff ${BACKOFFS[attempt] / 1000}s (${msg})`);
          await sleep(BACKOFFS[attempt]);
          continue;
        }
        line = `ERR ${u.padEnd(20)} ${msg}`;
        break;
      }
    }
    console.log(`[scan ${i + 1}/${toScan.length}] ${line}`);
  }
}

// ---------- phase 4: aggregate ----------
console.log("[aggregate] sweeping scores + latest snapshots…");
type Row = {
  login: string; contributions: number; final_score: number | null; tier: string | null;
  bot_score: number | null; scanned_at: number | null; m: RawMetrics | null;
};
const rows: Row[] = [];
for (const c of humans) {
  const u = c.login.toLowerCase();
  const s = await db.execute({
    sql: `SELECT final_score, tier, bot_score, scanned_at FROM scores WHERE username = ?`,
    args: [u],
  });
  const snap = await db.execute({
    sql: `SELECT metrics FROM profile_snapshots WHERE username = ? ORDER BY scanned_at DESC LIMIT 1`,
    args: [u],
  });
  let m: RawMetrics | null = null;
  if (snap.rows[0]?.metrics) {
    try { m = JSON.parse(String(snap.rows[0].metrics)) as RawMetrics; } catch {}
  }
  const sr = s.rows[0];
  rows.push({
    login: c.login, contributions: c.contributions,
    final_score: sr ? Number(sr.final_score) : null,
    tier: sr ? String(sr.tier) : null,
    bot_score: sr && sr.bot_score !== null ? Number(sr.bot_score) : null,
    scanned_at: sr ? Number(sr.scanned_at) : null,
    m,
  });
}

const scored = rows.filter((r) => r.final_score !== null);
const quantile = (sorted: number[], q: number) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo);
};
const dist = (arr: number[]) => {
  const s = [...arr].sort((a, b) => a - b);
  return {
    n: s.length, p10: quantile(s, 0.1), p25: quantile(s, 0.25), p50: quantile(s, 0.5),
    p75: quantile(s, 0.75), p90: quantile(s, 0.9),
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null, max: s[s.length - 1] ?? null,
  };
};

const tierHist: Record<string, number> = {};
for (const r of scored) tierHist[r.tier!] = (tierHist[r.tier!] ?? 0) + 1;

const withMetrics = scored.filter((r) => r.m && typeof r.m.followers === "number");
const flagCounts: Record<string, number> = {};
let flaggedUsers = 0;
let recomputedBotGte3 = 0, recomputedBotGte5 = 0;
for (const r of withMetrics) {
  try {
    const sc = score(r.m!);
    if (sc.red_flags.length) flaggedUsers++;
    for (const f of sc.red_flags) flagCounts[f.flag] = (flagCounts[f.flag] ?? 0) + 1;
    const bot = spamBotScore(r.m!);
    if (bot >= 3) recomputedBotGte3++;
    if (bot >= 5) recomputedBotGte5++;
  } catch {}
}

// bus factor from the contributors API commit counts (top-100 sample)
const totalCommits = humans.reduce((a, c) => a + c.contributions, 0);
const share = (k: number) => humans.slice(0, k).reduce((a, c) => a + c.contributions, 0) / (totalCommits || 1);

// underrated: high engine score, low followers, not the repo owner org's face
const underrated = withMetrics
  .filter((r) => r.final_score! >= 70 && (r.m!.followers ?? 0) < 300)
  .sort((a, b) => b.final_score! - a.final_score!)
  .slice(0, 8)
  .map((r) => ({
    login: r.login, score: r.final_score, tier: r.tier,
    followers: r.m!.followers, commits_here: r.contributions,
  }));

// baseline (19k article aggregates)
type Baseline = {
  n: number; approx_median_score: number | null; tier_histogram: Record<string, number>;
  spam_gte3_rate: number; red_flag_any_rate: number;
  followers_p50: number; merged_pr_p50: number; account_age_p50: number;
};
let baseline: Baseline | null = null;
try {
  const b = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  const hist: Record<string, number> = b.score_histogram_bucket5;
  const totalN = Object.values(hist).reduce((a, v) => a + Number(v), 0);
  let acc = 0, median: number | null = null;
  for (const bucket of Object.keys(hist).map(Number).sort((x, y) => x - y)) {
    acc += Number(hist[bucket]);
    if (acc >= totalN / 2) { median = bucket + 2.5; break; }
  }
  baseline = {
    n: totalN,
    approx_median_score: median,
    tier_histogram: b.tier_histogram,
    spam_gte3_rate: b.stored_bot_score.gte3 / b.stored_bot_score.with_value,
    red_flag_any_rate: b.red_flags.users_with_any / b.red_flags.of,
    followers_p50: b.metric_distributions.followers.p50,
    merged_pr_p50: b.metric_distributions.merged_pr_count.p50,
    account_age_p50: b.metric_distributions.account_age_years.p50,
  };
} catch (e) {
  console.error("baseline load failed:", e);
}

const out = {
  generated_at: new Date().toISOString(),
  repo: {
    full_name: meta.full_name, description: meta.description,
    stars: meta.stargazers_count, forks: meta.forks_count,
    open_issues: meta.open_issues_count, created_at: meta.created_at,
    language: meta.language, topics: meta.topics ?? [],
  },
  sample: {
    top_contributors_fetched: humans.length + bots.length,
    bots_excluded: bots.length,
    bot_logins: bots.map((b) => b.login),
    humans: humans.length,
    scored: scored.length,
    with_deep_metrics: withMetrics.length,
    unscored_logins: rows.filter((r) => r.final_score === null).map((r) => r.login),
  },
  scores: {
    dist: dist(scored.map((r) => r.final_score!)),
    tier_histogram: tierHist,
    gte90: scored.filter((r) => r.final_score! >= 90).length,
    gte70: scored.filter((r) => r.final_score! >= 70).length,
    lt40: scored.filter((r) => r.final_score! < 40).length,
  },
  spam: {
    stored_bot_gte3: scored.filter((r) => (r.bot_score ?? 0) >= 3).length,
    recomputed_gte3: recomputedBotGte3,
    recomputed_gte5: recomputedBotGte5,
    of: withMetrics.length,
  },
  red_flags: { users_with_any: flaggedUsers, of: withMetrics.length, by_flag: flagCounts },
  raw_metrics: {
    followers: dist(withMetrics.map((r) => r.m!.followers ?? 0)),
    account_age_years: dist(withMetrics.map((r) => r.m!.account_age_years ?? 0)),
    merged_pr_count: dist(withMetrics.map((r) => r.m!.merged_pr_count ?? 0)),
    total_stars: dist(withMetrics.map((r) => r.m!.total_stars ?? 0)),
    accounts_lt1y: withMetrics.filter((r) => (r.m!.account_age_years ?? 99) < 1).length,
    accounts_lt2y: withMetrics.filter((r) => (r.m!.account_age_years ?? 99) < 2).length,
  },
  bus_factor: {
    total_commits_top_sample: totalCommits,
    top1_share: share(1), top3_share: share(3), top5_share: share(5), top10_share: share(10),
    top_contributors: humans.slice(0, 15).map((c) => ({ login: c.login, commits: c.contributions })),
  },
  underrated_candidates: underrated,
  baseline_19k: baseline,
  per_contributor: rows.map((r) => ({
    login: r.login, commits: r.contributions, score: r.final_score, tier: r.tier,
    bot_score: r.bot_score,
    followers: r.m?.followers ?? null, account_age_years: r.m?.account_age_years ?? null,
    merged_pr_count: r.m?.merged_pr_count ?? null,
    scanned_at: r.scanned_at ? new Date(r.scanned_at).toISOString().slice(0, 10) : null,
  })),
};

const outPath = path.join(OUT_DIR, "data.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`[aggregate] wrote ${outPath}`);
console.log(JSON.stringify({
  scored: scored.length, median: out.scores.dist.p50, tiers: tierHist,
  spam_gte3: out.spam.stored_bot_gte3, flagged: flaggedUsers,
  bus_top3: Number(share(3).toFixed(3)),
}, null, 2));
process.exit(0);
