#!/usr/bin/env node
/**
 * Comment moderation: review recent UGC comments and hide/unhide them.
 * Reads/writes the same Turso database the app uses (`.env` via _env.mjs).
 *
 * Usage:
 *   node scripts/moderate-comments.mjs list [limit]          # recent comments, all tables
 *   node scripts/moderate-comments.mjs hide <table> <id>     # set hidden = 1
 *   node scripts/moderate-comments.mjs unhide <table> <id>   # set hidden = 0
 *
 * <table> is one of: profile | blog | collection
 */
import "./_env.mjs";
import { createClient } from "@libsql/client";

const TABLES = {
  profile: { name: "profile_comments", target: "target_username" },
  // Collection comments share blog_comments with a "collection:" slug prefix
  // (see collectionCommentKey in src/lib/db.ts).
  blog: { name: "blog_comments", target: "post_slug", where: "post_slug NOT LIKE 'collection:%'" },
  collection: { name: "blog_comments", target: "post_slug", where: "post_slug LIKE 'collection:%'" },
};

const [command, ...rest] = process.argv.slice(2);

function usage() {
  console.error(
    "usage: moderate-comments.mjs list [limit] | hide <profile|blog|collection> <id> | unhide <profile|blog|collection> <id>",
  );
  process.exit(1);
}

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error("TURSO_DATABASE_URL is not set (check .env / .env.local)");
  process.exit(1);
}
const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

if (command === "list") {
  const limit = Math.max(1, Math.min(200, Number(rest[0]) || 30));
  for (const [key, t] of Object.entries(TABLES)) {
    const res = await db.execute({
      sql: `SELECT id, ${t.target} AS target, body, author_login, hidden, created_at
            FROM ${t.name}${t.where ? ` WHERE ${t.where}` : ""} ORDER BY created_at DESC LIMIT ?`,
      args: [limit],
    });
    console.log(`\n== ${key} (${t.name}) ==`);
    for (const row of res.rows) {
      const when = new Date(Number(row.created_at)).toISOString().slice(0, 16);
      const flag = Number(row.hidden) ? " [hidden]" : "";
      console.log(`${row.id}  ${when}  ${row.author_login ?? "anon"}  @${row.target}${flag}\n  ${row.body}`);
    }
  }
} else if (command === "hide" || command === "unhide") {
  const [table, id] = rest;
  const t = TABLES[table];
  if (!t || !id) usage();
  const hidden = command === "hide" ? 1 : 0;
  const res = await db.execute({
    sql: `UPDATE ${t.name} SET hidden = ? WHERE id = ?`,
    args: [hidden, id],
  });
  if (res.rowsAffected === 0) {
    console.error(`no comment ${id} in ${t.name}`);
    process.exit(1);
  }
  console.log(`${command} ok: ${t.name} ${id} -> hidden=${hidden}`);
} else {
  usage();
}
