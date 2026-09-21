#!/usr/bin/env node
/**
 * Merge per-key English bio translations (out/personas-bio/*.json) into
 * talent_profiles.content_i18n_json via json_set on individual $.en.<key> paths,
 * so existing en role/direction/note keys are preserved.
 *
 * Usage: pnpm exec tsx scripts/talent-bio-en-sql.mts > /tmp/bio-en.sql
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "talent-import", "out", "personas-bio");

const KEY_MAP: Record<string, string> = {
  bio_en: "bio",
  project_description_en: "project_description",
};

function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

const now = Date.now();
const statements: string[] = [];
let count = 0;

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()) {
  const id = file.replace(/\.json$/, "");
  const data = JSON.parse(readFileSync(join(DIR, file), "utf8")) as Record<string, string>;
  const sets: string[] = [];
  for (const [k, enKey] of Object.entries(KEY_MAP)) {
    const v = data[k];
    if (typeof v === "string" && v.length > 0) {
      sets.push(`'$.en.${enKey}', ${sqlString(v)}`);
    }
  }
  if (sets.length === 0) continue;
  count++;
  statements.push(
    `UPDATE talent_profiles SET content_i18n_json = json_set(COALESCE(content_i18n_json, '{}'), ${sets.join(", ")}), updated_at = ${now} WHERE id = ${sqlString(id)};`,
  );
}

console.log(`-- bio en overrides: ${count} rows`);
console.log(statements.join("\n"));
