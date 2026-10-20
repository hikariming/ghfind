import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { presentationSignals, presentationDiscount, ecosystemPresentationDiscount } from "../../src/lib/presentation-concentration";
import { createHash } from "node:crypto";
import { score, lowPrestigeBulkContributionCap } from "../../src/lib/score";
import type { RawMetrics, Scoring, RecentPr } from "../../src/lib/types";

interface Replay {
  username: string;
  rate_guarded?: boolean;
  source_ref: string;
  candidate_hash: string;
  score_inputs?: {star_repos?: import("../../src/lib/types").TopRepo[]};
  before: Scoring;
  before_metrics: RawMetrics;
  after_metrics: RawMetrics;
  recent_prs: RecentPr[];
  top_repos?: import("../../src/lib/types").TopRepo[];
}
const directory = process.argv[2] ?? "/tmp/v15-full-replay";
const output = process.argv[3] ?? "/tmp/v15-final-distribution.json";
const candidateHash = createHash("sha256").update(["src/lib/github.ts","src/lib/presentation-concentration.ts", "src/lib/co-creator.ts","src/lib/score.ts"].map(p=>readFileSync(p,"utf8")).join("\n")).digest("hex");
const rows = readdirSync(directory).filter(name => name.endsWith(".json") && !name.includes(".pre-"))
  .map(name => JSON.parse(readFileSync(`${directory}/${name}`, "utf8")) as Replay)
  .filter(row => row.rate_guarded === true && row.candidate_hash === candidateHash && row.score_inputs && row.source_ref === "2010358b9e0360f13d88a2f696f73dd8ff64b60d")
  .map(row => {
    row.after_metrics = {...row.after_metrics, ...presentationSignals(row.recent_prs, row.username, row.after_metrics.attributed_original_repos ?? [], row.after_metrics.attributed_original_repo_shares ?? {})};
    const after = score(row.after_metrics);
    return {
      username: row.username, before: row.before.final_score, after: after.final_score,
      delta: Math.round((after.final_score - row.before.final_score) * 10) / 10,
      P: row.after_metrics.presentation_churn_share ?? 0,
      core_churn: row.after_metrics.presentation_core_churn_share ?? 0,
      C: row.after_metrics.presentation_repo_concentration ?? 0,
      core: Math.max(row.after_metrics.presentation_core_pr_count ?? 0, row.after_metrics.core_impact_pr_count ?? 0),
      core_complete: row.after_metrics.presentation_core_pr_count ?? 0,
      merged_history_capped: Boolean(row.before_metrics.merged_pr_contribution_aggregation_incomplete || row.after_metrics.merged_pr_contribution_aggregation_incomplete),
      commit_history_unavailable: Boolean(row.before_metrics.commit_contribution_aggregation_unavailable || row.after_metrics.commit_contribution_aggregation_unavailable),
      n: row.after_metrics.presentation_pr_sample ?? 0,
      discount: presentationDiscount(row.after_metrics),
      ecosystem_discount: ecosystemPresentationDiscount(row.after_metrics),
      contribution_cap: lowPrestigeBulkContributionCap(row.after_metrics),
      attributed_shares: row.after_metrics.attributed_original_repo_shares ?? {},
      before_attributed_repos: row.before_metrics.attributed_original_repos ?? [],
      before_max_stars: row.before_metrics.max_stars, after_max_stars: row.after_metrics.max_stars,
      before_prestige: row.before_metrics.impact_prestige_score, after_prestige: row.after_metrics.impact_prestige_score,
      co_created_repos: (row.score_inputs?.star_repos ?? row.top_repos ?? []).filter(repo => repo.attributed_original).map(repo => ({name: repo.name_with_owner ?? repo.name, stars: repo.stars, share: repo.attribution_share, facts: repo.co_creator_facts})),
      before_sub: row.before.sub_scores, after_sub: after.sub_scores,
    };
  }).sort((a, b) => a.delta - b.delta || a.username.localeCompare(b.username));
const quantile = (values: number[], p: number) => values.sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
const quantiles = [.1, .25, .5, .75, .9, .99].map(p => ({
  percentile: p * 100,
  before: quantile(rows.map(row => row.before), p),
  after: quantile(rows.map(row => row.after), p),
}));
const named = rows.filter(row => ["lofisu", "yifanxuaaa", "samzong", "hikariming", "asperformias", "asukaminato0721"].includes(row.username.toLowerCase()));
const gates = {
  sample: rows.length >= 200,
  named: named.length === 6,
  lofisu: named.some(row => row.username.toLowerCase() === "lofisu" && row.after >= 50 && row.after <= 55),
  controls: named.filter(row => !["lofisu","asperformias"].includes(row.username.toLowerCase())).every(row => Math.abs(row.delta) <= 1.5),
  asperformias: named.some(row => row.username.toLowerCase() === "asperformias" && row.delta > 0),
  median: Math.abs(quantiles[2].after - quantiles[2].before) <= 1,
};
const report = { candidate_hash: candidateHash, sample: rows.length, baseline: "2010358b9e0360f13d88a2f696f73dd8ff64b60d", gates, quantiles, named,
  largest_declines: rows.slice(0, 20), largest_increases: rows.slice(-20).reverse(),
  core_review: rows.filter(row => row.core >= 10 && row.delta < -1.5), rows };
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ sample: report.sample, gates, quantiles, named }, null, 2));
if (Object.values(gates).some(value => !value)) process.exitCode = 1;
