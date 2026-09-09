import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { FeedCommands } from "../src/commands";
import { FeedGovernance, type GovernanceReview } from "../src/governance";
import { FeedCleanup } from "../src/cleanup";
import { hash } from "../src/contract";

const db = env.FEED_DB;
const common = (version = 1) => ({
  commandId: crypto.randomUUID(),
  writerEpoch: 1,
  expectedTaxonomyVersion: version,
  operator: "synthetic-privacy-reviewer",
  reason: "Individual synthetic privacy review",
});
const userInput = (
  githubId: number,
  id = crypto.randomUUID(),
  version = 1,
) => ({
  writerEpoch: 1,
  expectedProfileVersion: version,
  githubId,
  id,
  repoKey: "privacy-owner/repo",
  namespace: "artifact" as const,
  slug: "privacy-tool",
  labelZh: "私有提议",
  labelEn: "Private proposal",
  evidence: [`private-marker-${githubId}`],
});
const mapped = (proposalId: string, version = 1): GovernanceReview => ({
  ...common(version),
  action: "map",
  proposalKind: "user",
  proposalId,
  expectedAnalysisId: "privacy-analysis",
  canonicalTagId: "artifact:micro-tool",
  assignment: { weight: 0.4, confidence: 0.8 },
});
async function seed(target = db, historical = false) {
  await target.batch([
    target.prepare(
      "INSERT INTO feed_projects(repo_key,analysis_id,owner_login,name,canonical_url,summary,project_type,lifecycle,product_score,confidence,verification_level,exposure_band,analyzed_at,risks_json,published,source_hash,projected_at) VALUES('privacy-owner/repo','privacy-analysis','privacy-owner','repo','https://github.com/privacy-owner/repo','SYNTHETIC privacy fixture','micro-tool','feature-complete',80,90,'verified','low',0,'[]',1,'synthetic',0)",
    ),
    target.prepare(
      "INSERT INTO feed_submission_provenance(repo_key,analysis_id,source_event_id,source_version,evidence_kind,evidence_ref,submitted_at) VALUES('privacy-owner/repo','privacy-analysis','privacy-source',1,'verified_historical','SYNTHETIC privacy evidence',0)",
    ),
  ]);
  const commands = new FeedCommands(target);
  for (const githubId of [1, 2]) {
    if (historical) {
      // Commit synthetic v9 facts without invoking the newer schema-12 writer.
      await target
        .prepare(
          "INSERT INTO feed_users(github_id,login,avatar_url,profile_version,taxonomy_version,created_at,updated_at) VALUES(?,?,'',1,1,10,10)",
        )
        .bind(githubId, `synthetic-${githubId}`)
        .run();
      continue;
    }
    await commands.ensure({
      writerEpoch: 1,
      expectedProfileVersion: 0,
      githubId,
      login: `synthetic-${githubId}`,
      avatarUrl: "",
    });
  }
  return commands;
}
async function remove(commands: FeedCommands, githubId = 1, version = 1) {
  return commands.deleteProfile({
    writerEpoch: 1,
    expectedProfileVersion: version,
    githubId,
    now: new Date().toISOString(),
  });
}
async function clean(deletionId: string, target = db) {
  const worker = new FeedCleanup({ ...env, FEED_DB: target });
  const leaseOwner = crypto.randomUUID(),
    result = await worker.claim({
      writerEpoch: 1,
      leaseOwner,
      leaseSeconds: 90,
    });
  expect(result).toMatchObject({ status: "leased", deletionId });
  for (let i = 0; i < 40; i++) {
    const step = await worker.step({ writerEpoch: 1, leaseOwner, deletionId });
    expect(step.processed).toBeLessThanOrEqual(100);
    if (step.status === "completed") return;
  }
  throw new Error("bounded synthetic cleanup failed to complete");
}
beforeEach(async () => {
  await db.batch([
    ...[
      "feed_governance_commands",
      "feed_governance_guards",
      "feed_user_proposal_authors",
      "feed_tag_proposal_commands",
      "feed_user_tag_proposals",
      "feed_project_tags",
      "feed_submission_provenance",
      "feed_projects",
      "feed_cleanup_jobs",
      "feed_profile_deletions",
      "feed_profile_floors",
      "feed_users",
      "feed_runtime_outbox",
      "feed_archive_objects",
    ].map((table) => db.prepare(`DELETE FROM ${table}`)),
    db.prepare(
      "UPDATE feed_runtime_control SET writer_epoch=1,writes_enabled=1",
    ),
    db.prepare("UPDATE feed_taxonomy_versions SET status='retired'"),
    db.prepare("DELETE FROM feed_taxonomy_versions WHERE version<>1"),
    db.prepare(
      "UPDATE feed_taxonomy_versions SET status='active' WHERE version=1",
    ),
    db.prepare("UPDATE feed_cleanup_policy SET semantic_mode='disabled'"),
  ]);
});

it("fences proposal bodies and promotions immediately, retaining safe receipts and a new generation", async () => {
  const commands = await seed(),
    governance = new FeedGovernance(db);
  const original = userInput(1),
    first = await commands.propose(original),
    second = await commands.propose(userInput(2));
  expect(second.proposalId).not.toBe(first.proposalId);
  const review = mapped(first.proposalId),
    receipt = await governance.review(review);
  expect(
    await db
      .prepare("SELECT evidence_json,origin_proposal_id FROM feed_project_tags")
      .first(),
  ).toEqual({
    evidence_json: JSON.stringify([`governance:${review.commandId}`]),
    origin_proposal_id: first.proposalId,
  });
  const deletion = await remove(commands);
  expect(
    await governance.proposal({
      proposalKind: "user",
      proposalId: first.proposalId,
    }),
  ).toEqual({ proposal: null });
  for (const action of ["create", "map", "reject"] as const) {
    const input =
      action === "map"
        ? mapped(first.proposalId, 2)
        : {
            ...common(2),
            action,
            proposalKind: "user" as const,
            proposalId: first.proposalId,
            expectedAnalysisId: "privacy-analysis",
            ...(action === "create"
              ? {
                  labels: { labelZh: "", labelEn: "Reviewed", description: "" },
                  assignment: { weight: 0.5, confidence: 0.5 },
                }
              : {}),
          };
    await expect(
      governance.review(input as GovernanceReview),
    ).rejects.toMatchObject({
      status: 409,
      code: "governance_proposal_deleted",
    });
  }
  expect(await governance.review(review)).toEqual(receipt);
  const recreated = await commands.ensure({
    writerEpoch: 1,
    expectedProfileVersion: 0,
    githubId: 1,
    login: "synthetic-new",
    avatarUrl: "",
  });
  expect(recreated.user!.profileFloor).toBe(1);
  await expect(
    commands.propose({ ...original, expectedProfileVersion: 2 }),
  ).rejects.toMatchObject({ code: "proposal_id_conflict" });
  const fresh = await commands.propose(userInput(1, crypto.randomUUID(), 2));
  expect(fresh.proposalId).not.toBe(first.proposalId);
  expect(
    (
      await governance.proposal({
        proposalKind: "user",
        proposalId: fresh.proposalId,
      })
    ).proposal!.evidence,
  ).toEqual(["private-marker-1"]);
  await clean(deletion.deletionId);
  expect(
    await commands.deletion({ githubId: 1, deletionId: deletion.deletionId }),
  ).toMatchObject({ status: "completed" });
  expect(
    await db
      .prepare("SELECT evidence_json,weight,confidence FROM feed_project_tags")
      .first(),
  ).toEqual({ evidence_json: "[]", weight: 0.4, confidence: 0.8 });
  expect(
    await db
      .prepare(
        "SELECT slug,label_zh,label_en,evidence_json FROM feed_user_tag_proposals WHERE id=?",
      )
      .bind(first.proposalId)
      .first(),
  ).toEqual({
    slug: "deleted-proposal",
    label_zh: "",
    label_en: "Deleted proposal",
    evidence_json: "[]",
  });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM feed_user_proposal_authors WHERE proposal_id=?",
      )
      .bind(first.proposalId)
      .first("n"),
  ).toBe(0);
  await expect(
    commands.propose({ ...original, expectedProfileVersion: 2 }),
  ).rejects.toMatchObject({ code: "proposal_id_conflict" });
  expect(
    await db
      .prepare(
        "SELECT proposal_id,payload_hash,created_at FROM feed_tag_proposal_commands WHERE github_id=1 AND command_id=?",
      )
      .bind(original.id)
      .first(),
  ).toEqual({ proposal_id: "", payload_hash: "deleted", created_at: 0 });
  expect(
    (
      await governance.proposal({
        proposalKind: "user",
        proposalId: second.proposalId,
      })
    ).proposal!.evidence,
  ).toEqual(["private-marker-2"]);
  expect(
    (
      await governance.proposal({
        proposalKind: "user",
        proposalId: fresh.proposalId,
      })
    ).proposal!.evidence,
  ).toEqual(["private-marker-1"]);
  expect(await governance.review(review)).toEqual(receipt);
});

it("lets deletion win against a reviewer pre-read inside the D1 transaction", async () => {
  const commands = await seed(),
    proposed = await commands.propose(userInput(1));
  let deleted = false;
  const raced = new Proxy(db, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!deleted) {
            deleted = true;
            await remove(commands);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    new FeedGovernance(raced).review(mapped(proposed.proposalId)),
  ).rejects.toMatchObject({ code: "governance_proposal_deleted" });
  expect(
    await db.prepare("SELECT COUNT(*) AS n FROM feed_project_tags").first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM feed_governance_commands")
      .first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare(
        "SELECT version FROM feed_taxonomy_versions WHERE status='active'",
      )
      .first("version"),
  ).toBe(1);
});

it("does not erase a different author's later assignment for the same project and tag", async () => {
  const commands = await seed(),
    governance = new FeedGovernance(db);
  const first = await commands.propose(userInput(1)),
    second = await commands.propose(userInput(2));
  await governance.review(mapped(first.proposalId));
  const replacement = mapped(second.proposalId, 2);
  await governance.review(replacement);
  const deletion = await remove(commands);
  await clean(deletion.deletionId);
  expect(
    await db
      .prepare("SELECT evidence_json,origin_proposal_id FROM feed_project_tags")
      .first(),
  ).toEqual({
    evidence_json: JSON.stringify([`governance:${replacement.commandId}`]),
    origin_proposal_id: second.proposalId,
  });
});

it("pins every legacy assignment field before erasure when another review races cleanup", async () => {
  const commands = await seed(),
    governance = new FeedGovernance(db);
  const first = await commands.propose(userInput(1)),
    second = await commands.propose(userInput(2));
  await governance.review(mapped(first.proposalId));
  // Recreate the old v9 copy shape while preserving its exact audit identity.
  await db
    .prepare(
      "UPDATE feed_project_tags SET evidence_json='[\"private-marker-1\"]',origin_proposal_id=NULL",
    )
    .run();
  const deletion = await remove(commands),
    replacement = mapped(second.proposalId, 2),
    leaseOwner = crypto.randomUUID();
  const worker = new FeedCleanup(env);
  expect(
    await worker.claim({ writerEpoch: 1, leaseOwner, leaseSeconds: 90 }),
  ).toMatchObject({ deletionId: deletion.deletionId, status: "leased" });
  let overwritten = false;
  const raced = new Proxy(db, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!overwritten) {
            overwritten = true;
            await governance.review(replacement);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const lease = { writerEpoch: 1, leaseOwner, deletionId: deletion.deletionId };
  await new FeedCleanup({ ...env, FEED_DB: raced }).step(lease);
  expect(
    await db
      .prepare("SELECT evidence_json,origin_proposal_id FROM feed_project_tags")
      .first(),
  ).toEqual({
    evidence_json: JSON.stringify([`governance:${replacement.commandId}`]),
    origin_proposal_id: second.proposalId,
  });
  for (let i = 0; i < 30; i++)
    if ((await worker.step(lease)).status === "completed") break;
  expect(
    await commands.deletion({ githubId: 1, deletionId: deletion.deletionId }),
  ).toMatchObject({ status: "completed" });
});

it("upgrades real v9 rows, cleans only a proven legacy copy and exposes unowned residual counts", async () => {
  // CORE_DB here is a separate, disposable workerd binding. No remote database
  // or production rollback is involved in this schema-9 -> schema-10 fixture.
  const upgradeDB = env.CORE_DB;
  await applyD1Migrations(
    upgradeDB,
    env.TEST_MIGRATIONS.filter((m) => m.name < "0010"),
  );
  const commands = await seed(upgradeDB, true),
    proposalId = "legacy-user-proposal",
    commandId = crypto.randomUUID(),
    encoded = '["private-marker-legacy"]',
    evidenceHash = await hash(encoded);
  await upgradeDB.batch([
    upgradeDB
      .prepare(
        "INSERT INTO feed_user_tag_proposals(id,repo_key,analysis_id,namespace,slug,label_zh,label_en,evidence_json,status,created_at,updated_at) VALUES(?,'privacy-owner/repo','privacy-analysis','artifact','legacy-privacy','','Private legacy',?,'mapped',10,20)",
      )
      .bind(proposalId, encoded),
    upgradeDB
      .prepare(
        "INSERT INTO feed_user_proposal_authors(proposal_id,github_id,profile_version) VALUES(?,1,1)",
      )
      .bind(proposalId),
    upgradeDB
      .prepare(
        "INSERT INTO feed_project_tags(repo_key,tag_id,source,weight,confidence,evidence_json,analysis_id,taxonomy_version,created_at,updated_at) VALUES('privacy-owner/repo','artifact:micro-tool','admin',.4,.8,?,'privacy-analysis',1,10,20)",
      )
      .bind(encoded),
    upgradeDB
      .prepare(
        "INSERT INTO feed_governance_commands(command_id,action,writer_epoch,expected_taxonomy_version,proposal_kind,proposal_id,repo_key,analysis_id,evidence_hash,canonical_tag_id,assignment_weight,assignment_confidence,operator,reason,payload_hash,result_json,taxonomy_version,created_at) VALUES(?,'map',1,1,'user',?,'privacy-owner/repo','privacy-analysis',?,'artifact:micro-tool',.4,.8,'synthetic','Synthetic historical review','synthetic','{}',1,20)",
      )
      .bind(commandId, proposalId, evidenceHash),
    upgradeDB.prepare(
      "INSERT INTO feed_user_tag_proposals(id,repo_key,analysis_id,namespace,slug,label_zh,label_en,evidence_json,status,created_at,updated_at) VALUES('unowned-legacy','privacy-owner/repo','privacy-analysis','artifact','unknown-origin','','Unowned historical body','[\"unknown-private-marker\"]','proposed',10,20)",
    ),
  ]);
  const migration = env.TEST_MIGRATIONS.filter((m) =>
    m.name.startsWith("0010"),
  );
  await applyD1Migrations(upgradeDB, migration);
  await applyD1Migrations(upgradeDB, migration);
  const oldCommand = crypto.randomUUID();
  await upgradeDB.batch([
    upgradeDB.prepare(
      "INSERT INTO feed_user_tag_proposals(id,repo_key,analysis_id,namespace,slug,label_zh,label_en,evidence_json,status,created_at,updated_at) VALUES('already-redacted','privacy-owner/repo','privacy-analysis','artifact','private-old-slug','','Deleted proposal','[]','proposed',10,20)",
    ),
    upgradeDB
      .prepare(
        "INSERT INTO feed_tag_proposal_commands(github_id,command_id,proposal_id,profile_version,payload_hash,created_at) VALUES(2,?,'already-redacted',1,'old-body-hash',10)",
      )
      .bind(oldCommand),
  ]);
  const oldDeletion = { deletionId: `feed_delete_${await hash("2:1")}` };
  // Committed v10 deletion fixture. Preserve the old falsely-completed cleanup
  // checkpoint which migration 0011 must reopen. Current writer calls follow 0012.
  await upgradeDB.batch([
    upgradeDB.prepare(
      "INSERT INTO feed_profile_floors(github_id,profile_floor,deleted_at) VALUES(2,1,30)",
    ),
    upgradeDB
      .prepare(
        "INSERT INTO feed_profile_deletions(id,github_id,profile_floor,status,requested_at) VALUES(?,2,1,'pending',30)",
      )
      .bind(oldDeletion.deletionId),
    upgradeDB
      .prepare(
        "INSERT INTO feed_cleanup_jobs(deletion_id,github_id,profile_floor,requested_at,status,phase,available_at,updated_at) VALUES(?,2,1,30,'pending','primary',30,30)",
      )
      .bind(oldDeletion.deletionId),
    upgradeDB
      .prepare(
        "INSERT INTO feed_runtime_outbox(id,topic,aggregate_key,profile_version,payload_json,status,available_at,created_at) VALUES(?,'feed.user-delete.v1','gh:2',1,?,'pending',30,30)",
      )
      .bind(
        crypto.randomUUID(),
        JSON.stringify({ deletionId: oldDeletion.deletionId, githubId: 2 }),
      ),
    upgradeDB.prepare("DELETE FROM feed_users WHERE github_id=2"),
  ]);
  await upgradeDB.batch([
    upgradeDB
      .prepare(
        "UPDATE feed_cleanup_jobs SET status='completed',phase='completed',primary_table=9 WHERE deletion_id=?",
      )
      .bind(oldDeletion.deletionId),
    upgradeDB
      .prepare(
        "UPDATE feed_profile_deletions SET status='completed',primary_complete=1,archive_complete=1,semantic_complete=1 WHERE id=?",
      )
      .bind(oldDeletion.deletionId),
  ]);
  const tombstoneMigration = env.TEST_MIGRATIONS.filter((m) =>
    m.name.startsWith("0011"),
  );
  await applyD1Migrations(upgradeDB, tombstoneMigration);
  await applyD1Migrations(upgradeDB, tombstoneMigration);
  expect(
    await upgradeDB
      .prepare(
        "SELECT min_writer_contract,max_writer_contract FROM feed_schema_compatibility",
      )
      .first(),
  ).toMatchObject({ min_writer_contract: 2, max_writer_contract: 2 });
  const fenceMigration = env.TEST_MIGRATIONS.filter((m) =>
    m.name.startsWith("0012"),
  );
  expect(fenceMigration).toHaveLength(1);
  await applyD1Migrations(upgradeDB, fenceMigration);
  await applyD1Migrations(upgradeDB, fenceMigration);
  await upgradeDB
    .prepare("UPDATE feed_adapter_write_fence SET enabled=1 WHERE id=1")
    .run();
  expect(
    await commands.deletion({
      githubId: 2,
      deletionId: oldDeletion.deletionId,
    }),
  ).toMatchObject({ status: "pending" });
  await clean(oldDeletion.deletionId, upgradeDB);
  expect(
    await upgradeDB
      .prepare(
        "SELECT slug FROM feed_user_tag_proposals WHERE id='already-redacted'",
      )
      .first("slug"),
  ).toBe("deleted-proposal");
  expect(
    await upgradeDB
      .prepare(
        "SELECT proposal_id,payload_hash,created_at FROM feed_tag_proposal_commands WHERE github_id=2 AND command_id=?",
      )
      .bind(oldCommand)
      .first(),
  ).toEqual({ proposal_id: "", payload_hash: "deleted", created_at: 0 });
  const governance = new FeedGovernance(upgradeDB);
  expect(
    await governance.proposal({
      proposalKind: "user",
      proposalId: "unowned-legacy",
    }),
  ).toEqual({ proposal: null });
  await expect(
    governance.review(mapped("unowned-legacy")),
  ).rejects.toMatchObject({ code: "governance_proposal_deleted" });
  expect(
    await upgradeDB
      .prepare(
        "SELECT retained_body_proposals FROM feed_user_proposal_quarantine_summary",
      )
      .first("retained_body_proposals"),
  ).toBe(1);
  const deletion = await remove(commands);
  await clean(deletion.deletionId, upgradeDB);
  expect(
    await upgradeDB
      .prepare("SELECT evidence_json,origin_proposal_id FROM feed_project_tags")
      .first(),
  ).toEqual({ evidence_json: "[]", origin_proposal_id: proposalId });
  expect(
    await upgradeDB
      .prepare("SELECT evidence_json FROM feed_user_tag_proposals WHERE id=?")
      .bind(proposalId)
      .first("evidence_json"),
  ).toBe("[]");
  // Successful attributed cleanup is not a promotion proof for unrelated,
  // unowned historical bodies. The visible aggregate remains a blocking count.
  expect(
    await upgradeDB
      .prepare(
        "SELECT retained_body_proposals FROM feed_user_proposal_quarantine_summary",
      )
      .first("retained_body_proposals"),
  ).toBe(1);
  expect(
    await upgradeDB
      .prepare(
        "SELECT evidence_json FROM feed_user_tag_proposals WHERE id='unowned-legacy'",
      )
      .first("evidence_json"),
  ).toBe('["unknown-private-marker"]');
});
