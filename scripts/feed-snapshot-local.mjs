#!/usr/bin/env node
// Real local workerd/D1 drill. There is no remote transport, existing DB path,
// production resource selector, generic SQL RPC, import command or promotion mode.
import { strict as assert } from "node:assert";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { SCHEMA } from "./feed-snapshot-schema.mjs";
import {
  canonical,
  digest,
  compareKeys,
  rowRecord,
  buildSnapshot,
  validateSnapshot,
} from "./feed-snapshot.mjs";

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const names = Object.keys(SCHEMA.tables).sort();
const overlayTables = [
  "feed_cleanup_jobs",
  "feed_profile_deletions",
  "feed_profile_floors",
  "feed_runtime_outbox",
];
export const LOCAL_PLAN = Object.freeze({
  format: "feed-local-d1-recovery-drill-v1",
  schema: SCHEMA.id,
  schemaVersion: 7,
  contractVersion: 1,
  tables: names.length,
  columns: Object.values(SCHEMA.tables).reduce(
    (n, v) => n + Object.keys(v.columns).length,
    0,
  ),
  profiles: ["cf_d1_r2"],
  modes: ["plan", "run"],
  resources: "two newly allocated local Miniflare D1 bindings",
  limits: {
    tableRows: 1000,
    restoreBatchRows: 20,
    requestTimeoutMs: 15000,
    totalDeadlineMs: 180000,
  },
  excluded: [
    "R2 object bytes",
    "core assessment database",
    "remote resources",
    "PostgreSQL",
    "schema 8",
    "real OAuth",
    "migration promotion",
    "RPO/RTO acceptance",
  ],
});
function need(ok, code) {
  if (!ok) throw new Error(code);
}
function exact(value, keys, code) {
  need(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      Object.keys(value).every((k) => keys.includes(k)),
    code,
  );
}
// The migration hashes are pinned before parsing. This parser supports the SQL
// used by 0001–0007; triggers and explicit transaction blocks are not accepted.
export function splitPinnedSQL(sql) {
  const statements = [];
  let current = "",
    quote = null,
    lineComment = false,
    blockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i],
      next = sql[i + 1];
    if (lineComment) {
      if (c === "\n") {
        lineComment = false;
        current += "\n";
      }
      continue;
    }
    if (blockComment) {
      if (c === "*" && next === "/") {
        blockComment = false;
        current += " ";
        i++;
      }
      continue;
    }
    if (quote) {
      current += c;
      if (c === quote) {
        if (next === quote) {
          current += next;
          i++;
        } else quote = null;
      }
      continue;
    }
    if (c === "-" && next === "-") {
      lineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      current += c;
      continue;
    }
    if (c === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else current += c;
  }
  need(!quote && !blockComment, "migration_sql_truncated");
  need(!current.trim(), "migration_statement_missing_terminator");
  need(
    statements.length > 0 &&
      statements.every(
        (s) =>
          !/^(?:CREATE\s+(?:TEMP\s+)?TRIGGER|BEGIN|COMMIT|ROLLBACK)\b/i.test(s),
      ),
    "unsupported_local_migration_sql",
  );
  return statements;
}
export function inspectSchema(actual) {
  exact(actual, ["tables", "restoreOrder"], "invalid_d1_schema_response");
  assert.deepEqual(
    Object.keys(actual.tables).sort(),
    names,
    "real D1 tables must match the pinned registry",
  );
  assert.deepEqual(
    [...actual.restoreOrder].sort(),
    names,
    "restore order must include every table once",
  );
  for (const name of names) {
    const spec = SCHEMA.tables[name],
      actualTable = actual.tables[name];
    assert.deepEqual(
      actualTable.columns.map((c) => c.name),
      Object.keys(spec.columns),
      name,
    );
    assert.deepEqual(
      actualTable.columns
        .filter((c) => c.pk)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name),
      spec.primaryKey,
      name,
    );
    assert.deepEqual(actualTable.uniqueKeys, spec.uniqueKeys, name);
    for (const column of actualTable.columns) {
      const expected = spec.columns[column.name];
      assert.equal(
        !(column.notnull || column.pk),
        expected.nullable,
        `${name}.${column.name} nullability`,
      );
      assert.equal(
        column.type.toUpperCase(),
        {
          unix_ms: "INTEGER",
          integer: "INTEGER",
          number: "REAL",
          json_text: "TEXT",
          text: "TEXT",
        }[expected.kind],
        `${name}.${column.name} storage type`,
      );
    }
  }
  return actual.restoreOrder;
}
export function validateOverlay(overlay, manifestSHA) {
  exact(
    overlay,
    [
      "format",
      "schema",
      "baseManifestSha256",
      "githubId",
      "capturedAt",
      "records",
      "sha256",
    ],
    "invalid_delete_overlay_fields",
  );
  need(
    overlay.format === "feed-local-delete-overlay-v1" &&
      overlay.schema === SCHEMA.id &&
      overlay.baseManifestSha256 === manifestSHA &&
      overlay.githubId === 202 &&
      Number.isSafeInteger(overlay.capturedAt),
    "delete_overlay_identity_mismatch",
  );
  const { sha256, ...payload } = overlay;
  need(digest(canonical(payload)) === sha256, "delete_overlay_hash_mismatch");
  need(
    Array.isArray(overlay.records) && overlay.records.length === 4,
    "incomplete_delete_overlay",
  );
  assert.deepEqual(
    overlay.records.map((r) => r.table),
    overlayTables,
    "delete overlay table allowlist",
  );
  for (const record of overlay.records)
    assert.deepEqual(
      record,
      rowRecord(record.table, record.row),
      "delete overlay row hash",
    );
  const data = Object.fromEntries(overlay.records.map((v) => [v.table, v.row]));
  const floor = data.feed_profile_floors,
    deletion = data.feed_profile_deletions,
    job = data.feed_cleanup_jobs,
    outbox = data.feed_runtime_outbox;
  need(
    floor.github_id === 202 &&
      deletion.github_id === 202 &&
      job.github_id === 202 &&
      deletion.profile_floor === floor.profile_floor &&
      job.profile_floor === floor.profile_floor &&
      job.deletion_id === deletion.id &&
      outbox.topic === "feed.user-delete.v1" &&
      outbox.aggregate_key === "gh:202" &&
      JSON.parse(outbox.payload_json).deletionId === deletion.id,
    "delete_overlay_actor_mismatch",
  );
  need(
    deletion.status === "pending" &&
      job.status === "pending" &&
      deletion.primary_complete === 0 &&
      deletion.archive_complete === 0 &&
      deletion.semantic_complete === 0,
    "delete_overlay_not_immediate_fence",
  );
  return data;
}
async function privateFile(path, value) {
  await writeFile(path, value, { flag: "wx", mode: 0o600 });
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`local_runtime_timeout:${label}`)),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function collect(runtime) {
  const { counts } = await runtime.local("inventory");
  assert.deepEqual(Object.keys(counts).sort(), names);
  const result = [];
  for (const table of names) {
    const { rows } = await runtime.local("export", { table });
    assert.equal(
      rows.length,
      counts[table],
      `separate D1 source inventory: ${table}`,
    );
    rows.sort((a, b) =>
      compareKeys(
        SCHEMA.tables[table].primaryKey.map((k) => a[k]),
        SCHEMA.tables[table].primaryKey.map((k) => b[k]),
      ),
    );
    for (const row of rows) {
      rowRecord(table, row);
      result.push({ table, row });
    }
  }
  assert.deepEqual(
    (await runtime.local("inventory")).counts,
    counts,
    "local fence must keep source counts stable across the export",
  );
  return result;
}
async function snapshot(directory, label, rows, source, timing) {
  const inventory = Object.fromEntries(names.map((name) => [name, 0]));
  for (const { table } of rows) inventory[table]++;
  const metadata = {
    snapshotId: randomUUID(),
    source,
    // The fixture has one synthetic source reference; this is not a core DB export.
    watermarks: { stream: "core_feed_outbox_sequence", start: "0", end: "1" },
    startedAt: timing.start,
    endedAt: timing.end,
    timeUnit: "unix_ms",
    inventory,
  };
  const input = join(directory, `${label}-input.ndjson`),
    output = join(directory, label);
  const handle = await open(input, "wx", 0o600);
  try {
    for (const row of rows) await handle.write(canonical(row) + "\n");
  } finally {
    await handle.close();
  }
  const build = await buildSnapshot({ metadata, input, output });
  const validation = await validateSnapshot({
    directory: output,
    expectedManifestSha256: build.manifestSha256,
  });
  return { directory: output, metadata, build, validation };
}
async function seedUsers(runtime) {
  const actors = {};
  for (const githubId of [101, 202, 303]) {
    let { user } = await runtime.bridge("users.ensure", {
      writerEpoch: 1,
      expectedProfileVersion: 0,
      githubId,
      login: `local-fixture-${githubId}`,
      avatarUrl: "",
    });
    ({ user } = await runtime.bridge("preferences.replace", {
      writerEpoch: 1,
      expectedProfileVersion: user.profileVersion,
      githubId,
      taxonomyVersion: 1,
      preferences: [
        {
          tagId: "artifact:micro-tool",
          value: 1,
          source: "explicit",
          strength: 1,
          taxonomyVersion: 1,
        },
      ],
    }));
    const { candidates } = await runtime.bridge("candidates.load", {
      githubId,
      limit: 1,
    });
    assert.equal(
      candidates.length,
      1,
      "fixture admission through real catalog",
    );
    const item = {
      project: candidates[0].project,
      candidateSources: ["latest"],
      reasonCodes: ["recent_project"],
      score: 0.735,
      rank: 0,
      exploration: false,
      propensity: 0.952,
      features: {
        productScore: 0.8,
        confidence: 0.9,
        freshness: 0.95,
        discoveryBoost: 1,
        mmrScore: 0.7,
      },
    };
    const requestId = `local-request-${githubId}`,
      sessionId = `local-session-${githubId}`,
      algorithmVersion = "baseline-v2-portable";
    await runtime.bridge("requests.save", {
      writerEpoch: 1,
      expectedProfileVersion: user.profileVersion,
      payloadHash: digest(`request-${githubId}`),
      id: requestId,
      algorithmVersion,
      user,
      seed: `seed-${githubId}`,
      candidateCounts: { latest: 1 },
      degraded: [],
      durationMs: 1,
      items: [item],
    });
    const event = {
      input: {
        id: `local-event-${githubId}`,
        type: "impression",
        repoKey: "snapshot-owner/repo",
        occurredAt: new Date().toISOString(),
        impressionToken: "local-fixture-no-public-token",
      },
      requestId,
      metadata: { rank: 0, algorithmVersion },
    };
    assert.equal(
      (
        await runtime.bridge("events.append", {
          writerEpoch: 1,
          expectedProfileVersion: user.profileVersion,
          githubId,
          events: [event],
        })
      ).accepted,
      1,
    );
    await runtime.bridge("state.set", {
      writerEpoch: 1,
      expectedProfileVersion: user.profileVersion,
      githubId,
      repoKey: "snapshot-owner/repo",
      requestId,
      saved: true,
      now: new Date().toISOString(),
    });
    ({ user } = await runtime.bridge("users.get", { githubId }));
    const now = Date.now();
    await runtime.bridge("sessions.put", {
      writerEpoch: 1,
      expectedProfileVersion: user.profileVersion,
      session: {
        id: sessionId,
        githubId,
        algorithmVersion,
        taxonomyVersion: 1,
        profileVersion: user.profileVersion,
        pageSize: 1,
        seed: `session-seed-${githubId}`,
        candidateCounts: { latest: 1 },
        degraded: [],
        items: [item],
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 1800000).toISOString(),
      },
    });
    actors[githubId] = { user, sessionId, event };
  }
  await runtime.bridge("profile.delete", {
    writerEpoch: 1,
    expectedProfileVersion: actors[303].user.profileVersion,
    githubId: 303,
    now: new Date().toISOString(),
  });
  return actors;
}
function compareRows(expected, actual, phase) {
  assert.equal(actual.length, expected.length, `${phase}: row count`);
  for (let i = 0; i < expected.length; i++) {
    assert.deepEqual(
      rowRecord(actual[i].table, actual[i].row),
      rowRecord(expected[i].table, expected[i].row),
      `${phase}: table, full business PK, every column/state/version and row hash`,
    );
  }
}
export async function runLocalDrill() {
  const start = Date.now(),
    schemaRoot = resolve(process.env.FEED_SNAPSHOT_SCHEMA_ROOT || ownRoot);
  const directory = await mkdtemp(join(tmpdir(), "ghfind-local-d1-recovery-"));
  const runtimes = [];
  let blockedOutboundRequests = 0;
  try {
    const migrations = [];
    for (const migration of SCHEMA.migrations) {
      const bytes = await readFile(join(schemaRoot, migration.path));
      need(
        digest(bytes) === migration.sha256,
        `pinned_migration_changed:${migration.path}`,
      );
      migrations.push(splitPinnedSQL(bytes.toString("utf8")));
    }
    const { build: bundle } = await import(
      pathToFileURL(
        join(ownRoot, "platform/runtime/node_modules/esbuild/lib/main.js"),
      )
    );
    const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } =
      await import(
        pathToFileURL(
          join(
            ownRoot,
            "platform/runtime/node_modules/miniflare/dist/src/index.js",
          ),
        )
      );
    const output = await bundle({
      entryPoints: [join(ownRoot, "scripts/feed-snapshot-local-worker.mjs")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      conditions: ["workerd", "worker", "browser"],
      external: ["node:*", "cloudflare:workers"],
      alias: {
        "local-drill-adapter": join(schemaRoot, "platform/feed/src/index.ts"),
      },
      define: { LOCAL_DRILL_MIGRATIONS: JSON.stringify(migrations) },
    });
    const script = output.outputFiles[0].text;
    const gitSHA = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: schemaRoot,
      encoding: "utf8",
    }).trim();
    const identities = { source: randomUUID(), target: randomUUID() };
    assert.notEqual(identities.source, identities.target);
    async function startRuntime(role) {
      const token = randomBytes(32).toString("hex"),
        bridge = randomBytes(32).toString("hex");
      const root = join(directory, role);
      await mkdir(root, { mode: 0o700 });
      const mf = new Miniflare(
        convertV4MiniflareOptions({
          name: `local-drill-${role}`,
          modules: true,
          script,
          compatibilityDate: "2026-09-08",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { FEED_DB: identities[role] },
          r2Buckets: { FEED_ARCHIVE: `local-empty-${role}` },
          bindings: {
            LOCAL_ROLE: role,
            LOCAL_TOKEN: token,
            FEED_BRIDGE_SECRET: bridge,
            FEED_SEMANTIC_STATE: "disabled",
          },
          resourcePersistencePath: join(root, "storage"),
          unsafeDevRegistryPath: join(root, "registry"),
          host: "127.0.0.1",
          port: 0,
          cf: false,
          telemetry: { enabled: false },
          log: new Log(LogLevel.ERROR),
          outboundService: () => {
            blockedOutboundRequests++;
            return new Response("local drill prohibits external requests", {
              status: 503,
            });
          },
        }),
      );
      runtimes.push(mf);
      const url = await bounded(mf.ready, `${role}:startup`);
      need(
        url.hostname === "127.0.0.1" && url.protocol === "http:",
        "non_local_runtime_url",
      );
      async function request(
        path,
        data,
        { status = 200, badToken = false } = {},
      ) {
        need(
          Date.now() - start < LOCAL_PLAN.limits.totalDeadlineMs,
          "local_drill_deadline",
        );
        const response = await fetch(new URL(path, url), {
          method: "POST",
          signal: AbortSignal.timeout(LOCAL_PLAN.limits.requestTimeoutMs),
          headers: {
            "content-type": "application/json",
            "x-local-drill-token": badToken ? "invalid" : token,
            authorization: `Bearer ${bridge}`,
            "x-feed-contract": "1",
          },
          body: JSON.stringify(data),
        });
        const text = await response.text();
        assert.equal(
          response.status,
          status,
          `${role} ${path}: ${text.slice(0, 300)}`,
        );
        return JSON.parse(text);
      }
      return {
        request,
        local: (op, data = {}, options) =>
          request(`/__local/${op}`, data, options),
        bridge: (op, data, options) =>
          request(`/internal/feed/v1/${op}`, data, options),
      };
    }
    const source = await startRuntime("source"),
      target = await startRuntime("target");
    await source.local("install");
    await target.local("install");
    const actualSchema = await source.local("inspect"),
      restoreOrder = inspectSchema(actualSchema);
    assert.deepEqual(
      inspectSchema(await target.local("inspect")),
      restoreOrder,
    );
    await source.local("inspect", {}, { status: 403, badToken: true });
    await source.local("arbitrary-sql", { sql: "SELECT 1" }, { status: 400 });
    await source.local("seed");
    const actors = await seedUsers(source);
    const snapshotStart = Date.now();
    await source.local("gate", { closed: true });
    await source.local("export", { table: "sqlite_master" }, { status: 400 });
    const before = await collect(source),
      snapshotEnd = Date.now();
    const sourceMetadata = {
      profile: "cf_d1_r2",
      schemaVersion: 7,
      contractVersion: 1,
      writerEpoch: 1,
      gitSHA,
      resourceId: identities.source,
    };
    const backup = await snapshot(directory, "backup", before, sourceMetadata, {
      start: snapshotStart,
      end: snapshotEnd,
    });
    const restoreStart = Date.now();
    await target.local("gate", { closed: true });
    await target.local("reset-target");
    // Import only validated, hash-pinned artifact records, not the in-memory source rows.
    await validateSnapshot({
      directory: backup.directory,
      expectedManifestSha256: backup.build.manifestSha256,
    });
    const parsed = (
      await readFile(join(backup.directory, "rows.ndjson"), "utf8")
    )
      .trimEnd()
      .split("\n")
      .map(JSON.parse);
    for (const table of restoreOrder) {
      const rows = parsed.filter((r) => r.table === table).map((r) => r.row);
      for (let i = 0; i < rows.length; i += 20)
        await target.local("restore", { table, rows: rows.slice(i, i + 20) });
    }
    const restored = await collect(target);
    compareRows(before, restored, "snapshot restore");
    // A failed D1 import batch must roll back earlier inserts, with the gate still closed.
    const existingUser = restored.find((r) => r.table === "feed_users").row;
    await target.local(
      "restore",
      {
        table: "feed_users",
        rows: [{ ...existingUser, github_id: 909 }, existingUser],
      },
      { status: 400 },
    );
    compareRows(
      before,
      await collect(target),
      "failed D1 restore batch rollback",
    );
    const restoredSnapshot = await snapshot(
      directory,
      "restored",
      restored,
      { ...sourceMetadata, resourceId: identities.target },
      { start: restoreStart, end: Date.now() },
    );
    assert.equal(restoredSnapshot.build.dataSha256, backup.build.dataSha256);
    const integrity = await target.local("integrity");
    assert.deepEqual(integrity.foreignKeys, []);
    assert.deepEqual(integrity.integrity, [{ quick_check: "ok" }]);
    // Source accepts a genuine adapter deletion AFTER the complete snapshot was built.
    await source.local("gate", { closed: false });
    await source.bridge("profile.delete", {
      writerEpoch: 1,
      expectedProfileVersion: actors[202].user.profileVersion,
      githubId: 202,
      now: new Date().toISOString(),
    });
    await source.local("gate", { closed: true });
    const after = await collect(source);
    const records = after
      .filter(
        ({ table, row }) =>
          overlayTables.includes(table) &&
          (row.github_id === 202 ||
            (table === "feed_runtime_outbox" &&
              row.aggregate_key === "gh:202" &&
              row.topic === "feed.user-delete.v1")),
      )
      .map(({ table, row }) => rowRecord(table, row));
    const payload = {
      format: "feed-local-delete-overlay-v1",
      schema: SCHEMA.id,
      baseManifestSha256: backup.build.manifestSha256,
      githubId: 202,
      capturedAt: Date.now(),
      records,
    };
    const overlay = { ...payload, sha256: digest(canonical(payload)) };
    validateOverlay(overlay, backup.build.manifestSha256);
    need(
      overlay.capturedAt >= backup.metadata.endedAt,
      "overlay_predates_snapshot",
    );
    await privateFile(
      join(directory, "post-snapshot-deletion.json"),
      canonical(overlay) + "\n",
    );
    // Re-read the independently captured fact file, validate every row/hash, then overlay.
    const reread = JSON.parse(
      await readFile(join(directory, "post-snapshot-deletion.json"), "utf8"),
    );
    validateOverlay(reread, backup.build.manifestSha256);
    await target.local("overlay", {
      githubId: reread.githubId,
      records: reread.records.map(({ table, row }) => ({ table, row })),
    });
    const overlaid = await collect(target);
    compareRows(after, overlaid, "post-snapshot deletion replay");
    const postSnapshot = await snapshot(
      directory,
      "post-deletion-restored",
      overlaid,
      { ...sourceMetadata, resourceId: identities.target },
      { start: restoreStart, end: Date.now() },
    );
    // A second application is a stable idempotent local deletion fence.
    await target.local("overlay", {
      githubId: reread.githubId,
      records: reread.records.map(({ table, row }) => ({ table, row })),
    });
    compareRows(after, await collect(target), "idempotent deletion replay");
    // Reopen ONLY this newly created local target to distinguish a profile fence
    // rejection from a closed writer gate rejection. This is not promotion.
    await target.local("gate", { closed: false });
    const { user: surviving } = await target.bridge("users.get", {
      githubId: 101,
    });
    assert.deepEqual(surviving, actors[101].user);
    await target.bridge("sessions.get", {
      writerEpoch: 1,
      expectedProfileVersion: surviving.profileVersion,
      githubId: 101,
      id: actors[101].sessionId,
    });
    const visibility = [];
    for (const githubId of [202, 303]) {
      const actor = actors[githubId],
        floor = overlaid.find(
          (v) =>
            v.table === "feed_profile_floors" && v.row.github_id === githubId,
        ).row.profile_floor;
      assert.equal((await target.bridge("users.get", { githubId })).user, null);
      await target.bridge(
        "sessions.get",
        {
          writerEpoch: 1,
          expectedProfileVersion: actor.user.profileVersion,
          githubId,
          id: actor.sessionId,
        },
        { status: 404 },
      );
      const stale = await target.bridge(
        "preferences.replace",
        {
          writerEpoch: 1,
          expectedProfileVersion: actor.user.profileVersion,
          githubId,
          taxonomyVersion: 1,
          preferences: [],
        },
        { status: 409 },
      );
      assert.equal(stale.error, "profile_version_changed");
      const { user: fresh } = await target.bridge("users.ensure", {
        writerEpoch: 1,
        expectedProfileVersion: 0,
        githubId,
        login: `local-fresh-${githubId}`,
        avatarUrl: "",
      });
      assert.equal(fresh.profileVersion, floor + 1);
      assert.deepEqual(fresh.preferences, []);
      const { candidates: freshCandidates } = await target.bridge(
        "candidates.load",
        { githubId, limit: 1 },
      );
      assert.equal(freshCandidates.length, 1);
      assert.equal(
        freshCandidates[0].seenAt,
        null,
        "new generation must not read impressions from the deleted generation while physical cleanup is pending",
      );
      await target.bridge(
        "sessions.get",
        {
          writerEpoch: 1,
          expectedProfileVersion: fresh.profileVersion,
          githubId,
          id: actor.sessionId,
        },
        { status: 404 },
      );
      // Fresh identity cannot reuse the old request's token/generation for events.
      const replay = await target.bridge(
        "events.append",
        {
          writerEpoch: 1,
          expectedProfileVersion: fresh.profileVersion,
          githubId,
          events: [
            {
              ...actor.event,
              input: {
                ...actor.event.input,
                id: `late-event-${githubId}`,
                occurredAt: new Date().toISOString(),
              },
            },
          ],
        },
        { status: 404 },
      );
      assert.equal(replay.error, "project_not_found");
      visibility.push({
        githubId,
        oldProfileVersion: actor.user.profileVersion,
        restoredFloor: floor,
        freshProfileVersion: fresh.profileVersion,
        oldSessionStatus: 404,
        stalePreferenceStatus: 409,
        oldRequestReplayStatus: 404,
        freshPreferences: 0,
        freshSeenAt: null,
      });
    }
    await target.local("gate", { closed: true });
    const outdatedOverlay = await target.local(
      "overlay",
      {
        githubId: reread.githubId,
        records: reread.records.map(({ table, row }) => ({ table, row })),
      },
      { status: 400 },
    );
    assert.equal(outdatedOverlay.error, "overlay_newer_generation_present");
    assert.equal(
      (await target.bridge("users.get", { githubId: 202 })).user.profileVersion,
      actors[202].user.profileVersion + 1,
      "old delete fixture cannot overwrite an already newer identity",
    );
    assert.equal(
      blockedOutboundRequests,
      0,
      "the fixture must not require external services",
    );
    const report = {
      ...LOCAL_PLAN,
      status: "passed",
      startedAt: start,
      finishedAt: Date.now(),
      elapsedMs: Date.now() - start,
      directory,
      identities,
      adapter: {
        gitSHA,
        bundleSha256: digest(script),
        source:
          "compiled working tree; bundle hash is authoritative for this drill",
      },
      runtime: {
        miniflareVersion: JSON.parse(
          await readFile(
            join(
              ownRoot,
              "platform/runtime/node_modules/miniflare/package.json",
            ),
            "utf8",
          ),
        ).version,
        persistence: "separate newly allocated local directories",
        access: "loopback HTTP; external Worker requests denied",
        nodeBindingProxyUsed: false,
      },
      migrations: SCHEMA.migrations,
      schemaVerified: true,
      restoreOrder,
      backup: backup.build,
      restored: restoredSnapshot.build,
      postDeletion: {
        manifestSha256: postSnapshot.build.manifestSha256,
        dataSha256: postSnapshot.build.dataSha256,
        overlaySha256: overlay.sha256,
        capturedAfterSnapshot: true,
        fullSourceTargetRowEquality: true,
        idempotentReplay: true,
        newerGenerationOverlayRejected: true,
        cleanupCompleted: false,
      },
      rows: before.length,
      tableCounts: backup.metadata.inventory,
      comparisons: {
        independentSourceInventory: true,
        everyPrimaryKey: true,
        everyColumnStateVersion: true,
        everyRowHash: true,
        entireSnapshotFileHash: true,
        failedBatchRolledBack: true,
        foreignKeyCheck: "passed",
        quickCheck: "ok",
      },
      visibility,
      writerGateClosedAtEnd: true,
      remoteRequests: 0,
      blockedOutboundRequests,
      syntheticFixture: true,
      promotionReady: false,
    };
    const stopped = await Promise.allSettled(
      runtimes.map((runtime) => bounded(runtime.dispose(), "shutdown")),
    );
    runtimes.length = 0;
    need(
      stopped.every((r) => r.status === "fulfilled"),
      "local_runtime_shutdown_failed",
    );
    await privateFile(
      join(directory, "evidence.json"),
      canonical(report) + "\n",
    );
    return report;
  } catch (error) {
    await privateFile(
      join(directory, "failure.json"),
      canonical({
        status: "failed",
        message: String(error.message),
        directory,
        promotionReady: false,
      }) + "\n",
    );
    throw new Error(`${error.message} (isolated artifacts: ${directory})`, {
      cause: error,
    });
  } finally {
    await Promise.allSettled(
      runtimes.map((runtime) => bounded(runtime.dispose(), "failure-shutdown")),
    );
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["plan", "run"].includes(args[0])) {
    console.error(
      "Usage: node scripts/feed-snapshot-local.mjs plan|run (no URL, database ID or persistence-path arguments)",
    );
    process.exitCode = 1;
  } else if (args[0] === "plan")
    console.log(JSON.stringify(LOCAL_PLAN, null, 2));
  else {
    const deadline = setTimeout(() => {
      console.error(
        "local drill exceeded its 180-second deadline; no successful recovery evidence issued",
      );
      process.exit(1);
    }, LOCAL_PLAN.limits.totalDeadlineMs);
    try {
      console.log(JSON.stringify(await runLocalDrill(), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  }
}
