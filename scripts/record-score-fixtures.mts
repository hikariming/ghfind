/**
 * Record real-account score regression fixtures from live GitHub data.
 *
 *   GITHUB_TOKEN=$(gh auth token) pnpm tsx scripts/record-score-fixtures.mts <login ...>
 *     [--now=2026-10-13T00:00:00Z]
 *
 * Runs this checkout's `collect()` and `score()` for each login and writes the
 * pure-pipeline inputs (contribution aggregates with their per-repo signals,
 * verified ecosystem PRs, star-bearing original repos), the collected metrics
 * and the resulting scores into src/lib/__tests__/impact-regression-fixtures.json.
 * The TypeScript and Go regression tests recompute impact, quality signals and
 * weighted stars from those inputs at the recorded clock, so both runtimes are
 * pinned to the same numbers.
 *
 * `description`, `before_final_score` and `expected_final_range` of an
 * existing entry are kept: they are review decisions, not recorded facts.
 * Nothing is written to any database.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { anonymizeScoreFixture } from "./lib/anonymize-score-fixture";

import { collect, isEcosystemImpactPr, type ContribRepoAgg } from "../src/lib/github";
import { score } from "../src/lib/score";
import type { TopRepo } from "../src/lib/types";

type ScoreInputsRecord = Parameters<
  NonNullable<NonNullable<Parameters<typeof collect>[1]>["recordScoreInputs"]>
>[0];

const FIXTURES = new URL("../src/lib/__tests__/impact-regression-fixtures.json", import.meta.url);

const argv = process.argv.slice(2);
const nowFlag = argv.find((a) => a.startsWith("--now="))?.slice("--now=".length);
const logins = argv.filter((a) => !a.startsWith("--"));
if (logins.length === 0) {
  console.error("usage: record-score-fixtures.mts <login ...> [--now=ISO]");
  process.exit(2);
}
const now = nowFlag ? new Date(nowFlag) : new Date();

function starRepoFact(repo: TopRepo): TopRepo {
  return {
    name: repo.name,
    owner_login: repo.owner_login,
    name_with_owner: repo.name_with_owner,
    stars: repo.stars,
    forks: repo.forks,
    open_issues: repo.open_issues,
    size: repo.size,
    language: repo.language,
    description: repo.description,
    pushed_at: repo.pushed_at,
    topics: repo.topics ?? [],
    root_paths: repo.root_paths,
    content_skill_share: repo.content_skill_share,
    ...(repo.languages ? { languages: repo.languages } : {}),
    ...(repo.attributed_original ? { attributed_original: true } : {}),
  };
}

// Only repos that can pass an impact gate matter to the pure pipeline.
function impactCandidate(repo: ContribRepoAgg): boolean {
  return !repo.is_private && !repo.is_fork && repo.stars >= 200;
}

const fixtures = JSON.parse(readFileSync(FIXTURES, "utf8")) as Record<string, Record<string, unknown>>;
for (const login of logins) {
  let inputs: ScoreInputsRecord | undefined;
  const collected = await collect(login, {
    now,
    recordScoreInputs: (record) => {
      inputs = record;
    },
  });
  if (!inputs) throw new Error("no score inputs recorded for requested fixture");
  const metrics = collected.metrics;
  const loginLower = metrics.username.toLowerCase();
  const scoring = score(metrics);
  const alias = `fixture-recorded-${logins.indexOf(login) + 1}`;
  const previous = fixtures[alias] ?? {};
  fixtures[alias] = anonymizeScoreFixture({
    description: previous.description ?? "",
    before_final_score: previous.before_final_score ?? null,
    expected_final_range: previous.expected_final_range ?? [
      Math.floor(scoring.final_score) - 2,
      Math.ceil(scoring.final_score) + 2,
    ],
    recorded_at: inputs.now,
    metrics,
    contrib_repos: inputs.contrib_repos.filter(impactCandidate),
    recent_prs: inputs.recent_pr_window.filter((pr) => isEcosystemImpactPr(pr, loginLower)),
    star_repos: inputs.star_repos.filter((repo) => repo.stars > 0).map(starRepoFact),
    expected: {
      impact_prestige_score: metrics.impact_prestige_score,
      impact_depth_raw: metrics.impact_depth_raw,
      impact_repo_count: metrics.impact_repo_count,
      sub_scores: scoring.sub_scores,
      final_score: scoring.final_score,
    },
  }, alias);
  console.log(`${alias}: ${scoring.final_score}`, scoring.sub_scores);
}
writeFileSync(FIXTURES, `${JSON.stringify(fixtures, null, 2)}\n`);
