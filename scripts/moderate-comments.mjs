#!/usr/bin/env node
/**
 * Comment moderation: review recent UGC comments and hide/unhide them.
 * Runs SQL through `wrangler d1 execute` against the `ghfind` D1 database
 * (the same one the workers use — dev and prod share it, so hide carefully).
 *
 * Usage:
 *   node scripts/moderate-comments.mjs list [limit]          # recent comments, all tables
 *   node scripts/moderate-comments.mjs hide <table> <id>     # set hidden = 1
 *   node scripts/moderate-comments.mjs unhide <table> <id>   # set hidden = 0
 *
 * <table> is one of: profile | blog | collection
 * Behind a proxy, run with: NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:1082
 */
import { execFileSync } from "node:child_process";

const DB = "ghfind";
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

function run(sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

if (command === "list") {
  const limit = Math.max(1, Math.min(200, Number(rest[0]) || 30));
  for (const [key, t] of Object.entries(TABLES)) {
    const res = run(
      `SELECT id, ${t.target} AS target, body, author_login, hidden, created_at
       FROM ${t.name}${t.where ? ` WHERE ${t.where}` : ""} ORDER BY created_at DESC LIMIT ${limit}`,
    );
    const rows = res[0]?.results ?? [];
    console.log(`\n== ${key} (${t.name}) ==`);
    for (const row of rows) {
      const when = new Date(Number(row.created_at)).toISOString().slice(0, 16);
      const flag = Number(row.hidden) ? " [hidden]" : "";
      console.log(`${row.id}  ${when}  ${row.author_login ?? "anon"}  @${row.target}${flag}\n  ${row.body}`);
    }
  }
} else if (command === "hide" || command === "unhide") {
  const [table, id] = rest;
  const t = TABLES[table];
  if (!t || !id || !/^[0-9a-f-]+$/i.test(id)) usage();
  const hidden = command === "hide" ? 1 : 0;
  const res = run(`UPDATE ${t.name} SET hidden = ${hidden} WHERE id = '${id}'`);
  const changed = res[0]?.meta?.changes ?? 0;
  if (!changed) {
    console.error(`no comment ${id} in ${t.name}`);
    process.exit(1);
  }
  console.log(`${command} ok: ${t.name} ${id} -> hidden=${hidden}`);
} else {
  usage();
}
