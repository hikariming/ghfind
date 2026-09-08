import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FeedCommands } from "../src/commands";

it("isolates impression history while old-generation cleanup is pending", async () => {
  const db = env.FEED_DB,
    store = new FeedCommands(db),
    repo = "synthetic-privacy/project";
  await db.batch([
    db
      .prepare(
        "INSERT INTO feed_projects(repo_key,analysis_id,owner_login,name,canonical_url,summary,project_type,lifecycle,product_score,confidence,verification_level,exposure_band,analyzed_at,risks_json,published,source_hash,projected_at) VALUES(?,'privacy-analysis','synthetic-privacy','project','https://github.com/synthetic-privacy/project','SYNTHETIC privacy fixture','micro-tool','feature-complete',80,90,'verified','low',0,'[]',1,'synthetic',0)",
      )
      .bind(repo),
    db
      .prepare(
        "INSERT INTO feed_submission_provenance(repo_key,analysis_id,source_event_id,source_version,evidence_kind,evidence_ref,submitted_at) VALUES(?,'privacy-analysis','privacy-event',1,'verified_historical','SYNTHETIC privacy fixture',0)",
      )
      .bind(repo),
  ]);
  const ensure = () =>
    store.ensure({
      writerEpoch: 1,
      expectedProfileVersion: 0,
      githubId: 9182,
      login: "synthetic-privacy",
      avatarUrl: "",
    });
  const seen = async () =>
    (await store.candidates({ githubId: 9182, limit: 240 })).candidates.find(
      (c) => c.project.repoKey === repo,
    )!.seenAt;
  const impression = async (id: string, profile: number, time: number) => {
    await db.batch([
      db
        .prepare(
          "INSERT INTO feed_runtime_requests(id,github_id,profile_version,taxonomy_version,algorithm_version,payload_hash,seed,candidate_counts_json,degraded_json,duration_ms,created_at) VALUES(?,9182,?,1,'baseline-v1','synthetic','seed','{}','[]',0,0)",
        )
        .bind(id, profile),
      db
        .prepare(
          "INSERT INTO feed_events(id,github_id,repo_key,type,occurred_at,request_id,rank,created_at) VALUES(?,9182,?,'impression',?,?,0,0)",
        )
        .bind(id, repo, time, id),
    ]);
  };
  expect((await ensure()).user!.profileVersion).toBe(1);
  const oldTime = Date.now() + 1000;
  await impression("privacy-old-request", 1, oldTime);
  expect(await seen()).toBe(new Date(oldTime).toISOString());
  const deletion = await store.deleteProfile({
    writerEpoch: 1,
    expectedProfileVersion: 1,
    githubId: 9182,
    now: new Date().toISOString(),
  });
  expect(deletion.status).toBe("pending");
  expect(
    await db
      .prepare("SELECT status FROM feed_cleanup_jobs WHERE deletion_id=?")
      .bind(deletion.deletionId)
      .first("status"),
  ).toBe("pending");
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM feed_events WHERE github_id=9182")
      .first("n"),
  ).toBe(1);
  const recreated = (await ensure()).user!;
  expect(recreated.profileVersion).toBe(2);
  expect(recreated.profileFloor).toBe(1);
  expect(await seen()).toBeNull();

  // An unattributed legacy row cannot bypass the generation boundary either.
  await db
    .prepare(
      "INSERT INTO feed_events(id,github_id,repo_key,type,occurred_at,request_id,rank,created_at) VALUES('privacy-orphan',9182,?,'impression',?,'missing-request',0,0)",
    )
    .bind(repo, oldTime + 1000)
    .run();
  expect(await seen()).toBeNull();
  const newTime = oldTime - 1000;
  await impression("privacy-new-request", 2, newTime);
  expect(await seen()).toBe(new Date(newTime).toISOString());

  // Preference changes within this generation retain its valid impression
  // history; the deletion floor, not exact equality with the request version,
  // determines whether old attribution can be used.
  await store.preferences({
    writerEpoch: 1,
    expectedProfileVersion: 2,
    githubId: 9182,
    taxonomyVersion: 1,
    preferences: [],
  });
  expect((await store.user(9182))!.profileVersion).toBe(3);
  expect(await seen()).toBe(new Date(newTime).toISOString());
});
