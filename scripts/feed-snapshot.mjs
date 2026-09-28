#!/usr/bin/env node
// Offline artifact tooling. No database driver, network client, import SQL or promotion path.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, mkdir, open, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA, SCHEMAS, selectSchema } from "./feed-snapshot-schema.mjs";

export const FORMAT = "feed-relational-snapshot-v1";
export const LIMITS = Object.freeze({
  lineBytes: 8 * 1024 * 1024,
  fileBytes: 10 * 1024 * 1024 * 1024,
  rows: 5000000,
  manifestBytes: 1024 * 1024,
  uniqueKeys: 200000,
  deletionActors: 100000,
});
const timestampMinimum = 946684800000; // Admission range is explicit: 2000-01-01 through 9999-12-31 UTC.
const timestampMaximum = 253402300799999;
const shaPattern = /^[a-f0-9]{64}$/;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function need(value, code) {
  if (!value) throw new Error(code);
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value, keys, code) {
  need(
    object(value) &&
      Object.keys(value).length === keys.length &&
      Object.keys(value).every((key) => keys.includes(key)),
    code,
  );
}
function safeInteger(value) {
  return Number.isSafeInteger(value);
}
function time(value) {
  return (
    safeInteger(value) && value >= timestampMinimum && value <= timestampMaximum
  );
}
export function canonical(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    need(
      Number.isFinite(value) && !Object.is(value, -0),
      "unsupported_json_number",
    );
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  need(object(value), "unsupported_json_value");
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
      .join(",") +
    "}"
  );
}
export function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
export const SCHEMA_SHA256 = digest(canonical(SCHEMA)); // Stable schema-7 fingerprint.
export function schemaFingerprint(schemaVersion) {
  return digest(canonical(selectSchema("cf_d1_r2", schemaVersion, 1)));
}
function metadataSchema(meta) {
  return selectSchema(
    meta.source.profile,
    meta.source.schemaVersion,
    meta.source.contractVersion,
  );
}
const safety = Object.freeze({
  archiveObjectPayloadsIncluded: false,
  sourceCompletenessProven: false,
  consistentSourceReadProven: false,
  postSnapshotDeletionReplayRequired: true,
  promotionReady: false,
});
function watermark(value) {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
export function validateMetadata(meta) {
  exact(
    meta,
    [
      "snapshotId",
      "source",
      "watermarks",
      "startedAt",
      "endedAt",
      "timeUnit",
      "inventory",
    ],
    "invalid_metadata_fields",
  );
  need(uuidPattern.test(meta.snapshotId), "invalid_snapshot_id");
  exact(
    meta.source,
    [
      "profile",
      "schemaVersion",
      "contractVersion",
      "writerEpoch",
      "gitSHA",
      "resourceId",
    ],
    "invalid_source_fields",
  );
  const schema = metadataSchema(meta),
    names = Object.keys(schema.tables).sort();
  need(
    safeInteger(meta.source.writerEpoch) && meta.source.writerEpoch > 0,
    "invalid_writer_epoch",
  );
  need(
    /^[a-f0-9]{40}$/.test(meta.source.gitSHA) &&
      uuidPattern.test(meta.source.resourceId),
    "invalid_source_identity",
  );
  need(
    meta.timeUnit === "unix_ms" &&
      time(meta.startedAt) &&
      time(meta.endedAt) &&
      meta.startedAt <= meta.endedAt,
    "invalid_snapshot_time",
  );
  exact(
    meta.watermarks,
    ["stream", "start", "end"],
    "invalid_watermark_fields",
  );
  need(
    meta.watermarks.stream === "core_feed_outbox_sequence" &&
      watermark(meta.watermarks.start) &&
      watermark(meta.watermarks.end) &&
      BigInt(meta.watermarks.start) <= BigInt(meta.watermarks.end),
    "invalid_watermarks",
  );
  exact(meta.inventory, names, "missing_or_unknown_inventory_table");
  let total = 0;
  for (const name of names) {
    const rows = meta.inventory[name];
    need(safeInteger(rows) && rows >= 0, "invalid_inventory_count");
    total += rows;
    if (schema.tables[name].emptyOnly)
      need(rows === 0, "nonempty_transaction_guard");
  }
  need(total <= LIMITS.rows, "snapshot_row_limit");
  for (const name of [
    "feed_runtime_control",
    "feed_schema_compatibility",
    "feed_cleanup_policy",
    ...(schema.schemaVersion >= 12 ? ["feed_adapter_write_fence"] : []),
  ])
    need(meta.inventory[name] === 1, "missing_control_record");
  return meta;
}
function rowFor(table, row, schema) {
  const definition = schema.tables[table];
  need(Object.hasOwn(schema.tables, table), "unknown_snapshot_table");
  need(!definition.emptyOnly, "nonempty_transaction_guard");
  exact(
    row,
    Object.keys(definition.columns),
    "missing_or_unknown_snapshot_column",
  );
  for (const [column, spec] of Object.entries(definition.columns)) {
    const value = row[column];
    if (value === null) {
      need(spec.nullable, "null_not_allowed");
      continue;
    }
    if (
      spec.proposalCommandTombstoneZero &&
      (value === 0 || row.proposal_id === "" || row.payload_hash === "deleted")
    )
      need(
        value === 0 && row.proposal_id === "" && row.payload_hash === "deleted",
        "invalid_proposal_command_tombstone",
      );
    switch (spec.kind) {
      case "integer":
        need(
          safeInteger(value) && !Object.is(value, -0),
          "invalid_integer_column",
        );
        break;
      case "number":
        need(
          typeof value === "number" &&
            Number.isFinite(value) &&
            !Object.is(value, -0),
          "invalid_number_column",
        );
        break;
      case "unix_ms":
        need(
          time(value) || (spec.proposalCommandTombstoneZero && value === 0),
          "invalid_unix_ms_column",
        );
        break;
      case "text":
        need(typeof value === "string", "invalid_text_column");
        break;
      case "json_text":
        need(typeof value === "string", "invalid_json_text_column");
        try {
          JSON.parse(value);
        } catch {
          throw new Error("invalid_json_text_column");
        }
        break;
      default:
        throw new Error("unknown_column_kind");
    }
    if (spec.values) need(spec.values.includes(value), "invalid_enum_column");
    if (spec.minimum !== undefined)
      need(value >= spec.minimum, "column_below_minimum");
    if (spec.maximum !== undefined)
      need(value <= spec.maximum, "column_above_maximum");
    if (spec.exclusiveMinimum !== undefined)
      need(value > spec.exclusiveMinimum, "column_below_minimum");
  }
  const key = definition.primaryKey.map((column) => row[column]);
  need(
    key.every((value) => value !== null),
    "null_primary_key",
  );
  if (table === "feed_user_project_states")
    need(
      !(row.saved === 1 && row.not_interested === 1),
      "conflicting_project_state",
    );
  if (table === "feed_runtime_sessions")
    need(
      row.expires_at > row.created_at &&
        row.expires_at <= row.created_at + 1800000,
      "invalid_session_expiry",
    );
  if (table === "feed_profile_deletions" && row.status === "completed")
    need(
      row.primary_complete === 1 &&
        row.archive_complete === 1 &&
        row.semantic_complete === 1 &&
        row.completed_at !== null,
      "incomplete_deletion_marked_completed",
    );
  if (table === "feed_archive_objects" && row.status === "erased")
    need(
      row.erased_at !== null &&
        row.retain_marker_until !== null &&
        row.retain_marker_until >= row.erased_at,
      "missing_archive_deletion_marker",
    );
  return key;
}
export function compareKeys(a, b) {
  need(
    Array.isArray(a) && Array.isArray(b) && a.length === b.length,
    "invalid_primary_key_shape",
  );
  for (let i = 0; i < a.length; i++) {
    need(typeof a[i] === typeof b[i], "primary_key_type_changed");
    if (a[i] === b[i]) continue;
    // Integer keys compare numerically; text uses deterministic UTF-16 code units,
    // never localeCompare or the locale of an exporting database connection.
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}
export function rowRecord(table, row, schemaVersion = 7) {
  const schema = selectSchema("cf_d1_r2", schemaVersion, 1);
  const key = rowFor(table, row, schema);
  const sha256 = digest(canonical({ schema: schema.id, table, key, row }));
  return { table, key, row, sha256 };
}
async function regular(path, limit) {
  const stat = await lstat(path);
  need(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit,
    "not_a_bounded_regular_file",
  );
  return stat;
}
function parseCanonical(text, code) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(code);
  }
  // Exact canonical bytes also reject duplicate JSON object keys, negative zero,
  // ambiguous numeric spellings and silently accepted trailing whitespace.
  need(canonical(value) === text, "noncanonical_json");
  return value;
}
async function readDocument(path) {
  await regular(path, LIMITS.manifestBytes);
  const data = await readFile(path);
  need(
    data.length <= LIMITS.manifestBytes && data.at(-1) === 10,
    "invalid_manifest_bytes",
  );
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      data.subarray(0, -1),
    );
  } catch {
    throw new Error("invalid_utf8");
  }
  return {
    value: parseCanonical(text, "invalid_manifest_json"),
    sha256: digest(data),
  };
}
async function* lines(path, hash) {
  await regular(path, LIMITS.fileBytes);
  let parts = [],
    size = 0,
    total = 0,
    line = 0;
  for await (const chunk of createReadStream(path, {
    highWaterMark: 64 * 1024,
  })) {
    total += chunk.length;
    need(total <= LIMITS.fileBytes, "snapshot_file_limit");
    hash?.update(chunk);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      size += part.length;
      need(size <= LIMITS.lineBytes, "snapshot_line_limit");
      parts.push(part);
      if (newline < 0) break;
      need(size > 0, "blank_snapshot_line");
      line++;
      need(line <= LIMITS.rows, "snapshot_row_limit");
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(parts, size),
        );
      } catch {
        throw new Error("invalid_utf8");
      }
      yield {
        value: parseCanonical(text, "invalid_ndjson"),
        line,
        bytes: size + 1,
      };
      parts = [];
      size = 0;
      start = newline + 1;
    }
  }
  need(size === 0, "truncated_ndjson");
}
function checker(meta) {
  const schema = metadataSchema(meta),
    names = Object.keys(schema.tables).sort();
  const tables = Object.fromEntries(
    names.map((table) => [
      table,
      {
        table,
        primaryKey: schema.tables[table].primaryKey,
        columns: Object.keys(schema.tables[table].columns),
        rows: 0,
        hash: createHash("sha256"),
      },
    ]),
  );
  let previousTable = "",
    previousKey = null,
    uniques = [],
    total = 0;
  const floors = new Map(),
    requiredFloors = new Map();
  const controls = new Set();
  let activeTaxonomies = 0;
  function remember(map, actor, floor) {
    need(
      safeInteger(actor) && actor > 0 && safeInteger(floor) && floor > 0,
      "invalid_deletion_fence",
    );
    map.set(actor, Math.max(map.get(actor) || 0, floor));
    need(map.size <= LIMITS.deletionActors, "deletion_actor_limit");
  }
  function accept(record, encoded) {
    exact(record, ["table", "key", "row", "sha256"], "invalid_record_fields");
    const expected = rowRecord(record.table, record.row, schema.schemaVersion);
    need(
      canonical(record.key) === canonical(expected.key),
      "primary_key_mismatch",
    );
    need(record.sha256 === expected.sha256, "row_hash_mismatch");
    const table = record.table,
      definition = schema.tables[table],
      state = tables[table],
      row = record.row;
    if (table === previousTable)
      need(
        compareKeys(previousKey, record.key) < 0,
        "duplicate_or_unsorted_primary_key",
      );
    else {
      need(
        previousTable === "" || previousTable < table,
        "unsorted_snapshot_table",
      );
      uniques = definition.uniqueKeys.map(() => new Set());
    }
    previousTable = table;
    previousKey = record.key;
    definition.uniqueKeys.forEach((columns, index) => {
      const key = columns.map((name) => row[name]);
      if (key.some((value) => value === null)) return; // SQLite UNIQUE permits multiple NULLs.
      const encoded = canonical(key),
        set = uniques[index];
      need(!set.has(encoded), "duplicate_business_key");
      set.add(encoded);
      need(set.size <= LIMITS.uniqueKeys, "unique_key_limit");
    });
    state.rows++;
    need(state.rows <= meta.inventory[table], "source_inventory_mismatch");
    state.hash.update(encoded);
    total++;
    if (table === "feed_runtime_control") {
      need(
        row.id === 1 &&
          row.schema_version ===
            (schema.runtimeControlSchemaVersion ?? schema.schemaVersion) &&
          row.writer_epoch === meta.source.writerEpoch,
        "control_metadata_mismatch",
      );
      controls.add(table);
    }
    if (table === "feed_schema_compatibility") {
      need(
        row.id === 1 &&
          row.min_reader_contract <= 1 &&
          row.max_reader_contract >= 1 &&
          row.min_writer_contract <= (schema.writerContractVersion ?? 1) &&
          row.max_writer_contract >= (schema.writerContractVersion ?? 1),
        "incompatible_runtime_contract",
      );
      controls.add(table);
    }
    if (table === "feed_cleanup_policy") {
      need(row.id === 1, "invalid_cleanup_control");
      controls.add(table);
    }
    if (table === "feed_adapter_write_fence") {
      need(row.id === 1 && row.enabled === 1, "legacy_writer_fence_required");
      controls.add(table);
    }
    if (table === "feed_taxonomy_versions" && row.status === "active")
      activeTaxonomies++;
    if (table === "feed_profile_floors")
      remember(floors, row.github_id, row.profile_floor);
    if (table === "feed_profile_deletions" || table === "feed_cleanup_jobs")
      remember(requiredFloors, row.github_id, row.profile_floor);
    if (Object.hasOwn(row, "source_version"))
      need(
        BigInt(row.source_version) <= BigInt(meta.watermarks.end),
        "source_version_beyond_watermark",
      );
  }
  function finish() {
    need(
      controls.size === (schema.schemaVersion >= 12 ? 4 : 3),
      "missing_control_record",
    );
    need(activeTaxonomies === 1, "missing_active_taxonomy");
    for (const [actor, floor] of requiredFloors)
      need(
        (floors.get(actor) || 0) >= floor,
        "missing_or_stale_deletion_floor",
      );
    return {
      rows: total,
      tables: names.map((name) => {
        const state = tables[name];
        need(state.rows === meta.inventory[name], "source_inventory_mismatch");
        return {
          table: name,
          primaryKey: state.primaryKey,
          columns: state.columns,
          rows: state.rows,
          sha256: state.hash.digest("hex"),
        };
      }),
    };
  }
  return { accept, finish };
}
function manifest(meta, result, data) {
  const schema = metadataSchema(meta);
  return {
    format: FORMAT,
    schemaId: schema.id,
    schemaSha256: schemaFingerprint(schema.schemaVersion),
    metadata: meta,
    safety,
    data,
    tables: result.tables,
  };
}
function checkManifest(value) {
  exact(
    value,
    [
      "format",
      "schemaId",
      "schemaSha256",
      "metadata",
      "safety",
      "data",
      "tables",
    ],
    "invalid_manifest_fields",
  );
  validateMetadata(value.metadata);
  const schema = metadataSchema(value.metadata),
    names = Object.keys(schema.tables).sort();
  need(
    value.format === FORMAT &&
      value.schemaId === schema.id &&
      value.schemaSha256 === schemaFingerprint(schema.schemaVersion),
    "unsupported_snapshot_schema",
  );
  need(canonical(value.safety) === canonical(safety), "invalid_safety_claim");
  exact(
    value.data,
    ["file", "bytes", "rows", "sha256"],
    "invalid_data_descriptor",
  );
  need(
    value.data.file === "rows.ndjson" &&
      safeInteger(value.data.bytes) &&
      value.data.bytes >= 0 &&
      value.data.bytes <= LIMITS.fileBytes &&
      safeInteger(value.data.rows) &&
      value.data.rows >= 0 &&
      value.data.rows <= LIMITS.rows &&
      shaPattern.test(value.data.sha256),
    "invalid_data_descriptor",
  );
  need(
    Array.isArray(value.tables) && value.tables.length === names.length,
    "missing_snapshot_table",
  );
  value.tables.forEach((table, index) => {
    exact(
      table,
      ["table", "primaryKey", "columns", "rows", "sha256"],
      "invalid_table_descriptor",
    );
    const name = names[index];
    need(
      table.table === name &&
        canonical(table.primaryKey) ===
          canonical(schema.tables[name].primaryKey) &&
        canonical(table.columns) ===
          canonical(Object.keys(schema.tables[name].columns)) &&
        table.rows === value.metadata.inventory[name] &&
        shaPattern.test(table.sha256),
      "invalid_table_descriptor",
    );
  });
}
export async function buildSnapshot({ metadata, input, output }) {
  validateMetadata(metadata);
  await regular(input, LIMITS.fileBytes);
  await mkdir(output, { mode: 0o700 }); // EEXIST deliberately rejects overwrite or resume of any existing path.
  const partial = join(output, "rows.partial");
  const writer = await open(partial, "wx", 0o600);
  const check = checker(metadata),
    fileHash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const { value } of lines(input)) {
      exact(value, ["table", "row"], "invalid_input_record");
      const record = rowRecord(
          value.table,
          value.row,
          metadata.source.schemaVersion,
        ),
        encoded = canonical(record) + "\n";
      const buffer = Buffer.from(encoded);
      need(buffer.length - 1 <= LIMITS.lineBytes, "snapshot_line_limit");
      bytes += buffer.length;
      need(bytes <= LIMITS.fileBytes, "snapshot_file_limit");
      check.accept(record, buffer);
      fileHash.update(buffer);
      await writer.writeFile(buffer);
    }
    const result = check.finish();
    await writer.sync();
    await writer.close();
    const value = manifest(metadata, result, {
      file: "rows.ndjson",
      bytes,
      rows: result.rows,
      sha256: fileHash.digest("hex"),
    });
    checkManifest(value);
    await rename(partial, join(output, "rows.ndjson"));
    const encoded = canonical(value) + "\n",
      manifestWriter = await open(
        join(output, "manifest.partial"),
        "wx",
        0o600,
      );
    try {
      await manifestWriter.writeFile(encoded);
      await manifestWriter.sync();
    } finally {
      await manifestWriter.close();
    }
    await rename(
      join(output, "manifest.partial"),
      join(output, "manifest.json"),
    );
    return {
      snapshotId: metadata.snapshotId,
      rows: result.rows,
      tables: result.tables.length,
      manifestSha256: digest(encoded),
      dataSha256: value.data.sha256,
      ...safety,
    };
  } catch (error) {
    await writer.close().catch(() => {});
    throw error;
  }
}
export async function validateSnapshot({ directory, expectedManifestSha256 }) {
  const document = await readDocument(join(directory, "manifest.json"));
  if (expectedManifestSha256 !== undefined)
    need(
      shaPattern.test(expectedManifestSha256) &&
        document.sha256 === expectedManifestSha256,
      "manifest_hash_mismatch",
    );
  const value = document.value;
  checkManifest(value);
  const check = checker(value.metadata),
    fileHash = createHash("sha256");
  let bytes = 0;
  for await (const line of lines(join(directory, "rows.ndjson"), fileHash)) {
    const encoded = canonical(line.value) + "\n";
    bytes += line.bytes;
    check.accept(line.value, encoded);
  }
  const result = check.finish();
  need(
    bytes === value.data.bytes &&
      result.rows === value.data.rows &&
      fileHash.digest("hex") === value.data.sha256,
    "file_hash_or_length_mismatch",
  );
  need(
    canonical(result.tables) === canonical(value.tables),
    "table_hash_or_count_mismatch",
  );
  return {
    snapshotId: value.metadata.snapshotId,
    rows: result.rows,
    tables: result.tables.length,
    manifestSha256: document.sha256,
    dataSha256: value.data.sha256,
    ...safety,
  };
}
async function main(args) {
  if (args.length === 0 || (args[0] === "schema" && args.length <= 2)) {
    need(
      args.length < 2 || Object.hasOwn(SCHEMAS, args[1]),
      "unsupported_snapshot_schema",
    );
    const schema = selectSchema(
      "cf_d1_r2",
      args.length === 2 ? Number(args[1]) : 12,
      1,
    );
    console.log(
      canonical({
        format: FORMAT,
        schema,
        schemaSha256: schemaFingerprint(schema.schemaVersion),
        supportedSchemaVersions: Object.keys(SCHEMAS).map(Number),
        limits: LIMITS,
        safety,
      }),
    );
    return;
  }
  const action = args[0],
    options = {};
  const allowed =
    action === "build"
      ? ["--metadata", "--input", "--out"]
      : action === "validate"
        ? ["--dir", "--expected-manifest-sha256"]
        : [];
  need(allowed.length && args.length % 2 === 1, "invalid_snapshot_arguments");
  for (let i = 1; i < args.length; i += 2) {
    need(
      allowed.includes(args[i]) &&
        !Object.hasOwn(options, args[i]) &&
        args[i + 1],
      "invalid_snapshot_arguments",
    );
    options[args[i]] = args[i + 1];
  }
  let result;
  if (action === "build") {
    need(Object.keys(options).length === 3, "invalid_snapshot_arguments");
    result = await buildSnapshot({
      metadata: (await readDocument(options["--metadata"])).value,
      input: options["--input"],
      output: options["--out"],
    });
  } else {
    need(options["--dir"], "invalid_snapshot_arguments");
    result = await validateSnapshot({
      directory: options["--dir"],
      expectedManifestSha256: options["--expected-manifest-sha256"],
    });
  }
  console.log(canonical(result));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    // Never print input rows, user identities, paths or arbitrary file contents.
    const code = /^[a-z_]+$/.test(error.message)
      ? error.message
      : ["EEXIST", "ENOENT", "EACCES"].includes(error.code)
        ? error.code
        : "snapshot_failed";
    console.error(code);
    process.exitCode = 1;
  }
}
