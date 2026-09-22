// Import a list of GitHub logins into the talent directory with an official,
// operator-granted tag (migrations/0010 official_tags_json), e.g. the members
// of a GitHub org who are beta users.
//
// Unlike talent-import.mts this does NOT score anyone: rows carry only public
// profile basics (name/bio/location), so the import is cheap and idempotent.
// Existing talent rows (editorial or scored) are never overwritten — on
// conflict only the official tag is merged in.
//
// Usage:
//   GITHUB_TOKEN=ghp_xxx npx tsx scripts/talent-import-official.mts \
//     --file=scripts/data/dsh-external-members.txt --tag=dsh内测用户
//   (GITHUB_TOKEN falls back to `gh auth token` when unset)
// Apply:
//   pnpm exec wrangler d1 execute ghfind --remote --env production --file scripts/talent-import/out/talent-official-import.sql
import "./_env.mjs";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const eq = a.indexOf("=");
      return eq === -1 ? [a.slice(2), true] : [a.slice(2, eq), a.slice(eq + 1)];
    }),
);
const FILE = String(args.file ?? "");
const TAG = String(args.tag ?? "").trim();
const SORT_BASE = Number(args["sort-base"] ?? 500);
if (!FILE || !TAG) {
  console.error("usage: npx tsx scripts/talent-import-official.mts --file=<logins.txt> --tag=<官方标签> [--sort-base=500]");
  process.exit(1);
}

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "talent-import", "out");

const token = process.env.GITHUB_TOKEN?.trim()
  || execSync("gh auth token", { encoding: "utf8" }).trim();

const logins = [...new Set(
  readFileSync(FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(line)),
)];
console.log(`[input] ${logins.length} logins from ${FILE}`);

type Profile = { login: string; name: string | null; bio: string | null; location: string | null };

async function fetchBatch(batch: string[]): Promise<Profile[]> {
  const fields = batch
    .map((login, i) => `u${i}: user(login: ${JSON.stringify(login)}) { login name bio location }`)
    .join("\n");
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "ghfind-talent-official-import",
    },
    body: JSON.stringify({ query: `query { ${fields} }` }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}`);
  const json = (await res.json()) as { data?: Record<string, Profile | null>; errors?: unknown };
  if (json.errors) console.error("[warn] graphql errors:", JSON.stringify(json.errors).slice(0, 400));
  return batch.map((login, i) => json.data?.[`u${i}`] ?? { login, name: null, bio: null, location: null });
}

const profiles: Profile[] = [];
const BATCH = 50;
for (let i = 0; i < logins.length; i += BATCH) {
  const batch = logins.slice(i, i + BATCH);
  profiles.push(...await fetchBatch(batch));
  console.log(`[fetch] ${Math.min(i + BATCH, logins.length)}/${logins.length}`);
}

const AVATAR_COLORS = ["sage", "lavender", "peach", "blue", "rose", "sand"];
const q = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
};

const now = Date.now();
const tagJson = JSON.stringify([TAG]);
const statements = profiles.map((p, i) => {
  const id = p.login.toLowerCase();
  const name = (p.name ?? "").trim() || p.login;
  const color = AVATAR_COLORS[[...id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % AVATAR_COLORS.length];
  // On conflict (curated/scored row already exists) merge the tag only.
  return `INSERT INTO talent_profiles (id, name, handle, role, location, direction, bio, skills_json, stars, contributions, source, project, project_description, note, available, color, tags_json, official_tags_json, status, sort_order, created_at, updated_at)
VALUES (${q(id)}, ${q(name)}, ${q(p.login)}, '', ${q((p.location ?? "").trim())}, '未分类', ${q((p.bio ?? "").trim())}, '[]', NULL, NULL, 'GitHub 自动采集', '', '', '', 0, ${q(color)}, NULL, ${q(tagJson)}, 'published', ${SORT_BASE + i}, ${now}, ${now})
ON CONFLICT(id) DO UPDATE SET
  official_tags_json = CASE
    WHEN talent_profiles.official_tags_json IS NULL OR talent_profiles.official_tags_json = '' THEN excluded.official_tags_json
    WHEN EXISTS (SELECT 1 FROM json_each(talent_profiles.official_tags_json) WHERE json_each.value = ${q(TAG)}) THEN talent_profiles.official_tags_json
    ELSE json_insert(talent_profiles.official_tags_json, '$[#]', ${q(TAG)})
  END,
  updated_at = excluded.updated_at;`;
});

const sqlPath = join(OUT_DIR, "talent-official-import.sql");
writeFileSync(sqlPath, statements.join("\n") + "\n");
const summaryPath = join(OUT_DIR, "talent-official-import.summary.json");
writeFileSync(summaryPath, JSON.stringify({ tag: TAG, count: profiles.length, missing: profiles.filter((p) => p.name === null && p.bio === null).map((p) => p.login), generated_at: now }, null, 2));
console.log(`[sql] ${statements.length} upserts -> ${sqlPath}`);
console.log(`[sql] next: pnpm exec wrangler d1 execute ghfind --remote --env production --file scripts/talent-import/out/talent-official-import.sql`);
