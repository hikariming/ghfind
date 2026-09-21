#!/usr/bin/env node
/**
 * Generate UPDATE SQL that merges editorial English content overrides into
 * talent_profiles.content_i18n_json (merges $.en via json_set, keeping other keys).
 *
 * Usage:
 *   pnpm exec tsx scripts/talent-editorial-en-sql.mts > /tmp/editorial-en.sql
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INPUT = join(dirname(fileURLToPath(import.meta.url)), "data", "talent-editorial-en.json");
const entries = JSON.parse(readFileSync(INPUT, "utf8")) as Record<
  string,
  { role?: string; direction?: string; bio?: string; note?: string; project_description?: string }
>;

function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

const now = Date.now();
const statements: string[] = [];
for (const [id, en] of Object.entries(entries)) {
  statements.push(
    `UPDATE talent_profiles SET content_i18n_json = json_set(COALESCE(content_i18n_json, '{}'), '$.en', json(${sqlString(JSON.stringify(en))})), updated_at = ${now} WHERE id = ${sqlString(id)};`,
  );
}

console.log("-- editorial en overrides:", Object.keys(entries).length, "rows");
console.log(statements.join("\n"));
