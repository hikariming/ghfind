// Produce reviewable, repeatable SQL; this script never writes to a database.
// node --import tsx scripts/seed-talent.mts > /tmp/seed-talent.sql
// pnpm exec wrangler d1 execute ghfind --remote --env production --file /tmp/seed-talent.sql
import { readFileSync, existsSync } from "node:fs";
import type { Talent } from "../src/components/talent/data";

type EditorialTalent = {
  id: string; name: string; handle: string | null; role: string; location: string;
  direction: string; bio: string; skills: string[]; stars: number | null;
  contributions: number | null; source: string; project: string;
  project_description: string; note: string; available: number; color: string;
  projects: NonNullable<Talent["projects"]>; sources: NonNullable<Talent["sources"]>;
  collection_slug: string; status: "published"; sort_order: number;
  avatar_url?: string | null;
};
const rows: EditorialTalent[] = JSON.parse(readFileSync(
  new URL("./data/talent-editorial.json", import.meta.url), "utf8",
));
const ids = new Set<string>();
for (const row of rows) {
  const id = row.id.toLowerCase();
  if (ids.has(id)) throw new Error(`Duplicate developer: ${row.id}`);
  ids.add(id);
  if (!row.name || !row.bio || !row.sources.length) throw new Error(`Incomplete profile: ${row.id}`);
  if (row.avatar_url && new URL(row.avatar_url).protocol !== "https:") throw new Error(`Unsafe avatar URL: ${row.id}`);
  for (const entry of [...row.sources, ...row.projects]) {
    if (!entry.url) throw new Error(`Missing evidence URL: ${row.id}`);
    if (entry.url.startsWith("/collections/")) {
      const slug = entry.url.slice("/collections/".length);
      if (!/^[a-z0-9-]+$/.test(slug) || !existsSync(new URL(`../content/collections/${slug}/meta.json`, import.meta.url))) {
        throw new Error(`Unknown collection: ${entry.url}`);
      }
    } else if (new URL(entry.url).protocol !== "https:") {
      throw new Error(`Unsafe evidence URL: ${entry.url}`);
    }
  }
}
const q = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid numeric field");
    return String(value);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
};
const now = Date.now();
const statements = rows.map(({ skills, projects, sources, ...fields }) => {
  const record = {
    ...fields, skills_json: JSON.stringify(skills), projects_json: JSON.stringify(projects),
    sources_json: JSON.stringify(sources), created_at: now, updated_at: now,
  };
  const columns = Object.keys(record);
  return `INSERT INTO talent_profiles (${columns.join(", ")})
VALUES (${Object.values(record).map(q).join(", ")})
ON CONFLICT(id) DO UPDATE SET ${columns.filter(key => key !== "id" && key !== "created_at")
    .map(key => `${key} = excluded.${key}`).join(", ")};`;
});
console.log(statements.join("\n\n"));
