// Bundled only by feed-snapshot-local.mjs into a fresh loopback Miniflare instance.
// The imports below are resolved by that builder; this is never a deployed Worker.
import adapter from "local-drill-adapter";
import { SCHEMA } from "./feed-snapshot-schema.mjs";

const migrations = LOCAL_DRILL_MIGRATIONS;
const names = Object.keys(SCHEMA.tables).sort();
const visibleTables = [
  "feed_runtime_sessions",
  "feed_user_tag_preferences",
  "feed_user_project_states",
  "feed_behavior_signals",
  "feed_users",
  "feed_rate_windows",
];
const overlayTables = [
  "feed_profile_floors",
  "feed_profile_deletions",
  "feed_cleanup_jobs",
  "feed_runtime_outbox",
];
const fixtureActorIds = [101, 202, 303];
const adapterOperations = new Set([
  "health",
  "users.ensure",
  "users.get",
  "preferences.replace",
  "candidates.load",
  "requests.save",
  "events.append",
  "state.set",
  "sessions.put",
  "sessions.get",
  "profile.delete",
]);
let installed = false,
  reset = false;
function need(ok, code) {
  if (!ok) throw new Error(code);
}
function exact(value, keys) {
  need(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      Object.keys(value).every((k) => keys.includes(k)),
    "invalid_local_fields",
  );
}
function table(name) {
  need(names.includes(name), "table_not_allowed");
  return SCHEMA.tables[name];
}
function insertion(db, name, row, upsert = false) {
  const spec = table(name),
    columns = Object.keys(spec.columns);
  exact(row, columns);
  // Identifiers come only from the pinned registry, never request SQL or expressions.
  const suffix = upsert
    ? ` ON CONFLICT(${spec.primaryKey.join(",")}) DO UPDATE SET ${columns
        .filter((c) => !spec.primaryKey.includes(c))
        .map((c) => `${c}=excluded.${c}`)
        .join(",")}`
    : "";
  return db
    .prepare(
      `INSERT INTO ${name}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})${suffix}`,
    )
    .bind(...columns.map((c) => row[c]));
}
async function rows(db, sql, ...params) {
  return (
    await db
      .prepare(sql)
      .bind(...params)
      .all()
  ).results;
}
async function gate(db, closed) {
  const [control] = await rows(
    db,
    "SELECT * FROM feed_runtime_control WHERE id=1",
  );
  need(
    control?.writer_epoch === 1 &&
      control.schema_version === 7 &&
      control.writes_enabled === (closed ? 0 : 1),
    "local_writer_gate_mismatch",
  );
}
async function order(db) {
  const output = [],
    visiting = new Set(),
    visited = new Set();
  async function visit(name) {
    if (visited.has(name)) return;
    need(!visiting.has(name), "unsupported_foreign_key_cycle");
    visiting.add(name);
    for (const fk of await rows(db, `PRAGMA foreign_key_list(${name})`)) {
      table(fk.table);
      await visit(fk.table);
    }
    visiting.delete(name);
    visited.add(name);
    output.push(name);
  }
  for (const name of names) await visit(name);
  return output;
}
async function local(op, raw, env) {
  const db = env.FEED_DB;
  if (op === "install") {
    exact(raw, []);
    need(!installed, "already_installed");
    need(
      !(
        await rows(
          db,
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'feed_%'",
        )
      ).length,
      "database_not_new",
    );
    for (const statements of migrations)
      await db.batch(statements.map((sql) => db.prepare(sql)));
    installed = true;
    return { installed: true };
  }
  need(installed, "local_schema_not_installed");
  if (op === "inspect") {
    exact(raw, []);
    const actual = await rows(
      db,
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'feed_%' ORDER BY name",
    );
    const tables = {};
    for (const { name } of actual) {
      table(name);
      const uniqueKeys = [];
      for (const idx of await rows(db, `PRAGMA index_list(${name})`))
        if (idx.unique && idx.origin !== "pk")
          uniqueKeys.push(
            (await rows(db, `PRAGMA index_info(${idx.name})`)).map(
              (v) => v.name,
            ),
          );
      tables[name] = {
        columns: await rows(db, `PRAGMA table_info(${name})`),
        uniqueKeys,
      };
    }
    return { tables, restoreOrder: await order(db) };
  }
  if (op === "seed") {
    exact(raw, []);
    need(env.LOCAL_ROLE === "source", "source_only");
    await gate(db, false);
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          `INSERT INTO feed_projects(repo_key,analysis_id,owner_login,name,canonical_url,summary,topics_json,project_type,lifecycle,product_score,confidence,verification_level,exposure_band,treasure_eligible,analyzed_at,risks_json,published,source_hash,projected_at) VALUES('snapshot-owner/repo','snapshot-analysis','snapshot-owner','repo','https://github.com/snapshot-owner/repo','Synthetic local recovery fixture','[]','micro-tool','active-evolution',80,90,'verified','low',1,?,'{}',1,'synthetic-source-hash',?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO feed_project_tags(repo_key,tag_id,source,weight,confidence,analysis_id,taxonomy_version,created_at,updated_at) VALUES('snapshot-owner/repo','artifact:micro-tool','assessment',1,1,'snapshot-analysis',1,?,?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO feed_submission_provenance(repo_key,analysis_id,source_event_id,source_version,evidence_kind,evidence_ref,submitted_at) VALUES('snapshot-owner/repo','snapshot-analysis','local-source-event',1,'user_submission','synthetic-local-receipt',?)`,
        )
        .bind(now),
    ]);
    return { synthetic: true };
  }
  if (op === "gate") {
    exact(raw, ["closed"]);
    need(typeof raw.closed === "boolean", "invalid_gate");
    await db
      .prepare(
        "UPDATE feed_runtime_control SET writes_enabled=? WHERE id=1 AND writer_epoch=1 AND schema_version=7",
      )
      .bind(raw.closed ? 0 : 1)
      .run();
    await gate(db, raw.closed);
    return { closed: raw.closed };
  }
  if (op === "export") {
    exact(raw, ["table"]);
    table(raw.table);
    await gate(db, true);
    // Bounded fixture extraction; the general artifact validator itself streams.
    const result = await rows(db, `SELECT * FROM ${raw.table} LIMIT 1001`);
    need(result.length <= 1000, "local_fixture_table_limit");
    return { rows: result };
  }
  if (op === "inventory") {
    exact(raw, []);
    await gate(db, true);
    const counts = {};
    for (const name of names) {
      const [{ count }] = await rows(
        db,
        `SELECT COUNT(*) AS count FROM ${name}`,
      );
      need(count <= 1000, "local_fixture_table_limit");
      counts[name] = count;
    }
    await gate(db, true);
    return { counts };
  }
  if (op === "reset-target") {
    exact(raw, []);
    need(env.LOCAL_ROLE === "target" && !reset, "fresh_target_only");
    await gate(db, true);
    const [{ count }] = await rows(
      db,
      "SELECT (SELECT COUNT(*) FROM feed_users)+(SELECT COUNT(*) FROM feed_projects) AS count",
    );
    need(count === 0, "target_contains_business_rows");
    // Remove installation seeds only in this new target. Keep the closed writer control.
    const deletionOrder = (await order(db))
      .reverse()
      .filter((name) => name !== "feed_runtime_control");
    await db.batch(
      deletionOrder.map((name) => db.prepare(`DELETE FROM ${name}`)),
    );
    reset = true;
    return { reset: true };
  }
  if (op === "restore") {
    exact(raw, ["table", "rows"]);
    need(env.LOCAL_ROLE === "target" && reset, "fresh_target_only");
    await gate(db, true);
    const spec = table(raw.table);
    need(
      Array.isArray(raw.rows) &&
        raw.rows.length > 0 &&
        raw.rows.length <= 20 &&
        !spec.emptyOnly,
      "invalid_restore_batch",
    );
    if (raw.table === "feed_runtime_control")
      need(
        raw.rows.length === 1 &&
          raw.rows[0].id === 1 &&
          raw.rows[0].writer_epoch === 1 &&
          raw.rows[0].schema_version === 7 &&
          raw.rows[0].writes_enabled === 0,
        "restore_requires_closed_gate",
      );
    await db.batch(
      raw.rows.map((row) =>
        insertion(db, raw.table, row, raw.table === "feed_runtime_control"),
      ),
    );
    return { restored: raw.rows.length };
  }
  if (op === "overlay") {
    exact(raw, ["githubId", "records"]);
    need(
      env.LOCAL_ROLE === "target" && reset && raw.githubId === 202,
      "fixture_actor_only",
    );
    await gate(db, true);
    need(
      Array.isArray(raw.records) && raw.records.length === 4,
      "incomplete_delete_overlay",
    );
    const byTable = new Map(raw.records.map((r) => [r.table, r.row]));
    need(
      byTable.size === 4 && overlayTables.every((t) => byTable.has(t)),
      "incomplete_delete_overlay",
    );
    const floor = byTable.get("feed_profile_floors"),
      deletion = byTable.get("feed_profile_deletions"),
      cleanup = byTable.get("feed_cleanup_jobs"),
      outbox = byTable.get("feed_runtime_outbox");
    need(
      floor.github_id === 202 &&
        deletion.github_id === 202 &&
        cleanup.github_id === 202 &&
        deletion.profile_floor === floor.profile_floor &&
        cleanup.profile_floor === floor.profile_floor &&
        cleanup.deletion_id === deletion.id &&
        outbox.topic === "feed.user-delete.v1" &&
        outbox.aggregate_key === "gh:202" &&
        JSON.parse(outbox.payload_json).deletionId === deletion.id,
      "overlay_identity_mismatch",
    );
    const [currentFloor] = await rows(
      db,
      "SELECT profile_floor FROM feed_profile_floors WHERE github_id=202",
    );
    need(
      !currentFloor || currentFloor.profile_floor <= floor.profile_floor,
      "delete_floor_regression",
    );
    const [newerUser] = await rows(
      db,
      "SELECT github_id FROM feed_users WHERE github_id=202 AND profile_version>?",
      floor.profile_floor,
    );
    need(!newerUser, "overlay_newer_generation_present");
    // Match the immediate visibility fence in the real profile.delete transaction.
    // Event/request physical cleanup remains pending and is never reported completed.
    await db.batch([
      ...overlayTables.map((t) => insertion(db, t, byTable.get(t), true)),
      ...visibleTables.map((t) =>
        db.prepare(`DELETE FROM ${t} WHERE github_id=202`),
      ),
    ]);
    return { applied: true, cleanupCompleted: false };
  }
  if (op === "integrity") {
    exact(raw, []);
    await gate(db, true);
    return {
      foreignKeys: await rows(db, "PRAGMA foreign_key_check"),
      integrity: await rows(db, "PRAGMA quick_check"),
    };
  }
  throw new Error("local_operation_not_allowed");
}
const localWorker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      request.headers.get("x-local-drill-token") !== env.LOCAL_TOKEN ||
      request.method !== "POST" ||
      url.search
    )
      return Response.json(
        { error: "local_request_rejected" },
        { status: 403 },
      );
    if (url.pathname.startsWith("/internal/feed/v1/")) {
      if (
        !adapterOperations.has(url.pathname.slice("/internal/feed/v1/".length))
      )
        return new Response(null, { status: 404 });
      // Prevent accidental non-fixture users even on this loopback-only service.
      const copy = await request.clone().json();
      const actor =
        copy.githubId ?? copy.user?.githubId ?? copy.session?.githubId;
      if (actor !== undefined && !fixtureActorIds.includes(actor))
        return new Response(null, { status: 403 });
      return adapter.fetch(request, env);
    }
    try {
      need(url.pathname.startsWith("/__local/"), "local_operation_not_allowed");
      const text = await request.text();
      need(text.length <= 1024 * 1024, "local_request_too_large");
      return Response.json(
        await local(
          url.pathname.slice("/__local/".length),
          JSON.parse(text),
          env,
        ),
      );
    } catch (error) {
      return Response.json({ error: error.message }, { status: 400 });
    }
  },
};
export default localWorker;
