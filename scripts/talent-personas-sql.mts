// Merge LLM-written personas (out/personas/<login>.json) into talent_profiles:
// replaces the template role/direction/note columns and fills content_i18n_json
// with the English overlays. Emits SQL only; apply with:
//   pnpm exec wrangler d1 execute ghfind --remote --env production --file scripts/talent-import/out/talent-personas.sql
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "talent-import", "out");
const PERSONAS_DIR = join(OUT_DIR, "personas");

interface Persona {
  login: string;
  direction_key: string;
  direction_zh: string;
  direction_en: string;
  role_zh: string;
  role_en: string;
  note_zh: string;
  note_en: string;
}

const DIRECTION_KEYS = new Set([
  "ai-apps", "agents", "models-infra", "devtools",
  "data-retrieval", "frontend", "backend-infra", "fullstack",
]);

const q = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const files = readdirSync(PERSONAS_DIR).filter((f) => f.endsWith(".json")).sort();
const statements: string[] = [];
const skipped: { file: string; reason: string }[] = [];

for (const file of files) {
  const id = file.replace(/\.json$/, "");
  let persona: Persona;
  try {
    persona = JSON.parse(readFileSync(join(PERSONAS_DIR, file), "utf8")) as Persona;
  } catch {
    skipped.push({ file, reason: "invalid JSON" });
    continue;
  }
  const missing = (["direction_zh", "direction_en", "role_zh", "role_en", "note_zh", "note_en"] as const)
    .filter((key) => !persona[key]?.trim());
  if (missing.length || !DIRECTION_KEYS.has(persona.direction_key)) {
    skipped.push({ file, reason: missing.length ? `empty: ${missing.join(",")}` : `bad direction_key: ${persona.direction_key}` });
    continue;
  }
  // Merge en overlays per key so previously translated $.en.bio /
  // $.en.project_description survive (a wholesale replace would wipe them).
  statements.push(
    `UPDATE talent_profiles SET role = ${q(persona.role_zh)}, direction = ${q(persona.direction_zh)}, note = ${q(persona.note_zh)}, content_i18n_json = json_set(COALESCE(content_i18n_json, '{}'), '$.en.role', ${q(persona.role_en)}, '$.en.direction', ${q(persona.direction_en)}, '$.en.note', ${q(persona.note_en)}), updated_at = ${Date.now()} WHERE id = ${q(id)};`,
  );
}

writeFileSync(join(OUT_DIR, "talent-personas.sql"), statements.join("\n") + "\n");
console.log(`[sql] wrote ${statements.length} updates -> ${join(OUT_DIR, "talent-personas.sql")}`);
if (skipped.length) console.log(`[sql] skipped ${skipped.length}: ${skipped.map((s) => `${s.file}(${s.reason})`).join(", ")}`);
console.log("[sql] next: pnpm exec wrangler d1 execute ghfind --remote --env production --file scripts/talent-import/out/talent-personas.sql");
