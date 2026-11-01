/**
 * Compact, human-scale fact card for the v13 writer. The angle picker and the
 * editor see the full payload; the writer sees only facts a reader can parse at
 * a glance (stars, PR/commit counts, years, repo names, titles), which keeps it
 * from dumping internal metrics into the copy.
 */

import { v13CoverageFlags } from "./cards";

const METRIC_KEYS = [
  "account_age_years",
  "created_at",
  "contribution_years_active",
  "days_since_last_activity",
  "followers",
  "following",
  "public_repos",
  "original_repo_count",
  "nonempty_original_repo_count",
  "fork_repo_count",
  "empty_original_repo_count",
  "total_stars",
  "max_stars",
  "merged_pr_count",
  "total_pr_count",
  "external_merged_pr_count",
  "maintainer_closed_unmerged_pr_count",
  "pr_rejection_rate",
  "issues_created",
  "last_year_contributions",
  "impact_pr_count",
  "impact_commit_count",
  "impact_repo_count",
  "recent_doc_like_pr_ratio",
  "recent_external_doc_like_pr_ratio",
  "external_trivial_pr_count",
  "bio",
  "pronouns",
] as const;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);
const short = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : v ?? null);
const langNames = (v: unknown): string[] =>
  arr(v).slice(0, 4).map((l) => l.name).filter((n): n is string => typeof n === "string");

export function buildWriterFactCard(payload: unknown): Rec {
  const p = isRec(payload) ? payload : {};
  const metrics = isRec(p.metrics) ? p.metrics : {};
  const notes = isRec(p.context_notes) ? p.context_notes : {};
  const sig = isRec(p.signature_work) ? p.signature_work : {};
  const card: Rec = {
    metrics: Object.fromEntries(
      METRIC_KEYS.filter((k) => metrics[k] !== undefined && metrics[k] !== null).map((k) => [k, metrics[k]]),
    ),
    follower_following_fact: notes.follower_following_fact ?? null,
    pronoun_usage: notes.pronoun_usage ?? null,
    last_year_contributions_scope: notes.last_year_contributions_scope ?? null,
    top_repos: arr(p.top_repos).slice(0, 8).map((r) => ({
      repo: r.name_with_owner ?? r.name,
      stars: r.stars,
      forks: r.forks,
      language: r.language,
      description: short(r.description, 220),
      topics: Array.isArray(r.topics) ? r.topics.slice(0, 6) : [],
      stack: langNames(r.languages),
      pushed: typeof r.pushed_at === "string" ? r.pushed_at.slice(0, 10) : null,
      attributed_original: r.attributed_original,
    })),
    impact_repos: arr(p.impact_repos).slice(0, 10).map((r) => ({
      repo: r.repo,
      stars: r.stars,
      prs: r.prs,
      commits: r.commits,
    })),
    work_examples: arr(sig.work_clusters).slice(0, 6).map((c) => ({
      repo: c.repo,
      stars: c.stars,
      all_time_prs: c.all_time_prs,
      example_titles: Array.isArray(c.examples) ? c.examples.slice(0, 3) : [],
    })),
    core_work: arr(p.verified_impact_prs).filter((r) => r.trivial !== true).slice(0, 10).map((r) => ({
      repo: r.repo,
      repo_stars: r.repo_stars,
      title: short(r.title, 120),
      changed_files: r.changed_files,
    })),
    recent_pr_titles: arr(p.recent_prs).slice(0, 12).map((r) => ({
      repo: r.repo,
      repo_stars: r.repo_stars,
      title: short(r.title, 90),
    })),
    factual_guardrails: p.factual_guardrails ?? null,
    risk_notes: arr(p.risk_notes).map((r) => ({ flag: r.flag, detail: short(r.detail, 200) })),
  };
  return card;
}

const REPO_DROP = ["readme", "readme_excerpt", "root_paths", "content_skill_share", "size", "open_issues", "open_issue_count"];

/** v13 payload: the v12 writer payload minus the v12 output contract and the
 * bulky README/file-list evidence the copy never needs verbatim. */
export function slimV13Payload(payload: unknown): Rec {
  const p: Rec = isRec(payload) ? { ...payload } : {};
  delete p.score_contract;
  p.top_repos = arr(p.top_repos).map((r) => {
    const out: Rec = { ...r };
    for (const k of REPO_DROP) delete out[k];
    if (typeof out.description === "string") out.description = out.description.slice(0, 300);
    if (Array.isArray(out.topics)) out.topics = out.topics.slice(0, 8);
    if (Array.isArray(out.languages)) out.languages = langNames(out.languages);
    return out;
  });
  const slimPr = (r: Rec): Rec => {
    const out: Rec = { ...r };
    delete out.files;
    if (Array.isArray(out.file_changes)) out.file_changes = out.file_changes.slice(0, 4);
    return out;
  };
  p.recent_prs = arr(p.recent_prs).map(slimPr);
  p.verified_impact_prs = arr(p.verified_impact_prs).slice(0, 10).map(slimPr);
  return p;
}

/**
 * Strip inventory / merged-PR / commit numbers from the validator allowlist when
 * the scan is still partial_public. The writer only sees fact cards, but
 * validateCopy still indexes the full payload — without this, a model can invent
 * "公开仓库 N 个" using a truncated metric and pass the number check.
 */
export function redactV13PayloadForCoverage(payload: unknown, scan?: unknown): Rec {
  const p: Rec = isRec(payload) ? { ...payload } : {};
  const flags = v13CoverageFlags(scan, p);
  if (!flags.partial) return p;
  const metrics: Rec = isRec(p.metrics) ? { ...p.metrics } : {};
  const notes: Rec = isRec(p.context_notes) ? { ...p.context_notes } : {};
  const impactSummary: Rec = isRec(p.impact_summary) ? { ...p.impact_summary } : {};
  if (flags.repoIncomplete) {
    p.top_repos = [];
    for (const k of [
      "public_repos",
      "original_repo_count",
      "nonempty_original_repo_count",
      "fork_repo_count",
      "empty_original_repo_count",
      "max_stars",
      "total_stars",
    ]) {
      delete metrics[k];
    }
  }
  if (flags.mergedIncomplete) {
    p.verified_impact_prs = [];
    p.recent_prs = [];
    if (isRec(p.signature_work)) {
      p.signature_work = {
        ...p.signature_work,
        work_clusters: [],
        impact_repo_representatives: [],
      };
    }
    for (const k of [
      "merged_pr_count",
      "total_pr_count",
      "external_merged_pr_count",
      "maintainer_closed_unmerged_pr_count",
      "pr_rejection_rate",
      "impact_pr_count",
      "recent_doc_like_pr_ratio",
      "recent_external_doc_like_pr_ratio",
      "external_trivial_pr_count",
      "recent_merged_pr_sample",
    ]) {
      delete metrics[k];
    }
    delete notes.total_merged_pr_count;
    delete notes.recent_prs_sample_size;
    delete impactSummary.popular_repo_pr_count;
  }
  if (flags.commitIncomplete) {
    delete metrics.impact_commit_count;
    delete impactSummary.popular_repo_commit_count;
  }
  if (flags.mergedIncomplete && flags.commitIncomplete) {
    p.impact_repos = [];
    delete metrics.impact_repo_count;
    delete impactSummary.popular_repo_count;
  } else if (flags.mergedIncomplete) {
    p.impact_repos = arr(p.impact_repos).map((r) => ({ ...r, prs: 0 }));
  } else if (flags.commitIncomplete) {
    p.impact_repos = arr(p.impact_repos).map((r) => ({ ...r, commits: 0 }));
  }
  p.metrics = metrics;
  if (Object.keys(notes).length) p.context_notes = notes;
  if (Object.keys(impactSummary).length) p.impact_summary = impactSummary;
  return p;
}
