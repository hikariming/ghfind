import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  splitPinnedSQL,
  runLocalDrill,
  validateOverlay,
  LOCAL_PLAN,
} from "./feed-snapshot-local.mjs";
import { validateSnapshot, digest, canonical } from "./feed-snapshot.mjs";

const cli = join(
  dirname(fileURLToPath(import.meta.url)),
  "feed-snapshot-local.mjs",
);
test("local CLI rejects remote URLs, identifiers and persistence paths without starting a runtime", () => {
  for (const args of [
    ["run", "--remote"],
    ["run", "--url", "https://example.invalid"],
    ["run", "--database-id", "anything"],
    ["run", "--persist-to", "/tmp/existing"],
    ["restore"],
    [],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no URL, database ID or persistence-path/);
    assert.equal(result.stdout, "");
  }
  const plan = spawnSync(process.execPath, [cli, "plan"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(plan.status, 0);
  assert.deepEqual(JSON.parse(plan.stdout), LOCAL_PLAN);
});
test("pinned migration parser handles comments and quoted semicolons and rejects truncation/transactions", () => {
  assert.deepEqual(
    splitPinnedSQL(
      "-- comment;\n CREATE TABLE a(v TEXT); /* comment; */ INSERT INTO a VALUES('it''s; safe');",
    ),
    ["CREATE TABLE a(v TEXT)", "INSERT INTO a VALUES('it''s; safe')"],
  );
  assert.throws(() => splitPinnedSQL("SELECT 'open;"), /truncated/);
  assert.throws(() => splitPinnedSQL("SELECT 1"), /missing_terminator/);
  assert.throws(
    () => splitPinnedSQL("BEGIN; SELECT 1; COMMIT;"),
    /unsupported/,
  );
  assert.throws(() => splitPinnedSQL("CREATE TRIGGER foo;"), /unsupported/);
});
test(
  "actual isolated workerd D1 restore preserves facts and overlays later deletions before new-generation reads",
  { timeout: 180000 },
  async () => {
    // Missing migrations, bundle dependencies or workerd support fail this test;
    // there is deliberately no mock fallback or integration-test skip.
    const report = await runLocalDrill();
    assert.equal(report.status, "passed");
    assert.notEqual(report.identities.source, report.identities.target);
    assert.equal(report.tables, 45);
    assert.equal(report.schemaVersion, 9);
    assert.equal(report.runtimeControlSchemaVersion, 7);
    assert.equal(report.columns, 348);
    assert.equal(report.governance.action, "create");
    assert.equal(report.governance.activeTaxonomyVersion, 2);
    assert.equal(report.governance.ledgerRows, 1);
    assert.equal(report.governance.restoredCommandReceiptEqual, true);
    assert.equal(report.governance.exactReplayChangedNoRows, true);
    assert.equal(report.governance.storedUserTaxonomyVersion, 1);
    assert.equal(report.governance.readUserTaxonomyVersion, 2);
    assert.equal(report.governance.storedPreferenceTaxonomyVersion, 1);
    assert.equal(report.governance.profileVersionUnchanged, true);
    assert.equal(report.backup.dataSha256, report.restored.dataSha256);
    assert.equal(report.postDeletion.fullSourceTargetRowEquality, true);
    assert.equal(report.postDeletion.idempotentReplay, true);
    assert.equal(report.postDeletion.cleanupCompleted, false);
    assert.equal(report.comparisons.failedBatchRolledBack, true);
    assert.equal(report.writerGateClosedAtEnd, true);
    assert.equal(report.promotionReady, false);
    for (const name of [
      "feed_users",
      "feed_user_tag_preferences",
      "feed_runtime_events",
      "feed_events",
      "feed_runtime_requests",
      "feed_runtime_sessions",
      "feed_profile_floors",
      "feed_profile_deletions",
      "feed_cleanup_jobs",
      "feed_runtime_control",
      "feed_governance_commands",
    ])
      assert.ok(
        report.tableCounts[name] > 0,
        `${name} has actual D1 fixture rows`,
      );
    for (const value of report.visibility) {
      assert.equal(value.oldProfileVersion, value.restoredFloor);
      assert.equal(value.freshProfileVersion, value.restoredFloor + 1);
      assert.equal(value.freshPreferences, 0);
      assert.equal(value.freshSeenAt, null);
      assert.equal(value.oldSessionStatus, 404);
      assert.equal(value.stalePreferenceStatus, 409);
      assert.equal(value.oldRequestReplayStatus, 404);
    }
    const directory = report.directory;
    try {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(join(directory, "evidence.json"))).mode & 0o777,
        0o600,
      );
      assert.deepEqual(
        JSON.parse(await readFile(join(directory, "evidence.json"), "utf8")),
        report,
      );
      await validateSnapshot({
        directory: join(directory, "backup"),
        expectedManifestSha256: report.backup.manifestSha256,
      });
      const overlay = JSON.parse(
        await readFile(join(directory, "post-snapshot-deletion.json"), "utf8"),
      );
      validateOverlay(overlay, report.backup.manifestSha256);
      assert.throws(
        () => validateOverlay(overlay, "f".repeat(64)),
        /identity_mismatch/,
      );
      const corrupted = structuredClone(overlay);
      corrupted.records[0].row.github_id = 101;
      assert.throws(
        () => validateOverlay(corrupted, report.backup.manifestSha256),
        /hash_mismatch/,
      );
      const omitted = structuredClone(overlay);
      omitted.records.pop();
      const { sha256: _, ...payload } = omitted;
      omitted.sha256 = digest(canonical(payload));
      assert.throws(
        () => validateOverlay(omitted, report.backup.manifestSha256),
        /incomplete/,
      );
      const extra = { ...overlay, promotionReady: true };
      assert.throws(
        () => validateOverlay(extra, report.backup.manifestSha256),
        /invalid_delete_overlay_fields/,
      );
    } finally {
      // Only the directory this invocation allocated can be cleaned by this test.
      assert.match(directory, /\/ghfind-local-d1-recovery-[A-Za-z0-9]+$/);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
