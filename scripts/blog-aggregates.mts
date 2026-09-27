/**
 * Read-only aggregate sweep for the research article
 * "We scored N GitHub accounts…". SELECTs only — never writes.
 *
 * Pass 1: full `scores` sweep (score/tier/bot_score histograms).
 * Pass 2: latest `profile_snapshots.metrics` per user → raw-metric distributions;
 *         red-flag prevalence comes from each user's stored risk assessment.
 * Pass 3: language facet distribution (GROUP BY, high-score segment).
 *
 * Usage: npx tsx scripts/blog-aggregates.mts
 * Output: content/blog/we-scored-19000-github-accounts/data.json
 */
import "/Users/rqq/github-roast/scripts/_env.mjs";
import fs from "node:fs";
import { createClient } from "@libsql/client";
import type { RawMetrics, RiskAssessment } from "/Users/rqq/github-roast/src/lib/types.ts";

const OUT = "/Users/rqq/github-roast/content/blog/we-scored-19000-github-accounts/data.json";
const PAGE = 5000;

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ---------- helpers ----------
const quantile = (sorted: number[], q: number) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo);
};
const dist = (arr: number[]) => {
  const s = [...arr].sort((a, b) => a - b);
  return {
    n: s.length,
    p10: quantile(s, 0.1), p25: quantile(s, 0.25), p50: quantile(s, 0.5),
    p75: quantile(s, 0.75), p90: quantile(s, 0.9), p99: quantile(s, 0.99),
    mean: s.reduce((a, b) => a + b, 0) / (s.length || 1),
    max: s[s.length - 1] ?? null,
  };
};

// ---------- pass 1: scores table ----------
console.error("pass 1: scores…");
/** `red_flags`: penalty-disposition signals of the stored risk assessment (null: none stored). */
type ScoreRow = { final_score: number; tier: string; bot_score: number | null; red_flags: string[] | null };

function storedRedFlags(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  try {
    const risk = JSON.parse(raw) as RiskAssessment | null;
    return risk ? risk.signals.filter((s) => s.disposition === "penalty").map((s) => s.flag) : null;
  } catch {
    return null;
  }
}
const scoreByUser = new Map<string, ScoreRow>();
let hiddenCount = 0;
{
  let last = "";
  for (;;) {
    const r = await db.execute({
      sql: `SELECT username, final_score, tier, bot_score, risk_assessment, hidden FROM scores
            WHERE username > ? ORDER BY username LIMIT ${PAGE}`,
      args: [last],
    });
    if (!r.rows.length) break;
    for (const row of r.rows) {
      last = String(row.username);
      if (Number(row.hidden)) { hiddenCount++; continue; }
      scoreByUser.set(String(row.username), {
        final_score: Number(row.final_score),
        tier: String(row.tier),
        bot_score: row.bot_score === null ? null : Number(row.bot_score),
        red_flags: storedRedFlags(row.risk_assessment),
      });
    }
    process.stderr.write(`  scores loaded: ${scoreByUser.size + hiddenCount}\r`);
  }
}
console.error(`\n  visible=${scoreByUser.size} hidden=${hiddenCount}`);

const scoreHist: Record<string, number> = {};
const tierHist: Record<string, number> = {};
const botHist: Record<string, number> = {};
let botGte3 = 0, botGte5 = 0, botGte7 = 0, botNonNull = 0;
for (const s of scoreByUser.values()) {
  const bucket = Math.min(95, Math.floor(s.final_score / 5) * 5);
  scoreHist[bucket] = (scoreHist[bucket] ?? 0) + 1;
  tierHist[s.tier] = (tierHist[s.tier] ?? 0) + 1;
  if (s.bot_score !== null) {
    botNonNull++;
    const b = Math.min(9, Math.floor(s.bot_score));
    botHist[b] = (botHist[b] ?? 0) + 1;
    if (s.bot_score >= 3) botGte3++;
    if (s.bot_score >= 5) botGte5++;
    if (s.bot_score >= 7) botGte7++;
  }
}

// ---------- pass 2: latest snapshot metrics per user ----------
console.error("pass 2a: snapshot recency index…");
const latestAt = new Map<string, number>();
{
  let lastRowid = 0;
  for (;;) {
    const r = await db.execute({
      sql: `SELECT rowid, username, scanned_at FROM profile_snapshots
            WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE}`,
      args: [lastRowid],
    });
    if (!r.rows.length) break;
    for (const row of r.rows) {
      lastRowid = Number(row.rowid);
      const u = String(row.username);
      const at = Number(row.scanned_at);
      if ((latestAt.get(u) ?? -1) < at) latestAt.set(u, at);
    }
    process.stderr.write(`  indexed rows up to rowid ${lastRowid}\r`);
  }
}
console.error(`\n  distinct snapshot users: ${latestAt.size}`);

console.error("pass 2b: metrics sweep…");
const flagCounts: Record<string, number> = {};
let flaggedUsers = 0, flagsOf = 0, sweptUsers = 0;
let floodSuspect = 0, starInflation = 0, followFarm = 0;
let extTrivialAny = 0, extTrivialSampled = 0, trivialFarmers = 0;
const arrays = {
  followers: [] as number[], total_stars: [] as number[], max_stars: [] as number[],
  merged_pr_count: [] as number[], account_age_years: [] as number[],
  last_year_contributions: [] as number[], public_repos: [] as number[],
  issues_created: [] as number[],
};
const rejectionRates: number[] = []; // only where decided >= 10
const ageScoreBuckets = new Map<number, { sum: number; n: number; scores: number[] }>();
const templatedRatios: number[] = []; // only where recent_pr_sample >= 10
{
  let lastRowid = 0;
  const seen = new Set<string>();
  for (;;) {
    const r = await db.execute({
      sql: `SELECT rowid, username, scanned_at, metrics FROM profile_snapshots
            WHERE rowid > ? ORDER BY rowid LIMIT 1000`,
      args: [lastRowid],
    });
    if (!r.rows.length) break;
    for (const row of r.rows) {
      lastRowid = Number(row.rowid);
      const u = String(row.username);
      if (Number(row.scanned_at) !== latestAt.get(u) || seen.has(u)) continue;
      seen.add(u);
      if (!scoreByUser.has(u)) continue; // hidden or unscored — keep out of aggregates
      if (!row.metrics) continue;
      let m: RawMetrics;
      try { m = JSON.parse(String(row.metrics)) as RawMetrics; } catch { continue; }
      if (typeof m.followers !== "number" || typeof m.merged_pr_count !== "number") continue;
      sweptUsers++;

      // distributions
      arrays.followers.push(m.followers);
      arrays.total_stars.push(m.total_stars ?? 0);
      arrays.max_stars.push(m.max_stars ?? 0);
      arrays.merged_pr_count.push(m.merged_pr_count);
      arrays.account_age_years.push(m.account_age_years ?? 0);
      arrays.last_year_contributions.push(m.last_year_contributions ?? 0);
      arrays.public_repos.push(m.public_repos ?? 0);
      arrays.issues_created.push(m.issues_created ?? 0);

      // farming signals straight from collected metrics
      if (m.pr_flood_suspect) floodSuspect++;
      if (m.star_inflation_suspect) starInflation++;
      if (m.following > 1000 && m.followers < m.following * 0.3) followFarm++;
      const sample = m.recent_merged_pr_sample ?? 0;
      if (sample >= 1) {
        extTrivialSampled++;
        if ((m.external_trivial_pr_count ?? 0) > 0) extTrivialAny++;
        if (sample >= 10 && (m.external_trivial_pr_count ?? 0) / sample > 0.5) trivialFarmers++;
      }
      if ((m.recent_pr_sample ?? 0) >= 10 && m.templated_pr_ratio !== undefined) {
        templatedRatios.push(m.templated_pr_ratio);
      }
      const rejected = m.maintainer_closed_unmerged_pr_count ?? m.closed_unmerged_pr_count ?? 0;
      if (m.merged_pr_count + rejected >= 10 && m.pr_rejection_rate !== undefined) {
        rejectionRates.push(m.pr_rejection_rate);
      }

      // red flags as published with the stored score
      const live = scoreByUser.get(u)!;
      if (live.red_flags) {
        flagsOf++;
        if (live.red_flags.length) flaggedUsers++;
        for (const f of live.red_flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
      }

      // age × current score
      const ageBucket = Math.min(10, Math.floor(m.account_age_years ?? 0));
      const b = ageScoreBuckets.get(ageBucket) ?? { sum: 0, n: 0, scores: [] };
      b.sum += live.final_score; b.n++; b.scores.push(live.final_score);
      ageScoreBuckets.set(ageBucket, b);
    }
    process.stderr.write(`  swept ${sweptUsers} users (rowid ${lastRowid})\r`);
  }
}
console.error(`\n  swept=${sweptUsers}`);

// ---------- pass 3: language facets (high-score segment) ----------
console.error("pass 3: language facets…");
const facetRes = await db.execute(
  `SELECT f.facet_value AS language, COUNT(DISTINCT f.username) AS devs
   FROM developer_facets f JOIN scores s ON s.username = f.username
   WHERE f.facet_type = 'language' AND s.hidden = 0 AND s.final_score >= 60
   GROUP BY f.facet_value ORDER BY devs DESC LIMIT 20`,
);
const languagesTop = facetRes.rows.map((r) => ({
  language: String(r.language),
  devs: Number(r.devs),
}));

// ---------- output ----------
const ageScore = [...ageScoreBuckets.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([age, b]) => ({
    age,
    n: b.n,
    mean: b.sum / b.n,
    median: quantile(b.scores.sort((x, y) => x - y), 0.5),
  }));

const out = {
  generated_at: new Date().toISOString(),
  method_notes:
    "Visible (non-hidden) accounts only. Red flags are the penalty signals of each user's stored risk assessment; stored bot_score and red flags reflect the engine version at scan time.",
  totals: {
    scored_accounts_visible: scoreByUser.size,
    hidden_accounts: hiddenCount,
    snapshot_users: latestAt.size,
    metrics_swept_users: sweptUsers,
  },
  score_histogram_bucket5: scoreHist,
  tier_histogram: tierHist,
  stored_bot_score: {
    with_value: botNonNull,
    histogram_bucket1: botHist,
    gte3: botGte3, gte5: botGte5, gte7: botGte7,
  },
  red_flags: { users_with_any: flaggedUsers, of: flagsOf, by_flag: flagCounts },
  farming_signals: {
    of: sweptUsers,
    pr_flood_suspect: floodSuspect,
    star_inflation_suspect: starInflation,
    follow_farming: followFarm,
    users_with_merged_pr_sample: extTrivialSampled,
    any_external_trivial_pr: extTrivialAny,
    majority_external_trivial_gte10: trivialFarmers,
  },
  metric_distributions: Object.fromEntries(
    Object.entries(arrays).map(([k, v]) => [k, dist(v)]),
  ),
  pr_rejection_rate_decided_gte10: dist(rejectionRates),
  templated_pr_ratio_sample_gte10: dist(templatedRatios),
  age_vs_score: ageScore,
  languages_top_score_gte60: languagesTop,
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.error(`wrote ${OUT}`);
process.exit(0);
