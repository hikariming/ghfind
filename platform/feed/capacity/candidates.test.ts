import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FeedStore } from "../src/store";
import { hash } from "../src/contract";
import { projectAnalysisArtifactSchema } from "../../../src/lib/project-analysis-contract";
import { deriveProjectBoardEligibility } from "../../../src/lib/project-ranking";
import { syntheticTemplate } from "./synthetic-template";
import baseline from "./evidence/baseline.json";
import packageJson from "../package.json";
declare const __CAPACITY_IMPLEMENTATION_SHA__: string;

type Observation = {
  sql: string;
  args: unknown[];
  rowsRead: number;
  durationMs: number;
  engineDurationMs: number;
  resultSize: number;
  repoKeys: string[];
};
function measured(db: D1Database, observations: Observation[]): D1Database {
  const statement = (
    target: D1PreparedStatement,
    sql: string,
    args: unknown[],
  ): D1PreparedStatement =>
    new Proxy(target, {
      get(object, key) {
        if (key === "bind")
          return (...values: unknown[]) =>
            statement(object.bind(...values), sql, values);
        if (key === "all")
          return async () => {
            const start = performance.now(),
              result = await object.all();
            observations.push({
              sql,
              args,
              rowsRead: result.meta.rows_read,
              durationMs: performance.now() - start,
              engineDurationMs: result.meta.duration,
              resultSize: result.results.length,
              repoKeys: sql.includes("SELECT p.*")
                ? result.results.map((row) => String(row.repo_key))
                : [],
            });
            return result;
          };
        const value = Reflect.get(object, key);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => statement(target.prepare(sql), sql, []);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function syntheticCatalog() {
  const start = performance.now();
  for (let offset = 0; offset < 50000; offset += 200) {
    const entries = await Promise.all(
      Array.from({ length: 200 }, async (_, index) => {
        const n = offset + index + 1,
          owner = `synthetic-owner-${n % 10000}`,
          name = `synthetic-project-${n.toString().padStart(5, "0")}`,
          repoKey = `${owner}/${name}`,
          analysisId = `synthetic-analysis-${n}`;
        const rare = n % 1000 === 0;
        const score = 60 + (n % 41),
          confidence = 70 + (n % 30),
          analyzedAt = 1700000000000 + n * 1000;
        const artifact = projectAnalysisArtifactSchema.parse({
          ...syntheticTemplate,
          analysis_id: analysisId,
          repository: {
            ...syntheticTemplate.repository,
            repo_key: repoKey,
            canonical_url: `https://github.com/${repoKey}`,
          },
          project: {
            ...syntheticTemplate.project,
            name,
            summary:
              "SYNTHETIC capacity fixture. This repository and assessment are fictional.",
            project_type: rare ? "database_infra" : "micro_tool",
          },
          scores: { ...syntheticTemplate.scores, product_score: score },
          confidence,
          analyzed_at: new Date(analyzedAt).toISOString(),
          exposure: {
            ...syntheticTemplate.exposure,
            band: n % 20 === 0 ? "low" : "established",
          },
        });
        // Keep dimension totals consistent with the generated overall score.
        let remaining = score;
        for (const key of [
          "pain",
          "effectiveness",
          "experience",
          "value_density",
        ] as const) {
          artifact.scores[key].score = Math.min(
            artifact.scores[key].max_score,
            remaining,
          );
          remaining -= artifact.scores[key].score;
        }
        const analysisJSON = JSON.stringify(artifact),
          sourceHash = await hash(analysisJSON),
          eligibility = deriveProjectBoardEligibility(artifact);
        return {
          n,
          repoKey,
          analysisId,
          owner,
          name,
          score,
          confidence,
          analyzedAt,
          rare,
          analysisJSON,
          sourceHash,
          projectionHash: await hash(
            "synthetic project projection " + analysisJSON,
          ),
          pain: artifact.scores.pain.score,
          effectiveness: artifact.scores.effectiveness.score,
          experience: artifact.scores.experience.score,
          density: artifact.scores.value_density.score,
          receiptId: `synthetic-receipt-${n}`,
          eventId: `synthetic-event-${n}`,
          type: rare ? "database-infra" : "micro-tool",
          treasure: Number(eligibility.treasureEligible),
          classic: Number(eligibility.classicEligible),
          exposure: artifact.exposure.band,
        };
      }),
    );
    const json = JSON.stringify(entries);
    const facts = JSON.stringify(
      entries.map(({ analysisJSON: _analysisJSON, ...entry }) => entry),
    );
    await env.CORE_DB.batch([
      env.CORE_DB.prepare(
        `INSERT INTO project_analysis_runs(id,repo_key,canonical_url,idempotency_key,status,phase,schema_version,rubric_version,agent_version,skill_version,analysis_json,analysis_sha256,resolved_commit_sha,created_at,updated_at)
        SELECT json_extract(value,'$.analysisId'),json_extract(value,'$.repoKey'),'https://github.com/'||json_extract(value,'$.repoKey'),json_extract(value,'$.analysisId'),'completed','completed','ghfind.project-analysis.v3','project-value-v1','project-evaluator-v3','ghfind-project-evaluator-v4',json_extract(value,'$.analysisJSON'),json_extract(value,'$.sourceHash'),?,json_extract(value,'$.analyzedAt'),json_extract(value,'$.analyzedAt') FROM json_each(?)`,
      ).bind("a".repeat(40), json),
      env.CORE_DB.prepare(
        `INSERT INTO feed_submission_receipts(id,analysis_id,requested_repo_key,source_kind,submitted_at,evidence_ref)
        SELECT json_extract(value,'$.receiptId'),json_extract(value,'$.analysisId'),json_extract(value,'$.repoKey'),'verified_backfill',json_extract(value,'$.analyzedAt'),'SYNTHETIC isolated fixture; not historical/production consent' FROM json_each(?)`,
      ).bind(facts),
      env.CORE_DB.prepare(
        `INSERT INTO feed_source_outbox(sequence,event_id,aggregate_key,kind,analysis_id,receipt_id,source_hash,occurred_at,available_at,status)
        SELECT json_extract(value,'$.n'),json_extract(value,'$.eventId'),json_extract(value,'$.repoKey'),'assessment.completed',json_extract(value,'$.analysisId'),json_extract(value,'$.receiptId'),json_extract(value,'$.sourceHash'),json_extract(value,'$.analyzedAt'),0,'delivered' FROM json_each(?)`,
      ).bind(facts),
      env.CORE_DB.prepare(
        `INSERT INTO project_assessments(repo_key,latest_analysis_id,project_type,lifecycle,product_score,pain_score,effectiveness_score,experience_score,value_density_score,confidence,verification_level,unknowns_json,risks_json,exposure_band,resolved_commit_sha,rubric_version,analyzed_at,updated_at,treasure_eligible,classic_eligible)
        SELECT json_extract(value,'$.repoKey'),json_extract(value,'$.analysisId'),json_extract(value,'$.type'),'feature_complete',json_extract(value,'$.score'),json_extract(value,'$.pain'),json_extract(value,'$.effectiveness'),json_extract(value,'$.experience'),json_extract(value,'$.density'),json_extract(value,'$.confidence'),'source_inspected','[]','[]',json_extract(value,'$.exposure'),?,'project-value-v1',json_extract(value,'$.analyzedAt'),json_extract(value,'$.analyzedAt'),json_extract(value,'$.treasure'),json_extract(value,'$.classic') FROM json_each(?)`,
      ).bind("a".repeat(40), facts),
    ]);
    await env.FEED_DB.batch([
      env.FEED_DB.prepare(
        `INSERT INTO feed_projects(repo_key,analysis_id,owner_login,name,canonical_url,summary,language,topics_json,project_type,lifecycle,product_score,confidence,verification_level,exposure_band,treasure_eligible,classic_eligible,analyzed_at,risks_json,published,source_hash,projected_at)
        SELECT json_extract(value,'$.repoKey'),json_extract(value,'$.analysisId'),json_extract(value,'$.owner'),json_extract(value,'$.name'),'https://github.com/'||json_extract(value,'$.repoKey'),'SYNTHETIC capacity fixture; no real repository','TypeScript','[]',json_extract(value,'$.type'),'feature-complete',json_extract(value,'$.score'),json_extract(value,'$.confidence'),'source_inspected',json_extract(value,'$.exposure'),json_extract(value,'$.treasure'),json_extract(value,'$.classic'),json_extract(value,'$.analyzedAt'),'[]',1,json_extract(value,'$.projectionHash'),json_extract(value,'$.analyzedAt') FROM json_each(?)`,
      ).bind(facts),
      env.FEED_DB.prepare(
        `INSERT INTO feed_project_source_versions(repo_key,analysis_id,event_id,source_version,receipt_id,source_kind,submitted_at,item_id,resolved_commit_sha,descriptor,descriptor_hash,source_hash,blocked_reason,updated_at)
        SELECT json_extract(value,'$.repoKey'),json_extract(value,'$.analysisId'),json_extract(value,'$.eventId'),json_extract(value,'$.n'),json_extract(value,'$.receiptId'),'verified_backfill',json_extract(value,'$.analyzedAt'),replace(json_extract(value,'$.repoKey'),'/',':'),?,'SYNTHETIC projection fixture',?,json_extract(value,'$.projectionHash'), '',json_extract(value,'$.analyzedAt') FROM json_each(?)`,
      ).bind("a".repeat(40), await hash("SYNTHETIC projection fixture"), facts),
      env.FEED_DB.prepare(
        `INSERT INTO feed_project_tags(repo_key,tag_id,source,weight,confidence,evidence_json,analysis_id,taxonomy_version,created_at,updated_at)
        SELECT json_extract(value,'$.repoKey'),'artifact:'||json_extract(value,'$.type'),'derived',1,json_extract(value,'$.confidence')/100.0,'[]',json_extract(value,'$.analysisId'),1,json_extract(value,'$.analyzedAt'),json_extract(value,'$.analyzedAt') FROM json_each(?)`,
      ).bind(facts),
    ]);
  }
  await env.FEED_DB.prepare(
    "INSERT INTO feed_users(github_id,login,profile_version,taxonomy_version,created_at,updated_at) VALUES(1,'synthetic-capacity-user',1,1,0,0)",
  ).run();
  return performance.now() - start;
}

it("measures bounded recall against 50,000 synthetic receipt-backed projections", async () => {
  const seedMs = await syntheticCatalog(),
    observations: Observation[] = [],
    store = new FeedStore(measured(env.FEED_DB, observations));
  expect(
    await env.FEED_DB.prepare(
      "SELECT COUNT(*) AS n FROM feed_projects p JOIN feed_project_source_versions s ON s.repo_key=p.repo_key AND s.analysis_id=p.analysis_id WHERE p.published=1 AND s.revoked_at IS NULL AND p.source_hash=s.source_hash",
    ).first<number>("n"),
  ).toBe(50000);
  expect(
    await env.CORE_DB.prepare(
      "SELECT COUNT(*) AS n FROM feed_source_outbox o JOIN feed_submission_receipts r ON r.id=o.receipt_id AND r.analysis_id=o.analysis_id JOIN project_analysis_runs a ON a.id=o.analysis_id AND a.analysis_sha256=o.source_hash JOIN project_assessments p ON p.latest_analysis_id=a.id AND p.repo_key=o.aggregate_key WHERE a.status='completed'",
    ).first<number>("n"),
  ).toBe(50000);
  const scenarios = [];
  for (const [name, tag] of [
    ["empty", null],
    ["common", "artifact:micro-tool"],
    ["rare", "artifact:database-infra"],
  ] as const) {
    await env.FEED_DB.prepare(
      "DELETE FROM feed_user_tag_preferences WHERE github_id=1",
    ).run();
    if (tag)
      await env.FEED_DB.prepare(
        "INSERT INTO feed_user_tag_preferences(github_id,tag_id,value,source,strength,taxonomy_version,updated_at) VALUES(1,?,1,'explicit',1,1,0)",
      )
        .bind(tag)
        .run();
    observations.length = 0;
    const start = performance.now(),
      response = await store.candidates({ githubId: 1, limit: 240 }),
      elapsedMs = performance.now() - start;
    expect(response.candidates.length).toBeLessThanOrEqual(160);
    expect(response.counts.latest).toBe(40);
    expect(response.counts.quality).toBe(20);
    expect(response.counts.discovery).toBe(20);
    for (const oldQuery of baseline.scenarios.find((s) => s.name === name)!
      .queries) {
      const expected = await env.FEED_DB.prepare(oldQuery.sql)
        .bind(...oldQuery.args)
        .all<{ repo_key: string }>();
      const discriminator = oldQuery.sql.includes("LIMIT 80")
        ? "LIMIT 80"
        : oldQuery.sql.includes("LIMIT 40")
          ? "LIMIT 40"
          : oldQuery.sql.includes("ORDER BY p.product_score")
            ? "ORDER BY p.product_score"
            : "exposure_band='low') ORDER BY";
      const actual = observations.find(
        (row) =>
          row.sql.includes("SELECT p.*") && row.sql.includes(discriminator),
      );
      expect(actual?.repoKeys ?? []).toEqual(
        expected.results.map((row) => row.repo_key),
      );
    }
    const recall = observations.filter(
      (row) =>
        row.sql.includes("SELECT p.*") ||
        row.sql.startsWith("SELECT COUNT(*) AS memberships"),
    );
    const queries = await Promise.all(
      recall.map(async (row) => ({
        ...row,
        plan: (
          await env.FEED_DB.prepare(`EXPLAIN QUERY PLAN ${row.sql}`)
            .bind(...row.args)
            .all()
        ).results,
      })),
    );
    // Cost regression guards for this fixed fixture, not production SLO claims.
    const rowsRead = observations.reduce((sum, row) => sum + row.rowsRead, 0);
    expect(rowsRead).toBeLessThan(name === "common" ? 3000 : 2000);
    scenarios.push({
      name,
      counts: response.counts,
      resultSize: response.candidates.length,
      elapsedMs,
      rowsRead,
      queries,
    });
  }
  await expect(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        implementationCommit: __CAPACITY_IMPLEMENTATION_SHA__,
        synthetic: true,
        remote: false,
        projects: 50000,
        users: 1,
        events: 0,
        dependencies: packageJson.devDependencies,
        coreMigrations: env.TEST_CORE_MIGRATIONS.map((m) => m.name),
        feedMigrations: env.TEST_MIGRATIONS.map((m) => m.name),
        oldQueryResultsMatched: true,
        seedMs,
        scenarios,
      },
      null,
      2,
    ),
  ).toMatchFileSnapshot("../capacity-results/candidate-capacity.json");
});
