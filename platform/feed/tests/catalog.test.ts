import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { FeedStore } from "../src/store";

const positives = ["artifact:micro-tool", "artifact:web-app"];

beforeEach(async () => {
  await env.FEED_DB.batch(
    [
      "feed_project_tags",
      "feed_submission_provenance",
      "feed_project_source_versions",
      "feed_project_moderation",
      "feed_user_project_states",
      "feed_user_tag_preferences",
      "feed_events",
      "feed_projects",
      "feed_users",
    ].map((name) => env.FEED_DB.prepare(`DELETE FROM ${name}`)),
  );
});

async function seed(count: number) {
  // Isolated synthetic facts exercise both accepted provenance tables. The
  // highest-scoring 180 rows fail six different hard eligibility conditions.
  const data = JSON.stringify(
    Array.from({ length: count }, (_, n) => ({
      n,
      repo: `synthetic-${String(n).padStart(4, "0")}/catalog`,
      analysis: `synthetic-catalog-analysis-${n}`,
    })),
  );
  await env.FEED_DB.batch([
    env.FEED_DB.prepare(
      "INSERT INTO feed_users(github_id,login,profile_version,taxonomy_version,created_at,updated_at) VALUES(1,'synthetic-catalog',1,1,0,0)",
    ),
    env.FEED_DB.prepare(
      `INSERT INTO feed_projects(repo_key,analysis_id,owner_login,name,canonical_url,summary,project_type,lifecycle,product_score,confidence,verification_level,exposure_band,treasure_eligible,analyzed_at,risks_json,published,source_hash,projected_at)
      SELECT json_extract(value,'$.repo'),json_extract(value,'$.analysis'),'synthetic','catalog','https://github.com/'||json_extract(value,'$.repo'),'SYNTHETIC eligibility fixture','micro-tool','feature-complete',100-json_extract(value,'$.n')/1000.0,90,'verified',CASE WHEN json_extract(value,'$.n')%2=0 THEN 'low' ELSE 'established' END,0,100000+json_extract(value,'$.n'),'[]',json_extract(value,'$.n')>=30,'synthetic',0 FROM json_each(?)`,
    ).bind(data),
    env.FEED_DB.prepare(
      `INSERT INTO feed_submission_provenance(repo_key,analysis_id,source_event_id,source_version,evidence_kind,evidence_ref,submitted_at,revoked_at)
      SELECT json_extract(value,'$.repo'),CASE WHEN json_extract(value,'$.n') BETWEEN 30 AND 59 THEN 'stale-analysis' ELSE json_extract(value,'$.analysis') END,'event-'||json_extract(value,'$.n'),json_extract(value,'$.n')+1,'verified_historical','SYNTHETIC test fixture',0,CASE WHEN json_extract(value,'$.n') BETWEEN 60 AND 89 THEN 1 ELSE NULL END FROM json_each(?) WHERE json_extract(value,'$.n')%2=0`,
    ).bind(data),
    env.FEED_DB.prepare(
      `INSERT INTO feed_project_source_versions(repo_key,analysis_id,event_id,source_version,receipt_id,source_kind,submitted_at,revoked_at,item_id,resolved_commit_sha,descriptor,descriptor_hash,source_hash,blocked_reason,updated_at)
      SELECT json_extract(value,'$.repo'),CASE WHEN json_extract(value,'$.n') BETWEEN 30 AND 59 THEN 'stale-analysis' ELSE json_extract(value,'$.analysis') END,'event-'||json_extract(value,'$.n'),json_extract(value,'$.n')+1,'synthetic-receipt-'||json_extract(value,'$.n'),'verified_backfill',0,CASE WHEN json_extract(value,'$.n') BETWEEN 60 AND 89 THEN 1 ELSE NULL END,replace(json_extract(value,'$.repo'),'/',':'),'synthetic','SYNTHETIC test fixture','synthetic','synthetic','',0 FROM json_each(?) WHERE json_extract(value,'$.n')%2=1`,
    ).bind(data),
    env.FEED_DB.prepare(
      `INSERT INTO feed_project_tags(repo_key,tag_id,source,weight,confidence,analysis_id,taxonomy_version,created_at,updated_at)
      SELECT json_extract(value,'$.repo'),'artifact:micro-tool','derived',1,1,json_extract(value,'$.analysis'),1,0,0 FROM json_each(?)`,
    ).bind(data),
    env.FEED_DB.prepare(
      `INSERT INTO feed_project_tags(repo_key,tag_id,source,weight,confidence,analysis_id,taxonomy_version,created_at,updated_at)
      SELECT json_extract(value,'$.repo'),'artifact:web-app','derived',1,1,json_extract(value,'$.analysis'),1,0,0 FROM json_each(?) WHERE json_extract(value,'$.n') BETWEEN 200 AND 299`,
    ).bind(data),
    env.FEED_DB.prepare(
      `INSERT INTO feed_project_tags(repo_key,tag_id,source,weight,confidence,analysis_id,taxonomy_version,created_at,updated_at)
      SELECT json_extract(value,'$.repo'),'artifact:desktop-app','derived',1,1,json_extract(value,'$.analysis'),1,0,0 FROM json_each(?) WHERE json_extract(value,'$.n') BETWEEN 150 AND 179`,
    ).bind(data),
    env.FEED_DB.prepare(
      `INSERT INTO feed_project_moderation(repo_key,removed,updated_at) SELECT json_extract(value,'$.repo'),1,0 FROM json_each(?) WHERE json_extract(value,'$.n') BETWEEN 90 AND 119`,
    ).bind(data),
    env.FEED_DB.prepare(
      `INSERT INTO feed_user_project_states(github_id,repo_key,not_interested,updated_at) SELECT 1,json_extract(value,'$.repo'),1,0 FROM json_each(?) WHERE json_extract(value,'$.n') BETWEEN 120 AND 149`,
    ).bind(data),
    env.FEED_DB.prepare(
      `INSERT INTO feed_user_tag_preferences(github_id,tag_id,value,source,strength,taxonomy_version,updated_at) VALUES
      (1,'artifact:micro-tool',1,'explicit',1,1,0),(1,'artifact:web-app',1,'explicit',1,1,0),(1,'artifact:desktop-app',-1,'explicit',1,1,0)`,
    ),
  ]);
}

it.each([300, 800])(
  "keeps full hard filtering and deterministic top 80 with %i synthetic projects",
  async (count) => {
    await seed(count);
    const store = new FeedStore(env.FEED_DB);
    const old = await store.rows<{ repo_key: string }>(
      `SELECT p.repo_key FROM feed_projects p WHERE ${store.eligible()}
      AND EXISTS(SELECT 1 FROM feed_project_tags pt WHERE pt.repo_key=p.repo_key AND pt.tag_id IN(SELECT value FROM json_each(?)))
      ORDER BY p.product_score DESC,p.analyzed_at DESC,p.repo_key LIMIT 80`,
      1,
      1,
      JSON.stringify(positives),
    );
    const result = await store.candidates({ githubId: 1, limit: 240 });
    expect(result.counts).toEqual({
      tag: 80,
      latest: 40,
      quality: 20,
      discovery: 20,
    });
    const tagged = result.candidates.filter((candidate) =>
      candidate.sources.includes("tag"),
    );
    expect(tagged.map((candidate) => candidate.project.repoKey)).toEqual(
      old.map((row) => row.repo_key),
    );
    expect(tagged.map((candidate) => candidate.project.repoKey)).toEqual(
      Array.from(
        { length: 80 },
        (_, index) =>
          `synthetic-${String(index + 180).padStart(4, "0")}/catalog`,
      ),
    );
    expect(new Set(result.candidates.map((c) => c.project.repoKey)).size).toBe(
      result.candidates.length,
    );
    expect(
      result.candidates.every(
        (c) => Number(String(c.project.repoKey).slice(10, 14)) >= 180,
      ),
    ).toBe(true);

    // Catalog removal after recall immediately invalidates availability without
    // changing the remaining candidates or returning a forbidden replacement.
    const first = String(tagged[0].project.repoKey);
    await env.FEED_DB.prepare(
      "UPDATE feed_projects SET published=0 WHERE repo_key=?",
    )
      .bind(first)
      .run();
    expect(
      (await store.available({ githubId: 1, repoKeys: [first] })).available,
    ).toEqual({});
    const next = await store.candidates({ githubId: 1, limit: 240 });
    expect(next.counts.tag).toBe(80);
    expect(next.candidates.some((c) => c.project.repoKey === first)).toBe(
      false,
    );
  },
);

it("applies the discovery index repeatedly without changing facts and preserves indexed ordering", async () => {
  await seed(300);
  const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0008"))!;
  const before = await env.FEED_DB.prepare(
    "SELECT repo_key,published,source_hash FROM feed_projects ORDER BY repo_key",
  ).all();
  await env.FEED_DB.batch(
    migration.queries.map((query) => env.FEED_DB.prepare(query)),
  );
  await env.FEED_DB.batch(
    migration.queries.map((query) => env.FEED_DB.prepare(query)),
  );
  const after = await env.FEED_DB.prepare(
    "SELECT repo_key,published,source_hash FROM feed_projects ORDER BY repo_key",
  ).all();
  expect(after.results).toEqual(before.results);
  const plan = await env.FEED_DB.prepare(
    `EXPLAIN QUERY PLAN SELECT p.* FROM feed_projects p WHERE ${new FeedStore(env.FEED_DB).eligible()} AND (p.treasure_eligible=1 OR p.exposure_band='low') ORDER BY p.analyzed_at DESC,p.repo_key LIMIT 20`,
  )
    .bind(1, 1)
    .all<{ detail: string }>();
  expect(
    plan.results.some((row) =>
      row.detail.includes("idx_feed_projects_discovery_order"),
    ),
  ).toBe(true);
  expect(
    plan.results.some((row) => row.detail.includes("TEMP B-TREE FOR ORDER BY")),
  ).toBe(false);
});
