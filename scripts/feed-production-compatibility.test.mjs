// Run: node --import tsx --test scripts/feed-production-compatibility.test.mjs
// Local workerd regression evidence only. Historical rollback failures are
// deliberate counterexamples, never a production acceptance receipt.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  assessmentOutboxStatement,
  appSubmissionReceiptStatement,
} from "../platform/shared/feed-source-statements.ts";

const root = resolve(import.meta.dirname, "..");
const OLD = "aa8c683fefca182428a48c180af7e862f7469929";
const platform = createRequire(join(root, "platform/feed/package.json"));
const wrangler = createRequire(platform.resolve("wrangler"));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } =
  wrangler("miniflare");
const { build } = wrangler("esbuild");
const { unstable_splitSqlQuery: splitSQL } = platform("wrangler");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bridge = "synthetic-compatibility-bridge-only-32-characters";

test(
  "historical D1 upgrade and explicitly unsafe legacy rollback",
  { timeout: 90_000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "ghfind-production-compatibility-"),
    );
    const historicalSHA = git("rev-parse", OLD);
    const sourceSHA = git("rev-parse", "HEAD");
    const historicalSource = execFileSync(
      "git",
      ["show", `${historicalSHA}:src/lib/feed.ts`],
      { cwd: root },
    );
    const legacyPath = join(directory, "legacy-feed.ts");
    await symlink(
      join(root, "node_modules"),
      join(directory, "node_modules"),
      "dir",
    );
    t.after(async () => {
      await rm(join(directory, "node_modules"), { force: true });
      await rm(legacyPath, { force: true });
    });
    // Alias imports retain the actual application's D1 adapter. Only the legacy
    // business module is frozen to the historically deployed program.
    await writeFile(legacyPath, historicalSource);
    const legacy = await import(pathToFileURL(legacyPath).href);
    const result = await build({
      entryPoints: [join(root, "platform/feed/src/index.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      external: ["node:*", "cloudflare:*"],
    });
    let outbound = 0;
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: result.outputFiles[0].text,
        compatibilityDate: "2026-09-08",
        compatibilityFlags: ["nodejs_compat"],
        host: "127.0.0.1",
        port: 0,
        cf: false,
        telemetry: { enabled: false },
        log: new Log(LogLevel.ERROR),
        d1Databases: { FEED_DB: randomUUID(), CORE_DB: randomUUID() },
        r2Buckets: ["FEED_ARCHIVE"],
        resourcePersistencePath: join(directory, "storage"),
        unsafeDevRegistryPath: join(directory, "registry"),
        bindings: {
          FEED_BRIDGE_SECRET: bridge,
          FEED_EXECUTOR_SECRET: bridge + "executor",
          FEED_SEMANTIC_STATE: "disabled",
        },
        outboundService: () => {
          outbound++;
          return new Response("external requests prohibited", { status: 503 });
        },
      }),
    );
    const evidence = {
      format: "ghfind-production-compatibility-v1",
      sourceSHA,
      historicalSHA,
      historicalFeedSourceSHA256: hash(historicalSource),
      fixture: "synthetic, not production facts",
      productionAcceptance: false,
      legacyRollbackCompatible: false,
      checks: [],
    };
    let fullRunCompleted = false;
    t.after(async () => {
      delete globalThis[Symbol.for("__cloudflare-context__")];
      for (const key of [
        "FEED_MODE",
        "FEED_BACKEND",
        "FEED_SOURCE_OUTBOX_ENABLED",
        "AUTH_SECRET",
      ])
        delete process.env[key];
      await mf.dispose();
      // Retain only non-sensitive synthetic evidence, never local database files.
      await rm(join(directory, "storage"), { recursive: true, force: true });
      await rm(join(directory, "registry"), { recursive: true, force: true });
      await rm(legacyPath, { force: true });
      evidence.cleanupSuccessful = true;
      evidence.blockedOutboundRequests = outbound;
      evidence.status =
        fullRunCompleted && evidence.checks.length === 9 && outbound === 0
          ? "passed"
          : "failed";
      await writeFile(
        join(directory, "compatibility.json"),
        JSON.stringify(evidence, null, 2) + "\n",
      );
      t.diagnostic(`Evidence: ${join(directory, "compatibility.json")}`);
    });
    await mf.ready;
    const feed = await mf.getD1Database("FEED_DB"),
      core = await mf.getD1Database("CORE_DB");
    globalThis[Symbol.for("__cloudflare-context__")] = {
      env: { GHFIND_D1: core, GHFIND_FEED_D1: feed },
      ctx: {},
    };
    Object.assign(process.env, {
      FEED_MODE: "baseline",
      FEED_BACKEND: "legacy",
      FEED_SOURCE_OUTBOX_ENABLED: "false",
      AUTH_SECRET:
        "synthetic-compatibility-signing-secret-only-32-characters",
    });
    async function apply(db, folder, predicate, historical = false) {
      for (const name of (await readdir(join(root, folder)))
        .filter((n) => n.endsWith(".sql") && predicate(n))
        .sort()) {
        const text = historical
          ? execFileSync(
              "git",
              ["show", `${historicalSHA}:${folder}/${name}`],
              { cwd: root, encoding: "utf8" },
            )
          : await readFile(join(root, folder, name), "utf8");
        const queries = splitSQL(text);
        await db.batch(queries.map((sql) => db.prepare(sql)));
      }
    }
    async function rows(db, sql, ...args) {
      return (
        await db
          .prepare(sql)
          .bind(...args)
          .all()
      ).results;
    }
    async function call(op, body, status = 200) {
      const response = await mf.dispatchFetch(
        `http://localhost/internal/feed/v1/${op}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${bridge}`,
            "x-feed-contract": "1",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      const json = await response.json();
      assert.equal(response.status, status, JSON.stringify(json));
      return json;
    }
    const ensure = (githubId) =>
      call("users.ensure", {
        githubId,
        login: `synthetic-${githubId}`,
        avatarUrl: "",
        writerEpoch: 1,
        expectedProfileVersion: 0,
      });
    const viewer = (githubId) => ({
      githubId,
      login: `synthetic-${githubId}`,
      image: null,
    });
    await apply(feed, "migrations-feed", (n) => n < "0003", true);
    await apply(core, "migrations", (n) => n < "0005", true);
    const projects = JSON.stringify(
      Array.from({ length: 261 }, (_, n) => ({
        n,
        key: `synthetic-${n}/tool`,
        analysis: `synthetic-analysis-${n}`,
      })),
    );
    await feed
      .prepare(
        `INSERT INTO feed_projects(repo_key,analysis_id,owner_login,name,canonical_url,summary,project_type,lifecycle,
    product_score,confidence,verification_level,exposure_band,analyzed_at,risks_json,published,source_hash,projected_at)
    SELECT json_extract(value,'$.key'),json_extract(value,'$.analysis'),'synthetic-'||json_extract(value,'$.n'),'tool',
    'https://github.com/'||json_extract(value,'$.key'),'SYNTHETIC historical fixture','micro_tool','feature_complete',80,90,
    'source_inspected','low',1000,'[]',json_extract(value,'$.n')<235,'synthetic-hash',1000 FROM json_each(?)`,
      )
      .bind(projects)
      .run();
    await feed
      .prepare(
        `INSERT INTO feed_tag_proposals(id,repo_key,analysis_id,namespace,slug,label_zh,label_en,evidence_json,status,created_at,updated_at)
    VALUES('synthetic-pending','synthetic-0/tool','synthetic-analysis-0','use_case','synthetic-proposal','合成提议','Synthetic proposal','["synthetic"]','proposed',1000,1000)`,
      )
      .run();
    await core
      .prepare(
        `INSERT INTO project_analysis_runs(id,repo_key,canonical_url,idempotency_key,status,phase,schema_version,rubric_version,
    agent_version,skill_version,analysis_sha256,created_at,completed_at,updated_at)
    VALUES('synthetic-completed','synthetic-0/tool','https://github.com/synthetic-0/tool','synthetic-idempotency','completed','completed',
    'ghfind.project-analysis.v3','project-value-v1','project-evaluator-v3','ghfind-project-evaluator-v4',?,1000,2000,2000)`,
      )
      .bind("a".repeat(64))
      .run();
    await core
      .prepare(
        `INSERT INTO project_assessments(repo_key,latest_analysis_id,project_type,lifecycle,product_score,pain_score,
    effectiveness_score,experience_score,value_density_score,confidence,verification_level,unknowns_json,risks_json,exposure_band,
    resolved_commit_sha,rubric_version,analyzed_at,updated_at) VALUES('synthetic-0/tool','synthetic-completed','micro_tool','feature_complete',
    80,20,25,25,10,90,'source_inspected','[]','[]','low',?,'project-value-v1',2000,2000)`,
      )
      .bind("b".repeat(40))
      .run();
    const before = await rows(
      feed,
      "SELECT * FROM feed_projects ORDER BY repo_key",
    );

    await t.test(
      "historical 235-candidate page already exceeds D1 bindings before any upgrade",
      async () => {
        await assert.rejects(
          legacy.getFeedPage(viewer(106), { limit: 2 }),
          /too many SQL variables/,
        );
        await legacy.deleteFeedProfile(viewer(106));
        evidence.checks.push(
          "EXISTING baseline legacy page fails D1 parameter ceiling with 235 synthetic published projects",
        );
      },
    );

    await t.test(
      "0003..0011 preserve existing facts and pending governance without inventing consent",
      async () => {
        await apply(feed, "migrations-feed", (n) => n >= "0003");
        await apply(core, "migrations", (n) => n >= "0005");
        assert.deepEqual(
          await rows(feed, "SELECT * FROM feed_projects ORDER BY repo_key"),
          before,
        );
        assert.deepEqual(
          await rows(
            feed,
            "SELECT COUNT(*) n,SUM(published) published FROM feed_projects",
          ),
          [{ n: 261, published: 235 }],
        );
        assert.equal(
          (
            await rows(
              feed,
              "SELECT status FROM feed_tag_proposals WHERE id='synthetic-pending'",
            )
          )[0].status,
          "proposed",
        );
        for (const table of [
          "feed_submission_provenance",
          "feed_project_source_versions",
        ])
          assert.equal(
            (await rows(feed, `SELECT COUNT(*) n FROM ${table}`))[0].n,
            0,
          );
        assert.deepEqual(
          await rows(feed, "SELECT * FROM feed_schema_compatibility"),
          [
            {
              id: 1,
              min_reader_contract: 1,
              max_reader_contract: 1,
              min_writer_contract: 2,
              max_writer_contract: 2,
            },
          ],
        );
        assert.equal((await call("health", {})).ready, true);
        await ensure(101);
        assert.deepEqual(
          (await call("candidates.load", { githubId: 101, limit: 240 }))
            .candidates,
          [],
        );
        evidence.checks.push(
          "261 synthetic rows and 235 publish flags preserved; zero candidates without evidence",
        );
      },
    );

    await t.test(
      "core migrations and completion alone do not create submission receipts or outbox",
      async () => {
        for (const table of ["feed_submission_receipts", "feed_source_outbox"])
          assert.equal(
            (await rows(core, `SELECT COUNT(*) n FROM ${table}`))[0].n,
            0,
          );
        const outbox = assessmentOutboxStatement("synthetic-completed", 3000);
        await core
          .prepare(outbox.sql)
          .bind(...outbox.args)
          .run();
        assert.equal(
          (await rows(core, "SELECT COUNT(*) n FROM feed_source_outbox"))[0].n,
          0,
        );
        // An explicitly synthetic user POST intent now invokes the real fixed
        // statements. This is not proof that any production run has that intent.
        const receipt = appSubmissionReceiptStatement(
          { analysisId: "synthetic-completed" },
          3000,
        );
        await core.batch(
          [receipt, outbox].map((s) => core.prepare(s.sql).bind(...s.args)),
        );
        await core.batch(
          [receipt, outbox].map((s) => core.prepare(s.sql).bind(...s.args)),
        );
        assert.equal(
          (
            await rows(core, "SELECT COUNT(*) n FROM feed_submission_receipts")
          )[0].n,
          1,
        );
        assert.equal(
          (await rows(core, "SELECT COUNT(*) n FROM feed_source_outbox"))[0].n,
          1,
        );
        evidence.checks.push(
          "core historical completion is not consent; explicit synthetic submission is idempotent",
        );
      },
    );

    await t.test(
      "accidental raw reapplication of 0010 aborts atomically instead of partially rebuilding a table",
      async () => {
        const before = await rows(
          feed,
          "SELECT name,sql FROM sqlite_master WHERE name LIKE 'feed_user%' ORDER BY name",
        );
        const migration = splitSQL(
          await readFile(
            join(root, "migrations-feed/0010_user_proposal_privacy.sql"),
            "utf8",
          ),
        );
        await assert.rejects(
          feed.batch(migration.map((sql) => feed.prepare(sql))),
          /already exists|duplicate column|error in view feed_user_proposal_quarantine_summary: no such table/i,
        );
        assert.deepEqual(
          await rows(
            feed,
            "SELECT name,sql FROM sqlite_master WHERE name LIKE 'feed_user%' ORDER BY name",
          ),
          before,
        );
        assert.equal((await call("health", {})).ready, true);
        evidence.checks.push(
          "0010 raw replay is not idempotent; failed D1 batch preserves the prior schema",
        );
      },
    );

    await t.test(
      "upgraded schema still supports a legacy-only user journey before Go ownership",
      async () => {
        const actor = viewer(106);
        await assert.rejects(
          legacy.getFeedPage(actor, { limit: 2 }),
          /too many SQL variables/,
        );
        // Preserve the above failure as evidence. A separately bounded catalogue
        // isolates schema compatibility from the pre-existing >100-bindings bug.
        await feed
          .prepare(
            "UPDATE feed_projects SET published=0 WHERE repo_key NOT IN('synthetic-0/tool','synthetic-1/tool')",
          )
          .run();
        try {
          await legacy.replaceFeedPreferences(actor, {
            taxonomyVersion: 1,
            preferences: [{ tagId: "artifact:micro-tool", value: 1 }],
          });
          const page = await legacy.getFeedPage(actor, { limit: 2 });
          assert.equal(page.items.length, 2);
          const item = page.items[0];
          assert.equal(
            (
              await legacy.updateFeedProjectState(actor, item.project.repoKey, {
                saved: true,
                impressionToken: item.impressionToken,
              })
            ).saved,
            true,
          );
          const event = {
            id: randomUUID(),
            repoKey: item.project.repoKey,
            impressionToken: item.impressionToken,
            type: "impression",
            occurredAt: new Date().toISOString(),
          };
          assert.deepEqual(await legacy.appendFeedEvents(actor, [event]), {
            accepted: 1,
            duplicate: 0,
          });
          assert.deepEqual(await legacy.appendFeedEvents(actor, [event]), {
            accepted: 0,
            duplicate: 1,
          });
          assert.equal(
            (await legacy.deleteFeedProfile(actor)).status,
            "completed",
          );
          for (const table of [
            "feed_users",
            "feed_events",
            "feed_served_items",
            "feed_user_project_states",
            "feed_user_tag_preferences",
          ])
            assert.equal(
              (
                await rows(
                  feed,
                  `SELECT COUNT(*) n FROM ${table} WHERE github_id=106`,
                )
              )[0].n,
              0,
            );
        } finally {
          await feed
            .prepare(
              `UPDATE feed_projects SET published=COALESCE((SELECT json_extract(value,'$.n')<235 FROM json_each(?)
        WHERE json_extract(value,'$.key')=feed_projects.repo_key),published)`,
            )
            .bind(projects)
            .run();
        }
        evidence.checks.push(
          "legacy-only bounded two-project journey works after upgrade; 235-project failure persists unchanged",
        );
      },
    );

    await t.test(
      "only exact unrevoked evidence joins admit old projects; moderation still wins",
      async () => {
        await feed.batch(
          [0, 1, 2].map((n) =>
            feed
              .prepare(
                `INSERT INTO feed_submission_provenance
      (repo_key,analysis_id,source_event_id,source_version,evidence_kind,evidence_ref,submitted_at,revoked_at)
      VALUES(?,?,?,1,'verified_historical','SYNTHETIC compatibility fixture; not production consent',1000,?)`,
              )
              .bind(
                `synthetic-${n}/tool`,
                n === 1
                  ? "synthetic-stale-analysis"
                  : `synthetic-analysis-${n}`,
                `synthetic-event-${n}`,
                n === 2 ? 2000 : null,
              ),
          ),
        );
        await feed
          .prepare(
            `INSERT INTO feed_project_source_versions(repo_key,analysis_id,event_id,source_version,receipt_id,source_kind,
      submitted_at,item_id,resolved_commit_sha,descriptor,descriptor_hash,source_hash,blocked_reason,updated_at)
      VALUES('synthetic-3/tool','synthetic-analysis-3','synthetic-event-3',2,'synthetic-receipt-3','verified_backfill',1000,
      'synthetic-item-3',?,'SYNTHETIC projection fixture','synthetic-hash','synthetic-hash','',1000)`,
          )
          .bind("c".repeat(40))
          .run();
        const candidates = await call("candidates.load", {
          githubId: 101,
          limit: 240,
        });
        assert.deepEqual(
          candidates.candidates.map((c) => c.project.repoKey),
          ["synthetic-0/tool", "synthetic-3/tool"],
        );
        await feed
          .prepare(
            "INSERT INTO feed_project_moderation(repo_key,removed,updated_at) VALUES('synthetic-0/tool',1,3000)",
          )
          .run();
        assert.deepEqual(
          (
            await call("candidates.load", { githubId: 101, limit: 240 })
          ).candidates.map((c) => c.project.repoKey),
          ["synthetic-3/tool"],
        );
        await feed
          .prepare(
            "UPDATE feed_project_source_versions SET revoked_at=3000 WHERE repo_key='synthetic-3/tool'",
          )
          .run();
        assert.deepEqual(
          (await call("candidates.load", { githubId: 101, limit: 240 }))
            .candidates,
          [],
        );
        await feed
          .prepare(
            "DELETE FROM feed_project_moderation WHERE repo_key='synthetic-0/tool'",
          )
          .run();
        evidence.checks.push(
          "exact analysis, revocation and moderation filtering exercised through real adapter",
        );
      },
    );

    await t.test(
      "database writer flag rejects Go capability but cannot fence historical Next SQL",
      async () => {
        await feed
          .prepare(
            "UPDATE feed_runtime_control SET writes_enabled=0 WHERE id=1",
          )
          .run();
        await call(
          "users.ensure",
          {
            githubId: 102,
            login: "synthetic-102",
            avatarUrl: "",
            writerEpoch: 1,
            expectedProfileVersion: 0,
          },
          409,
        );
        assert.equal(
          (
            await rows(
              feed,
              "SELECT COUNT(*) n FROM feed_users WHERE github_id=102",
            )
          )[0].n,
          0,
        );
        await legacy.getFeedPreferences(viewer(102));
        assert.equal(
          (
            await rows(
              feed,
              "SELECT profile_version FROM feed_users WHERE github_id=102",
            )
          )[0].profile_version,
          1,
        );
        await feed
          .prepare(
            "UPDATE feed_runtime_control SET writes_enabled=1 WHERE id=1",
          )
          .run();
        evidence.checks.push(
          "UNSAFE historical Next GET wrote a user while the writer flag was closed",
        );
      },
    );

    await t.test(
      "historical Next recreates a deleted generation that fresh Go correctly increments",
      async () => {
        for (const githubId of [103, 104]) {
          await ensure(githubId);
          const deletion = await call("profile.delete", {
            githubId,
            writerEpoch: 1,
            expectedProfileVersion: 1,
            now: new Date().toISOString(),
          });
          assert.equal(deletion.status, "pending");
        }
        const fresh = await ensure(103);
        assert.equal(fresh.user.profileVersion, 2);
        await legacy.getFeedPreferences(viewer(104));
        const [resurrected] = await rows(
          feed,
          `SELECT u.profile_version,f.profile_floor FROM feed_users u
      JOIN feed_profile_floors f ON f.github_id=u.github_id WHERE u.github_id=104`,
        );
        assert.deepEqual(resurrected, { profile_version: 1, profile_floor: 1 });
        evidence.checks.push(
          "UNSAFE historical Next reused deleted profile version 1; Go-only re-entry used version 2",
        );
      },
    );

    await t.test(
      "historical Next reports deletion completed while actual Go-owned archive facts remain",
      async () => {
        await ensure(105);
        await feed
          .prepare(
            `INSERT INTO feed_archive_objects(object_key,github_id,profile_version,payload_hash,status,created_at)
      VALUES('synthetic/user-105.json',105,1,'synthetic-hash','stored',1000)`,
          )
          .run();
        const bucket = await mf.getR2Bucket("FEED_ARCHIVE");
        await bucket.put(
          "synthetic/user-105.json",
          "SYNTHETIC archived behavior",
        );
        await feed
          .prepare(
            `INSERT INTO feed_behavior_signals(github_id,repo_key,signal,occurred_at)
      VALUES(105,'synthetic-0/tool','outbound',1000)`,
          )
          .run();
        assert.equal(
          (await legacy.deleteFeedProfile(viewer(105))).status,
          "completed",
        );
        assert.equal(
          (
            await rows(
              feed,
              "SELECT COUNT(*) n FROM feed_archive_objects WHERE github_id=105",
            )
          )[0].n,
          1,
        );
        assert.equal(
          (
            await rows(
              feed,
              "SELECT COUNT(*) n FROM feed_behavior_signals WHERE github_id=105",
            )
          )[0].n,
          1,
        );
        assert.equal(
          (
            await rows(
              feed,
              "SELECT COUNT(*) n FROM feed_profile_floors WHERE github_id=105",
            )
          )[0].n,
          0,
        );
        assert.equal(
          await (await bucket.get("synthetic/user-105.json")).text(),
          "SYNTHETIC archived behavior",
        );
        await bucket.delete("synthetic/user-105.json");
        evidence.checks.push(
          "UNSAFE legacy deletion said completed with remaining actual R2 bytes, metadata and behavior",
        );
      },
    );
    assert.equal(outbound, 0);
    assert.deepEqual(await rows(feed, "PRAGMA foreign_key_check"), []);
    fullRunCompleted = true;
  },
);
