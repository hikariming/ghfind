// Add a single GitHub user to the talent directory (operator-recommended).
// Phase 1 (always): fetch public profile + collect + score, checkpoint to
//   scripts/talent-import/out/people/<login>.json (same format as talent-import).
// Phase 2 (when scripts/talent-import/out/personas/<login>.json exists): emit
//   scripts/talent-import/out/talent-add-<login>.sql with the talent_profiles
//   INSERT (content_i18n_json comes from the persona file).
//
// Usage:
//   GITHUB_TOKEN=ghp_xxx npx tsx scripts/talent-add-one.mts <login> [--refresh]
// Apply:
//   pnpm exec wrangler d1 execute ghfind --remote --env production --file scripts/talent-import/out/talent-add-<login>.sql
import "./_env.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collect } from "../src/lib/github";
import { score, spamBotScore, tierFor } from "../src/lib/score";

const login = process.argv[2];
if (!login || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(login)) {
  console.error("usage: npx tsx scripts/talent-add-one.mts <login> [--refresh]");
  process.exit(1);
}
const REFRESH = process.argv.includes("--refresh");
const key = login.toLowerCase();
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "talent-import", "out");
const PEOPLE_DIR = join(OUT_DIR, "people");
const PERSONAS_DIR = join(OUT_DIR, "personas");

const q = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid numeric field");
    return String(value);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
};

async function ghProfile(userLogin: string) {
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(userLogin)}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ghfind-talent-add-one",
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for /users/${userLogin}`);
  const u = (await res.json()) as {
    name: string | null; bio: string | null; location: string | null;
    blog: string | null; twitter_username: string | null; email: string | null;
  };
  const email = u.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email) && !u.email.endsWith("users.noreply.github.com")
    ? u.email : null;
  return { name: u.name, bio: u.bio, location: u.location, blog: u.blog, twitter: u.twitter_username, email };
}

// ---------------- phase 1: checkpoint ----------------
const ckptPath = join(PEOPLE_DIR, `${key}.json`);
let ckpt: {
  login: string; fetched_at: number;
  profile: { name: string | null; bio: string | null; location: string | null; blog: string | null; twitter: string | null; email: string | null };
  metrics: unknown; scoring: unknown; top_repo_languages: string[];
};
if (existsSync(ckptPath) && !REFRESH) {
  console.log(`[skip] reusing checkpoint ${ckptPath}`);
  ckpt = JSON.parse(readFileSync(ckptPath, "utf8"));
} else {
  console.log(`[scan] collecting ${login}…`);
  const [collected, profile] = [await collect(login), await ghProfile(login)];
  const scoring = score(collected.metrics);
  ckpt = {
    login: collected.metrics.username,
    fetched_at: Date.now(),
    profile,
    metrics: collected.metrics,
    scoring,
    top_repo_languages: (collected.top_repos ?? []).map((r) => r.language).filter((l): l is string => !!l),
  };
  writeFileSync(ckptPath, JSON.stringify(ckpt, null, 2));
  console.log(`[scan] checkpoint -> ${ckptPath}`);
}
const scoring = ckpt.scoring as { final_score: number; tier: string };
const metrics = ckpt.metrics as {
  name: string | null; bio: string | null; company: string | null; followers: number;
  total_stars: number; merged_pr_count: number; last_year_contributions: number;
  attributed_original_repos?: string[]; best_original_repo_quality_repo?: string | null;
  top_starred_original_repo_quality_repo?: string | null;
};
const { tier } = tierFor(scoring.final_score);
const bot = spamBotScore(metrics as never);
console.log(`[score] ${ckpt.login}: ${scoring.final_score} (${tier}), spamBotScore=${bot}, followers=${metrics.followers}, stars=${metrics.total_stars}, mergedPRs=${metrics.merged_pr_count}`);
if (scoring.final_score < 55) console.log("[score] WARNING: below the usual 55 gate — importing anyway (operator pick)");
if (bot >= 3) console.log("[score] WARNING: spamBotScore >= 3 — review before applying SQL");

// ---------------- phase 2: SQL when persona exists ----------------
const personaPath = join(PERSONAS_DIR, `${key}.json`);
if (!existsSync(personaPath)) {
  console.log(`[sql] no persona at ${personaPath} yet — write it, then re-run this script`);
  process.exit(0);
}
const persona = JSON.parse(readFileSync(personaPath, "utf8")) as {
  direction_zh: string; direction_en: string; role_zh: string; role_en: string; note_zh: string; note_en: string;
};
const skills = [...new Set(ckpt.top_repo_languages)].slice(0, 6);
const ownRepos = (metrics.attributed_original_repos ?? []).slice(0, 3);
const mainRepo = metrics.best_original_repo_quality_repo
  ?? metrics.top_starred_original_repo_quality_repo
  ?? ownRepos[0] ?? "";
const now = Date.now();
const record: Record<string, unknown> = {
  id: key,
  name: ckpt.profile.name ?? metrics.name ?? ckpt.login,
  handle: ckpt.login,
  role: persona.role_zh,
  location: ckpt.profile.location ?? "",
  direction: persona.direction_zh,
  bio: ckpt.profile.bio ?? metrics.bio ?? "",
  skills_json: JSON.stringify(skills),
  stars: metrics.total_stars,
  contributions: metrics.last_year_contributions,
  source: "GitHub + 人工推荐",
  project: mainRepo,
  project_description: "",
  note: persona.note_zh,
  available: 0,
  color: ["sage", "lavender", "peach", "blue", "rose", "sand"][[...key].reduce((a, c) => a + c.charCodeAt(0), 0) % 6],
  tags_json: null,
  projects_json: JSON.stringify(ownRepos.map((r) => ({
    name: r, url: `https://github.com/${r}`, description: "", relationship: "own", contribution: "",
  }))),
  sources_json: JSON.stringify([
    { title: "GitHub 主页", publisher: "GitHub", kind: "github", url: `https://github.com/${ckpt.login}`, description: "" },
    { title: "GHFind 评分报告", publisher: "GHFind", kind: "website", url: `https://ghfind.com/u/${ckpt.login}`, description: "确定性评分与维度明细" },
  ]),
  public_fields_json: ckpt.profile.email ? JSON.stringify({ email: ckpt.profile.email }) : null,
  collection_slug: null,
  content_i18n_json: JSON.stringify({ en: { role: persona.role_en, direction: persona.direction_en, note: persona.note_en } }),
  status: "published",
  sort_order: 150,
  created_at: now,
  updated_at: now,
};
const columns = Object.keys(record);
const sql = `INSERT INTO talent_profiles (${columns.join(", ")})
VALUES (${Object.values(record).map(q).join(", ")})
ON CONFLICT(id) DO UPDATE SET ${columns.filter((c) => c !== "id" && c !== "created_at").map((c) => `${c} = excluded.${c}`).join(", ")};
`;
const sqlPath = join(OUT_DIR, `talent-add-${key}.sql`);
writeFileSync(sqlPath, sql);
console.log(`[sql] wrote -> ${sqlPath}`);
console.log(`[sql] next: pnpm exec wrangler d1 execute ghfind --remote --env production --file scripts/talent-import/out/talent-add-${key}.sql`);
console.log("[sql] also re-run scripts/talent-backfill-scores.mts to publish the score for /u/" + key);
