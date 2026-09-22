// Enrich the official-tag batch import (scripts/talent-import-official.mts)
// with real scoring data — WITHOUT any LLM or roast-API calls:
//   1. Reuses people checkpoints, then fresh prod-D1 scores+snapshots
//      (exported by scripts/talent-enrich-dsh-export.mts), else live-scans
//      (collect + score, deterministic, ~8s pacing, checkpointed).
//   2. Emits talent_profiles UPDATE SQL: role/direction/skills/stars/
//      contributions/representative projects (with descriptions)/sources
//      (GitHub 主页 + GHFind 评分报告 + blog)/public email/deterministic note.
//      Only touches the listed ids; pinned/corner_tag/official_tags_json are
//      never overwritten.
// Afterwards run scripts/talent-backfill-scores.mts to publish the
// deterministic scores + template roasts to D1 (also no LLM).
//
// Usage:
//   npx tsx scripts/talent-enrich-dsh.mts [--file=scripts/data/dsh-external-members.txt] [--refresh]
// Apply:
//   pnpm exec wrangler d1 execute ghfind --remote --env production --file scripts/talent-import/out/talent-enrich-dsh.sql
import "./_env.mjs";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collect, GitHubRateLimitError } from "../src/lib/github";
import { score, spamBotScore, tierFor } from "../src/lib/score";
import type { RawMetrics, Scoring, Tier } from "../src/lib/types";

const args = new Set(process.argv.slice(2));
const argValue = (name: string): string | undefined =>
  process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const FILE = argValue("file") ?? "scripts/data/dsh-external-members.txt";
const REFRESH = args.has("--refresh");
const STALE_DAYS = 30;

if (!process.env.GITHUB_TOKEN?.trim()) {
  process.env.GITHUB_TOKEN = execSync("gh auth token", { encoding: "utf8" }).trim();
}

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(SCRIPTS_DIR, "talent-import", "out");
const PEOPLE_DIR = join(OUT_DIR, "people");
mkdirSync(PEOPLE_DIR, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid numeric field");
    return String(value);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ProfileInfo {
  name: string | null; bio: string | null; location: string | null;
  blog: string | null; twitter: string | null; email: string | null;
}
interface TopProject {
  name: string; description: string; stars: number; language: string | null;
}
interface PersonCheckpoint {
  login: string;
  fetched_at: number;
  profile: ProfileInfo;
  metrics: RawMetrics;
  scoring: Scoring;
  top_repo_languages?: string[];
  top_projects?: TopProject[];
}
interface DbScoreRow {
  username: string; final_score: number; tier: string;
  sub_scores: string | null; scanned_at: number;
}

const logins = [...new Set(
  readFileSync(FILE, "utf8").split("\n").map((l) => l.trim())
    .filter((l) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(l)),
)];
console.log(`[input] ${logins.length} logins from ${FILE}`);

// ---------------------------------------------------------------------------
// Prod D1 export (fresh scores + snapshot metrics), written by the export step
// ---------------------------------------------------------------------------
const dbScores = new Map<string, DbScoreRow>();
const dbMetrics = new Map<string, RawMetrics>();
const dbExportPath = join(OUT_DIR, "dsh-db-export.json");
if (existsSync(dbExportPath)) {
  const dump = JSON.parse(readFileSync(dbExportPath, "utf8")) as {
    scores: DbScoreRow[]; snapshots: { username: string; metrics: string; scanned_at: number }[];
  };
  const staleAfter = Date.now() - STALE_DAYS * 86400_000;
  const snapByUser = new Map(dump.snapshots.map((s) => [s.username, s]));
  for (const row of dump.scores) {
    if (row.scanned_at < staleAfter) continue;
    const snap = snapByUser.get(row.username);
    if (!snap?.metrics) continue;
    try {
      dbScores.set(row.username, row);
      dbMetrics.set(row.username, JSON.parse(snap.metrics) as RawMetrics);
    } catch {}
  }
  console.log(`[db] ${dbScores.size} logins have fresh (<= ${STALE_DAYS}d) prod scores + snapshots`);
} else {
  console.log(`[db] no export at ${dbExportPath} — every uncached login will be live-scanned`);
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------
const TRANSIENT = /invalid JSON|rate limit|ECONN|502|503|timeout/i;
const BACKOFFS = [15_000, 40_000, 90_000];
const isTransientScanError = (e: unknown): boolean =>
  e instanceof GitHubRateLimitError ||
  TRANSIENT.test(e instanceof Error ? e.message : String(e));

async function collectWithRetry(login: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await collect(login);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < BACKOFFS.length && isTransientScanError(e)) {
        console.log(`[scan] ${login}: transient error (${msg || (e as Error)?.name}); retrying in ${BACKOFFS[attempt]}ms`);
        await sleep(BACKOFFS[attempt]);
        continue;
      }
      throw e;
    }
  }
}

async function fetchProfile(login: string): Promise<ProfileInfo> {
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ghfind-talent-enrich",
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for /users/${login}`);
  const u = (await res.json()) as {
    name: string | null; bio: string | null; location: string | null;
    blog: string | null; twitter_username: string | null; email: string | null;
  };
  const email = u.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email) && !u.email.endsWith("users.noreply.github.com")
    ? u.email : null;
  const blog = u.blog?.trim()
    ? (/^https?:\/\//i.test(u.blog.trim()) ? u.blog.trim() : `https://${u.blog.trim()}`)
    : null;
  return { name: u.name, bio: u.bio, location: u.location, blog, twitter: u.twitter_username, email };
}

async function fetchTopProjects(batch: string[]): Promise<Map<string, TopProject[]>> {
  const fields = batch
    .map((login, i) => `u${i}: user(login: ${JSON.stringify(login)}) {
      repositories(first: 3, orderBy: {field: STARGAZERS, direction: DESC}, ownerAffiliations: [OWNER], isFork: false, privacy: PUBLIC) {
        nodes { nameWithOwner description stargazerCount primaryLanguage { name } }
      }
    }`)
    .join("\n");
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "ghfind-talent-enrich",
    },
    body: JSON.stringify({ query: `query { ${fields} }` }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}`);
  const json = (await res.json()) as {
    data?: Record<string, { repositories: { nodes: { nameWithOwner: string; description: string | null; stargazerCount: number; primaryLanguage: { name: string } | null }[] } } | null>;
  };
  const map = new Map<string, TopProject[]>();
  batch.forEach((login, i) => {
    const nodes = json.data?.[`u${i}`]?.repositories?.nodes ?? [];
    map.set(login.toLowerCase(), nodes.map((n) => ({
      name: n.nameWithOwner, description: n.description ?? "", stars: n.stargazerCount, language: n.primaryLanguage?.name ?? null,
    })));
  });
  return map;
}

// ---------------------------------------------------------------------------
// Phase 1: ensure a checkpoint per login (checkpoint > prod DB > live scan)
// ---------------------------------------------------------------------------
const people = new Map<string, PersonCheckpoint>();
const needScan: string[] = [];
for (const login of logins) {
  const key = login.toLowerCase();
  const ckptPath = join(PEOPLE_DIR, `${key}.json`);
  if (!REFRESH && existsSync(ckptPath)) {
    people.set(key, JSON.parse(readFileSync(ckptPath, "utf8")) as PersonCheckpoint);
    continue;
  }
  const dbRow = dbScores.get(key);
  const metrics = dbMetrics.get(key);
  if (dbRow && metrics) {
    const { tier, tier_label } = tierFor(Number(dbRow.final_score));
    let subScores = score(metrics).sub_scores;
    try {
      if (dbRow.sub_scores) subScores = JSON.parse(dbRow.sub_scores) as Scoring["sub_scores"];
    } catch {}
    const ckpt: PersonCheckpoint = {
      login,
      fetched_at: Number(dbRow.scanned_at),
      profile: { name: null, bio: null, location: null, blog: null, twitter: null, email: null },
      metrics,
      scoring: {
        sub_scores: subScores, base_score: Number(dbRow.final_score), red_flags: [],
        total_penalty: 0, final_score: Number(dbRow.final_score),
        tier: (dbRow.tier as Tier) || tier, tier_label,
      },
      top_repo_languages: [],
    };
    people.set(key, ckpt);
    continue;
  }
  needScan.push(login);
}
console.log(`[plan] checkpoints=${[...people.keys()].filter((k) => !dbScores.has(k) && existsSync(join(PEOPLE_DIR, `${k}.json`))).length} db-fresh=${dbScores.size} live-scan=${needScan.length}`);

let consecutiveRateLimits = 0;
for (let i = 0; i < needScan.length; i++) {
  const login = needScan[i];
  const key = login.toLowerCase();
  if (i > 0) await sleep(8000);
  console.log(`[scan ${i + 1}/${needScan.length}] ${login}`);
  try {
    const collected = await collectWithRetry(login);
    const scoring = score(collected.metrics);
    const profile = await fetchProfile(login);
    const topProjects: TopProject[] = (collected.top_repos ?? [])
      .filter((r) => (r.owner_login ?? "").toLowerCase() === key || r.attributed_original)
      .sort((a, b) => b.stars - a.stars)
      .slice(0, 3)
      .map((r) => ({
        name: r.name_with_owner ?? `${login}/${r.name}`,
        description: r.description ?? "", stars: r.stars, language: r.language,
      }));
    const ckpt: PersonCheckpoint = {
      login,
      fetched_at: Date.now(),
      profile,
      metrics: collected.metrics,
      scoring,
      top_repo_languages: (collected.top_repos ?? []).map((r) => r.language).filter((l): l is string => !!l),
      top_projects: topProjects,
    };
    writeFileSync(join(PEOPLE_DIR, `${key}.json`), JSON.stringify(ckpt, null, 2));
    people.set(key, ckpt);
    consecutiveRateLimits = 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[scan] ${login}: FAILED (${msg || (e as Error)?.name}), continuing`);
    if (e instanceof GitHubRateLimitError) {
      consecutiveRateLimits++;
      if (consecutiveRateLimits >= 3) {
        console.log(`[scan] aborting: 3 consecutive rate-limit failures; re-run later to resume from checkpoints`);
        break;
      }
    } else {
      consecutiveRateLimits = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 2: fill gaps — profiles (db-fresh rows) and top projects
// ---------------------------------------------------------------------------
const needProfile = [...people.values()].filter((p) => !p.profile.name && !p.profile.bio && !p.profile.email);
for (let i = 0; i < needProfile.length; i += 10) {
  await Promise.all(needProfile.slice(i, i + 10).map(async (p) => {
    try {
      p.profile = await fetchProfile(p.login);
    } catch (e) {
      console.log(`[profile] ${p.login}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }));
}
const needProjects = [...people.values()].filter((p) => !p.top_projects);
for (let i = 0; i < needProjects.length; i += 10) {
  const batch = needProjects.slice(i, i + 10);
  try {
    const map = await fetchTopProjects(batch.map((p) => p.login));
    for (const p of batch) p.top_projects = map.get(p.login.toLowerCase()) ?? [];
  } catch (e) {
    console.log(`[projects] batch failed: ${e instanceof Error ? e.message : String(e)}`);
    for (const p of batch) p.top_projects = [];
  }
}
// Persist enriched checkpoints so re-runs stay cheap.
for (const [key, p] of people) {
  writeFileSync(join(PEOPLE_DIR, `${key}.json`), JSON.stringify(p, null, 2));
}

// ---------------------------------------------------------------------------
// Phase 3: build enriched talent UPDATEs
// ---------------------------------------------------------------------------
const DIM_ZH: Record<string, string> = {
  account_maturity: "账号资历",
  original_project_quality: "原创项目质量",
  contribution_quality: "贡献质量",
  ecosystem_impact: "生态影响力",
  community_influence: "社区影响力",
  activity_authenticity: "活跃度真实性",
};

function classifyDirection(skills: string[], projects: TopProject[]): string {
  const haystack = projects.map((p) => `${p.name} ${p.description}`).join(" ").toLowerCase();
  if (/mcp|\bagent|multi-agent|workflow|工作流/.test(haystack)) return "Agent 与工作流";
  if (/vllm|tensorrt|cuda|推理引擎|训练|pytorch|tensorflow|\bjax\b|inference/.test(haystack)) return "模型与推理基础设施";
  if (/llm|gpt|claude|\brag\b|prompt|diffusion|transformer|大模型|chatbot|copilot|\bai\b/.test(haystack)) return "AI 应用开发";
  if (/爬虫|scraper|\betl\b|数据分析|检索|搜索引擎|elasticsearch|爬虫/.test(haystack)) return "数据与检索";
  const main = skills[0] ?? "";
  if (["TypeScript", "JavaScript", "Vue", "CSS", "HTML", "Svelte", "SCSS"].includes(main)) return "前端与体验";
  if (["Jupyter Notebook"].includes(main)) return "AI / 机器学习";
  if (["Go", "Rust", "Java", "C", "C++", "C#", "PHP", "Ruby", "Python", "Shell", "Lua", "Zig"].includes(main)) return "后端与基础设施";
  if (["Swift", "Kotlin", "Dart", "Objective-C"].includes(main)) return "全栈开发";
  return main ? "全栈开发" : "未分类";
}

interface Built { key: string; finalScore: number; set: Record<string, unknown>; }
const built: Built[] = [];
const skipped: string[] = [];
for (const login of logins) {
  const key = login.toLowerCase();
  const person = people.get(key);
  if (!person) { skipped.push(login); continue; }
  const m = person.metrics;
  const scoring = person.scoring;
  const bot = spamBotScore(m);
  const projects = person.top_projects ?? [];
  const skills = [...new Set([
    ...(person.top_repo_languages ?? []),
    ...projects.map((p) => p.language).filter((l): l is string => !!l),
  ])].slice(0, 6);
  const mainRepo = m.best_original_repo_quality_repo
    ?? m.top_starred_original_repo_quality_repo
    ?? m.attributed_original_repos?.[0]
    ?? projects[0]?.name
    ?? "";
  const mainDesc = projects.find((p) => p.name === mainRepo)?.description ?? "";
  const topDims = (Object.entries(scoring.sub_scores) as [string, number][])
    .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => DIM_ZH[k] ?? k);
  const note =
    `GHFind 评分 ${scoring.final_score.toFixed(1)}/100（${scoring.tier}）。` +
    `原创项目 ${m.nonempty_original_repo_count ?? m.original_repo_count} 个，累计 stars ${m.total_stars}，` +
    `merged PR ${m.merged_pr_count} 个，近一年贡献 ${m.last_year_contributions} 次，followers ${m.followers}。` +
    `优势维度：${topDims.join("、")}。` +
    (bot >= 3 ? `（spamBotScore=${bot}，待人工复核）` : "");
  const role = `${skills[0] ?? "开源"} 开发者`;
  const sources: Record<string, unknown>[] = [
    { title: "GitHub 主页", publisher: "GitHub", kind: "github", url: `https://github.com/${person.login}`, description: "" },
    { title: "GHFind 评分报告", publisher: "GHFind", kind: "website", url: `https://ghfind.com/u/${person.login}`, description: "确定性评分与维度明细" },
  ];
  if (person.profile.blog) {
    sources.push({ title: "个人网站", publisher: person.profile.blog.replace(/^https?:\/\//, "").split("/")[0], kind: "website", url: person.profile.blog, description: "" });
  }
  built.push({
    key,
    finalScore: scoring.final_score,
    set: {
      role,
      direction: classifyDirection(skills, projects),
      skills_json: JSON.stringify(skills),
      stars: m.total_stars,
      contributions: m.last_year_contributions,
      project: mainRepo,
      project_description: mainDesc,
      note,
      projects_json: JSON.stringify(projects.map((p) => ({
        name: p.name, url: `https://github.com/${p.name}`, description: p.description,
        relationship: "own", contribution: `${p.stars} stars`,
      }))),
      sources_json: JSON.stringify(sources),
      public_fields_json: person.profile.email ? JSON.stringify({ email: person.profile.email }) : null,
    },
  });
}

built.sort((a, b) => b.finalScore - a.finalScore);
const now = Date.now();
const statements = built.map((row, i) => {
  const assignments = [...Object.entries(row.set), ["sort_order", 500 + i + 1] as const, ["updated_at", now] as const]
    .map(([c, v]) => `${c} = ${q(v)}`).join(", ");
  return `UPDATE talent_profiles SET ${assignments} WHERE id = ${q(row.key)};`;
});

const sqlPath = join(OUT_DIR, "talent-enrich-dsh.sql");
writeFileSync(sqlPath, statements.join("\n") + "\n");
const dist = built.reduce<Record<string, number>>((acc, r) => {
  const bucket = r.finalScore >= 80 ? ">=80" : r.finalScore >= 60 ? "60-79" : r.finalScore >= 40 ? "40-59" : "<40";
  acc[bucket] = (acc[bucket] ?? 0) + 1;
  return acc;
}, {});
writeFileSync(join(OUT_DIR, "talent-enrich-dsh.summary.json"), JSON.stringify({
  total: logins.length, enriched: built.length, skipped, scoreDistribution: dist, generated_at: now,
}, null, 2));
console.log(`[sql] ${statements.length} updates -> ${sqlPath}`);
console.log(`[sql] score distribution: ${JSON.stringify(dist)}; skipped: ${skipped.length}${skipped.length ? ` (${skipped.slice(0, 10).join(", ")}…)` : ""}`);
console.log(`[sql] next: pnpm exec wrangler d1 execute ghfind --remote --env production --file scripts/talent-import/out/talent-enrich-dsh.sql`);
console.log(`[sql] then: npx tsx scripts/talent-backfill-scores.mts && apply out/backfill-scores.sql`);
