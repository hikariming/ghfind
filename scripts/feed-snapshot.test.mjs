import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  SCHEMA,
  SCHEMA_9,
  SCHEMA_10,
  selectSchema,
} from "./feed-snapshot-schema.mjs";
import {
  canonical,
  digest,
  compareKeys,
  rowRecord,
  buildSnapshot,
  validateSnapshot,
  validateMetadata,
  SCHEMA_SHA256,
  schemaFingerprint,
} from "./feed-snapshot.mjs";
const now = 1788825600000;
function seed(table, schema = SCHEMA) {
  const row = {};
  for (const [column, spec] of Object.entries(schema.tables[table].columns)) {
    row[column] = spec.nullable
      ? null
      : spec.values
        ? spec.values[0]
        : spec.kind === "unix_ms"
          ? now
          : spec.kind === "json_text"
            ? "{}"
            : spec.kind === "text"
              ? "fixture"
              : 1;
  }
  if (table === "feed_runtime_control")
    Object.assign(row, {
      id: 1,
      schema_version: 7,
      writer_epoch: 5,
      writes_enabled: 1,
    });
  if (table === "feed_runtime_sessions") row.expires_at = now + 1000;
  if (table === "feed_archive_objects")
    Object.assign(row, {
      status: "erased",
      erased_at: now,
      retain_marker_until: now + 180 * 86400000,
    });
  if (table === "feed_user_project_states")
    Object.assign(row, { saved: 0, not_interested: 0 });
  return row;
}
function fixture(schema = SCHEMA) {
  const rows = Object.entries(schema.tables)
    .filter(([, s]) => !s.emptyOnly)
    .map(([table]) => ({ table, row: seed(table, schema) }));
  const metadata = {
    snapshotId: "12345678-1234-4234-8234-123456789012",
    source: {
      profile: "cf_d1_r2",
      schemaVersion: schema.schemaVersion,
      contractVersion: 1,
      writerEpoch: 5,
      gitSHA: "a".repeat(40),
      resourceId: "22345678-1234-4234-8234-123456789012",
    },
    watermarks: { stream: "core_feed_outbox_sequence", start: "0", end: "100" },
    startedAt: now,
    endedAt: now + 1000,
    timeUnit: "unix_ms",
    inventory: {},
  };
  return { rows, metadata };
}
function prepare(f) {
  const schema = selectSchema(
    f.metadata.source.profile,
    f.metadata.source.schemaVersion,
    f.metadata.source.contractVersion,
  );
  for (const name of Object.keys(schema.tables)) f.metadata.inventory[name] = 0;
  for (const record of f.rows) f.metadata.inventory[record.table]++;
  f.rows.sort((a, b) =>
    a.table === b.table
      ? compareKeys(
          schema.tables[a.table].primaryKey.map((k) => a.row[k]),
          schema.tables[b.table].primaryKey.map((k) => b.row[k]),
        )
      : a.table < b.table
        ? -1
        : 1,
  );
  return f;
}
async function local(fn) {
  const directory = await mkdtemp(join(tmpdir(), "ghfind-snapshot-test-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function build(directory, f = prepare(fixture()), suffix = "snapshot") {
  const input = join(directory, `input-${suffix}.ndjson`);
  await writeFile(input, f.rows.map(canonical).join("\n") + "\n");
  const output = join(directory, suffix);
  const report = await buildSnapshot({ metadata: f.metadata, input, output });
  return { output, input, report, f };
}
async function rewriteManifest(output, mutate) {
  const path = join(output, "manifest.json");
  const value = JSON.parse(await readFile(path, "utf8"));
  mutate(value);
  await writeFile(path, canonical(value) + "\n");
}

test("schema 7 fingerprints remain byte compatible and only explicitly registered versions select", () => {
  assert.equal(
    SCHEMA_SHA256,
    "20a7df78a1d0cbf746460c39b4506dbe8f31c8a8352d310d5b23a678c74e2301",
  );
  const row = { id: 1, schema_version: 7, writer_epoch: 5, writes_enabled: 1 };
  assert.equal(
    rowRecord("feed_runtime_control", row).sha256,
    "59a856ad9a9a3cef1e025ce0cbc47c167a44b8f70a8d8e089c51ade7ec75b6b9",
  );
  assert.notEqual(
    rowRecord("feed_runtime_control", row, 9).sha256,
    rowRecord("feed_runtime_control", row, 7).sha256,
  );
  assert.notEqual(schemaFingerprint(9), SCHEMA_SHA256);
  for (const version of [8, 11, "9", null, "__proto__"])
    assert.throws(
      () => selectSchema("cf_d1_r2", version, 1),
      /unsupported_snapshot_schema/,
    );
  assert.throws(
    () => selectSchema("postgres", 19, 1),
    /unsupported_snapshot_schema/,
  );
  assert.throws(
    () => selectSchema("cf_d1_r2", 9, 2),
    /unsupported_snapshot_schema/,
  );
  assert.throws(
    () =>
      rowRecord(
        "feed_governance_commands",
        seed("feed_governance_commands", SCHEMA_9),
        7,
      ),
    /unknown_snapshot_table/,
  );
});

test("schema 9 round trip includes governance facts and multiple retired taxonomies with runtime control 7", async () =>
  local(async (directory) => {
    const f = fixture(SCHEMA_9);
    for (const version of [2, 3])
      f.rows.push({
        table: "feed_taxonomy_versions",
        row: { ...seed("feed_taxonomy_versions"), version, status: "retired" },
      });
    const first = await build(directory, prepare(f));
    const manifest = JSON.parse(
      await readFile(join(first.output, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.schemaId, "cf-d1-feed-9");
    assert.equal(manifest.schemaSha256, schemaFingerprint(9));
    assert.equal(manifest.metadata.source.schemaVersion, 9);
    assert.equal(
      (
        await validateSnapshot({
          directory: first.output,
          expectedManifestSha256: first.report.manifestSha256,
        })
      ).tables,
      45,
    );
    const records = (await readFile(join(first.output, "rows.ndjson"), "utf8"))
      .trimEnd()
      .split("\n")
      .map(JSON.parse);
    assert.equal(
      records.find((v) => v.table === "feed_runtime_control").row
        .schema_version,
      7,
    );
    assert.equal(
      records.filter((v) => v.table === "feed_governance_commands").length,
      1,
    );
    const second = await build(
      directory,
      {
        metadata: f.metadata,
        rows: records.map(({ table, row }) => ({ table, row })),
      },
      "restored9",
    );
    assert.equal(second.report.dataSha256, first.report.dataSha256);
    assert.equal(second.report.manifestSha256, first.report.manifestSha256);

    await rewriteManifest(first.output, (value) => {
      value.schemaId = SCHEMA.id;
      value.schemaSha256 = SCHEMA_SHA256;
    });
    await assert.rejects(
      validateSnapshot({ directory: first.output }),
      /unsupported_snapshot_schema/,
    );
    await rewriteManifest(first.output, (value) => {
      value.schemaId = manifest.schemaId;
      value.schemaSha256 = manifest.schemaSha256;
    });
    const record = records.find((v) => v.table === "feed_runtime_control");
    record.sha256 = rowRecord(record.table, record.row, 7).sha256;
    await writeFile(
      join(first.output, "rows.ndjson"),
      records.map(canonical).join("\n") + "\n",
    );
    await assert.rejects(
      validateSnapshot({ directory: first.output }),
      /row_hash_mismatch/,
    );
  }));

test("schema 9 rejects missing governance inventory, nonempty guards, changed control and invalid audit columns", async () =>
  local(async (directory) => {
    const missing = prepare(fixture(SCHEMA_9));
    delete missing.metadata.inventory.feed_governance_commands;
    assert.throws(
      () => validateMetadata(missing.metadata),
      /missing_or_unknown_inventory_table/,
    );
    const guard = prepare(fixture(SCHEMA_9));
    guard.metadata.inventory.feed_governance_guards = 1;
    assert.throws(
      () => validateMetadata(guard.metadata),
      /nonempty_transaction_guard/,
    );
    for (const changes of [
      { action: "auto-approve" },
      { proposal_kind: "owner-admin" },
      { operator: null },
      { writer_epoch: 1.5 },
      { assignment_weight: -0.1 },
      { assignment_confidence: 1.1 },
      { result_json: "{" },
      { created_at: 1788825600 },
      { arbitrary_payload: "forbidden" },
    ])
      assert.throws(() =>
        rowRecord(
          "feed_governance_commands",
          { ...seed("feed_governance_commands", SCHEMA_9), ...changes },
          9,
        ),
      );
    const control = fixture(SCHEMA_9);
    control.rows.find(
      (v) => v.table === "feed_runtime_control",
    ).row.schema_version = 9;
    await assert.rejects(
      build(directory, prepare(control), "incorrect-control"),
      /control_metadata_mismatch/,
    );
    const active = fixture(SCHEMA_9);
    active.rows.push({
      table: "feed_taxonomy_versions",
      row: { ...seed("feed_taxonomy_versions"), version: 2, status: "active" },
    });
    await assert.rejects(
      build(directory, prepare(active), "multiple-active"),
      /missing_active_taxonomy/,
    );
  }));

for (const schema of [SCHEMA, SCHEMA_9, SCHEMA_10])
  test(`fixed schema ${schema.schemaVersion} registry matches migrated SQLite columns, PKs and full/partial unique constraints`, () => {
    const root = process.env.FEED_SNAPSHOT_SCHEMA_ROOT || process.cwd();
    const source = schema.migrations.map((m) => ({
      path: join(root, m.path),
      sha256: m.sha256,
    }));
    const script = `import json,sys,sqlite3,hashlib,re
config=json.load(sys.stdin);db=sqlite3.connect(':memory:')
for item in config:
 b=open(item['path'],'rb').read();assert hashlib.sha256(b).hexdigest()==item['sha256'];db.executescript(b.decode())
result={}
for name, in db.execute("select name from sqlite_master where type='table' and name like 'feed_%' order by name"):
 columns=list(db.execute('pragma table_info('+name+')'));unique=[];partial=[]
 for idx in db.execute('pragma index_list('+name+')'):
  if not idx[2] or idx[3]=='pk': continue
  keys=[r[2] for r in db.execute('pragma index_info('+idx[1]+')')]
  if idx[4]:
   sql=db.execute("select sql from sqlite_master where type='index' and name=?",(idx[1],)).fetchone()[0]
   partial.append({'columns':keys,'where':re.search(r'\\bWHERE\\s+(.+?)\\s*$',sql,re.I).group(1)})
  else: unique.append(keys)
 result[name]={'columns':columns,'uniqueKeys':unique,'partialUniqueKeys':partial}
print(json.dumps(result))`;
    const actual = JSON.parse(
      execFileSync("python3", ["-c", script], {
        input: JSON.stringify(source),
        encoding: "utf8",
      }),
    );
    assert.deepEqual(Object.keys(actual), Object.keys(schema.tables).sort());
    for (const [table, definition] of Object.entries(schema.tables)) {
      const columns = actual[table].columns;
      assert.deepEqual(
        columns.map((c) => c[1]),
        Object.keys(definition.columns),
        table,
      );
      assert.deepEqual(
        columns
          .filter((c) => c[5])
          .sort((a, b) => a[5] - b[5])
          .map((c) => c[1]),
        definition.primaryKey,
        table,
      );
      assert.deepEqual(actual[table].uniqueKeys, definition.uniqueKeys, table);
      assert.deepEqual(
        actual[table].partialUniqueKeys,
        definition.partialUniqueKeys ?? [],
        table,
      );
      for (const c of columns) {
        assert.equal(
          definition.columns[c[1]].nullable,
          !(c[3] || c[5]),
          `${table}.${c[1]}`,
        );
        assert.equal(
          definition.columns[c[1]].kind === "unix_ms"
            ? "INTEGER"
            : definition.columns[c[1]].kind === "json_text"
              ? "TEXT"
              : { text: "TEXT", integer: "INTEGER", number: "REAL" }[
                  definition.columns[c[1]].kind
                ],
          c[2].toUpperCase(),
        );
      }
    }
  });
test("synthetic all-table round trip preserves every row, composite key, hash and deletion/control fact", async () =>
  local(async (directory) => {
    const first = await build(directory);
    const result = await validateSnapshot({
      directory: first.output,
      expectedManifestSha256: first.report.manifestSha256,
    });
    assert.equal(result.tables, 43);
    assert.equal(result.rows, first.f.rows.length);
    assert.equal(result.promotionReady, false);
    assert.equal(result.postSnapshotDeletionReplayRequired, true);
    assert.equal(
      (await stat(join(first.output, "rows.ndjson"))).mode & 0o777,
      0o600,
    );
    const data = (await readFile(join(first.output, "rows.ndjson"), "utf8"))
      .trimEnd()
      .split("\n")
      .map(JSON.parse);
    const restored = {
      metadata: first.f.metadata,
      rows: data.map(({ table, row }) => ({ table, row })),
    };
    const second = await build(directory, restored, "round-trip");
    assert.equal(second.report.dataSha256, first.report.dataSha256);
    assert.equal(second.report.manifestSha256, first.report.manifestSha256);
    for (const table of [
      "feed_profile_floors",
      "feed_profile_deletions",
      "feed_cleanup_jobs",
      "feed_archive_objects",
      "feed_runtime_control",
    ])
      assert.equal(
        data.some((v) => v.table === table),
        true,
      );
  }));
test("numeric primary keys order numerically and repeated composite primary keys reject", async () =>
  local(async (directory) => {
    assert.equal(compareKeys([2], [10]), -1);
    assert.equal(compareKeys([10], [2]), 1);
    assert.equal(compareKeys(["2"], ["10"]), 1);
    const f = fixture();
    f.rows = f.rows.filter((v) => v.table !== "feed_users");
    for (const github_id of [10, 2])
      f.rows.push({
        table: "feed_users",
        row: { ...seed("feed_users"), github_id },
      });
    const ordered = await build(directory, prepare(f));
    const records = (
      await readFile(join(ordered.output, "rows.ndjson"), "utf8")
    )
      .trimEnd()
      .split("\n")
      .map(JSON.parse)
      .filter((v) => v.table === "feed_users");
    assert.deepEqual(
      records.map((v) => v.key),
      [[2], [10]],
    );
    const bad = fixture();
    bad.rows.push(
      structuredClone(
        bad.rows.find((v) => v.table === "feed_user_tag_preferences"),
      ),
    );
    prepare(bad);
    await assert.rejects(
      build(directory, bad, "duplicate"),
      /duplicate_or_unsorted_primary_key/,
    );
    await assert.rejects(
      stat(join(directory, "duplicate", "manifest.json")),
      (error) => error.code === "ENOENT",
    );
  }));
test("duplicate non-PK business identity and unsorted tables cannot create an accepted artifact", async () =>
  local(async (directory) => {
    const f = fixture(),
      copy = structuredClone(
        f.rows.find((v) => v.table === "feed_tag_definitions"),
      );
    copy.row.id = "second-id";
    f.rows.push(copy);
    prepare(f);
    await assert.rejects(
      build(directory, f, "business-duplicate"),
      /duplicate_business_key/,
    );
    const g = prepare(fixture());
    g.rows.reverse();
    await assert.rejects(
      build(directory, g, "unordered"),
      /unsorted_snapshot_table/,
    );
  }));
test("missing tables, control rows, tombstone columns or deletion floors fail closed", async () =>
  local(async (directory) => {
    const missing = prepare(fixture());
    delete missing.metadata.inventory.feed_profile_floors;
    assert.throws(
      () => validateMetadata(missing.metadata),
      /missing_or_unknown_inventory_table/,
    );
    for (const name of [
      "feed_runtime_control",
      "feed_schema_compatibility",
      "feed_cleanup_policy",
      "feed_profile_floors",
    ]) {
      const f = fixture();
      f.rows = f.rows.filter((v) => v.table !== name);
      prepare(f);
      await assert.rejects(
        build(directory, f, name),
        name === "feed_profile_floors"
          ? /missing_or_stale_deletion_floor/
          : /missing_control_record/,
      );
    }
    const f = fixture();
    delete f.rows.find((v) => v.table === "feed_archive_objects").row
      .retain_marker_until;
    prepare(f);
    await assert.rejects(
      build(directory, f, "missing-marker-column"),
      /missing_or_unknown_snapshot_column/,
    );
    const g = fixture();
    g.rows.find((v) => v.table === "feed_archive_objects").row.erased_at = null;
    prepare(g);
    await assert.rejects(
      build(directory, g, "missing-marker-value"),
      /missing_archive_deletion_marker/,
    );
  }));
test("column types, nullability, enums, JSON text and Unix milliseconds are validated", () => {
  const cases = [
    ["feed_users", { github_id: "1" }],
    ["feed_users", { login: null }],
    ["feed_users", { created_at: 1788825600 }],
    ["feed_projects", { topics_json: "{broken" }],
    ["feed_users", { secret: "forbidden" }],
    ["feed_tag_definitions", { status: "auto-approved" }],
    ["feed_user_project_states", { saved: 1, not_interested: 1 }],
    ["feed_runtime_sessions", { expires_at: now + 1800001 }],
    ["feed_profile_deletions", { status: "completed", primary_complete: 0 }],
  ];
  for (const [table, change] of cases)
    assert.throws(() => rowRecord(table, { ...seed(table), ...change }));
  assert.throws(
    () => rowRecord("production_core_sql", {}),
    /unknown_snapshot_table/,
  );
  assert.throws(
    () => rowRecord("feed_command_guards", seed("feed_command_guards")),
    /nonempty_transaction_guard/,
  );
  for (const json of ["null", "true", "123", "[]", "{}", '"text"'])
    assert.doesNotThrow(() =>
      rowRecord("feed_projects", {
        ...seed("feed_projects"),
        topics_json: json,
      }),
    );
});
test("truncated, corrupt row hashes, wrong file hashes and incomplete manifests reject", async () =>
  local(async (directory) => {
    const f = await build(directory);
    const path = join(f.output, "rows.ndjson"),
      original = await readFile(path);
    await writeFile(path, original.subarray(0, -1));
    await assert.rejects(
      validateSnapshot({ directory: f.output }),
      /truncated_ndjson/,
    );
    const records = original.toString().trimEnd().split("\n").map(JSON.parse);
    records[0].sha256 = "0".repeat(64);
    await writeFile(path, records.map(canonical).join("\n") + "\n");
    await assert.rejects(
      validateSnapshot({ directory: f.output }),
      /row_hash_mismatch/,
    );
    await writeFile(path, original);
    const manifest = await readFile(join(f.output, "manifest.json"));
    await rewriteManifest(f.output, (v) => {
      v.data.sha256 = "0".repeat(64);
    });
    await assert.rejects(
      validateSnapshot({ directory: f.output }),
      /file_hash_or_length_mismatch/,
    );
    await writeFile(join(f.output, "manifest.json"), manifest);
    await rewriteManifest(f.output, (v) => v.tables.pop());
    await assert.rejects(
      validateSnapshot({ directory: f.output }),
      /missing_snapshot_table/,
    );
  }));
test("manifest cannot claim promotion readiness or hide source schema, inventory and pinned hash mismatches", async () =>
  local(async (directory) => {
    const f = await build(directory);
    await assert.rejects(
      validateSnapshot({
        directory: f.output,
        expectedManifestSha256: "0".repeat(64),
      }),
      /manifest_hash_mismatch/,
    );
    await rewriteManifest(f.output, (v) => {
      v.safety.promotionReady = true;
    });
    await assert.rejects(
      validateSnapshot({ directory: f.output }),
      /invalid_safety_claim/,
    );
    for (const change of [
      { profile: "postgres", schemaVersion: 19 },
      { schemaVersion: 8 },
      { writerEpoch: 0 },
    ]) {
      const m = prepare(fixture()).metadata;
      Object.assign(m.source, change);
      assert.throws(() => validateMetadata(m));
    }
    const inventory = prepare(fixture());
    inventory.metadata.inventory.feed_users++;
    await assert.rejects(
      build(directory, inventory, "omitted-row"),
      /source_inventory_mismatch/,
    );
    const epoch = prepare(fixture());
    epoch.metadata.source.writerEpoch = 6;
    await assert.rejects(
      build(directory, epoch, "epoch-mismatch"),
      /control_metadata_mismatch/,
    );
  }));
test("build never overwrites an existing artifact and CLI default is offline schema discovery", async () =>
  local(async (directory) => {
    const f = await build(directory),
      before = await readFile(join(f.output, "manifest.json"));
    await assert.rejects(
      buildSnapshot({
        metadata: f.f.metadata,
        input: f.input,
        output: f.output,
      }),
      (error) => error.code === "EEXIST",
    );
    assert.deepEqual(await readFile(join(f.output, "manifest.json")), before);
    const result = JSON.parse(
      execFileSync(process.execPath, ["scripts/feed-snapshot.mjs"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      }),
    );
    assert.equal(result.format, "feed-relational-snapshot-v1");
    assert.equal(result.safety.promotionReady, false);
    assert.equal(result.schema.profile, "cf_d1_r2");
  }));
test("noncanonical duplicate JSON keys, invalid UTF-8 and second-based metadata are rejected", async () =>
  local(async (directory) => {
    const f = prepare(fixture()),
      input = join(directory, "bad.ndjson");
    await writeFile(
      input,
      '{"row":{},"table":"feed_users","table":"feed_projects"}\n',
    );
    await assert.rejects(
      buildSnapshot({
        metadata: f.metadata,
        input,
        output: join(directory, "duplicate-json"),
      }),
      /noncanonical_json/,
    );
    await writeFile(input, Buffer.from([0xff, 10]));
    await assert.rejects(
      buildSnapshot({
        metadata: f.metadata,
        input,
        output: join(directory, "invalid-utf8"),
      }),
      /invalid_utf8/,
    );
    f.metadata.startedAt = 1788825600;
    assert.throws(() => validateMetadata(f.metadata), /invalid_snapshot_time/);
    assert.equal(
      digest("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  }));

test("stream boundaries preserve large UTF-8 rows and build/validate CLI pin the same manifest", async () =>
  local(async (directory) => {
    const f = fixture();
    f.rows.find((v) => v.table === "feed_projects").row.summary =
      "项目摘要".repeat(24000);
    prepare(f);
    const input = join(directory, "stream-input.ndjson"),
      metadata = join(directory, "metadata.json"),
      output = join(directory, "cli-artifact");
    await writeFile(input, f.rows.map(canonical).join("\n") + "\n");
    await writeFile(metadata, canonical(f.metadata) + "\n");
    const first = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "scripts/feed-snapshot.mjs",
          "build",
          "--metadata",
          metadata,
          "--input",
          input,
          "--out",
          output,
        ],
        { encoding: "utf8" },
      ),
    );
    const checked = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "scripts/feed-snapshot.mjs",
          "validate",
          "--dir",
          output,
          "--expected-manifest-sha256",
          first.manifestSha256,
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(first.dataSha256, checked.dataSha256);
    assert.equal(first.manifestSha256, checked.manifestSha256);
    assert.equal(checked.promotionReady, false);
    const records = (await readFile(join(output, "rows.ndjson"), "utf8"))
      .trimEnd()
      .split("\n")
      .map(JSON.parse);
    assert.equal(
      records.find((v) => v.table === "feed_projects").row.summary,
      "项目摘要".repeat(24000),
    );
  }));
