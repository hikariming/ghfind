// Import top contributors of selected AI repos into the talent directory.
// Writes SQL + summary under scripts/talent-import/out/; never touches D1 itself.
//
// Usage:
//   GITHUB_TOKEN=ghp_xxx npx tsx scripts/talent-import.mts [--repo=owner/name ...] [--max=30] [--min-score=55] [--stale-days=30] [--pending] [--no-publish-scan] [--refresh]
//
// Apply the result with:
//   pnpm exec wrangler d1 execute ghfind --remote --env production --file scripts/talent-import/out/talent-import.sql
import "./_env.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { collect, GitHubRateLimitError } from "../src/lib/github";
import { score, spamBotScore, tierFor } from "../src/lib/score";
import { publishCompleteQuickScan, updateRoast } from "../src/lib/db";
import type { RawMetrics, ScanResult, Scoring, SubScoreKey, Tier } from "../src/lib/types";
import { buildCtx, buildRoastLine, buildRoastReport, buildTags } from "./roast-gen.mts";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const argValue = (name: string): string[] =>
  argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const numArg = (name: string, fallback: number): number => {
  const raw = argValue(name)[0];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const MAX_PER_REPO = numArg("max", 30);
const MIN_SCORE = numArg("min-score", 55);
const STALE_DAYS = numArg("stale-days", 30);
const PENDING = argv.includes("--pending");
const NO_PUBLISH_SCAN = argv.includes("--no-publish-scan");
const REFRESH = argv.includes("--refresh");

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(SCRIPTS_DIR, "talent-import", "out");
const PEOPLE_DIR = join(OUT_DIR, "people");
mkdirSync(PEOPLE_DIR, { recursive: true });

interface RepoConfig {
  repo: string; // "owner/name"
  direction: string;
}
const cliRepos = argValue("repo");
const repoConfigs: RepoConfig[] = cliRepos.length
  ? cliRepos.map((repo) => ({ repo, direction: "未分类" }))
  : (JSON.parse(
      readFileSync(join(SCRIPTS_DIR, "data", "talent-repos.json"), "utf8"),
    ) as RepoConfig[]);

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
if (!GITHUB_TOKEN) console.log("[fetch] warning: GITHUB_TOKEN is not set; GitHub API calls will be rate-limited or fail.");

const TURSO_URL = process.env.TURSO_DATABASE_URL ?? "";
const db = TURSO_URL
  ? createClient({ url: TURSO_URL, authToken: process.env.TURSO_AUTH_TOKEN })
  : null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// GitHub REST helpers
// ---------------------------------------------------------------------------
async function ghGet<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
      Accept: "application/vnd.github+json",
      "User-Agent": "ghfind-talent-import",
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return (await res.json()) as T;
}

// Same policy as platform/github-app/src/author-email.ts usableEmail():
// well-formed address, and never a *users.noreply.github.com relay address.
// Only the account's current public profile email is considered; commit
// metadata is never consulted.
function usableEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value) &&
    !/@(?:users\.)?noreply\.github\.com$/i.test(value)
  );
}

interface RepoMeta {
  full_name: string;
  description: string | null;
  stars: number;
  language: string | null;
}
interface Contributor {
  login: string;
  contributions: number;
}
interface ContributorsCheckpoint {
  fetched_at: number;
  meta: RepoMeta;
  humans: Contributor[];
}
interface ProfileInfo {
  name: string | null;
  bio: string | null;
  location: string | null;
  blog: string | null;
  twitter: string | null;
  email: string | null;
}
interface PersonCheckpoint {
  login: string;
  fetched_at: number;
  profile: ProfileInfo;
  metrics: RawMetrics;
  scoring: Scoring;
  /** Languages of the person's top repos, captured at scan time. */
  top_repo_languages?: string[];
}

async function fetchContributors(cfg: RepoConfig): Promise<ContributorsCheckpoint | null> {
  const [owner, repo] = cfg.repo.split("/");
  const ckptPath = join(OUT_DIR, `${owner}__${repo}.contributors.json`);
  if (!REFRESH && existsSync(ckptPath)) {
    console.log(`[fetch] ${cfg.repo}: reusing checkpoint ${ckptPath}`);
    return JSON.parse(readFileSync(ckptPath, "utf8")) as ContributorsCheckpoint;
  }
  try {
    const raw = await ghGet<{ description: string | null; stargazers_count: number; language: string | null }>(
      `/repos/${owner}/${repo}`,
    );
    const meta: RepoMeta = {
      full_name: cfg.repo,
      description: raw.description ?? null,
      stars: raw.stargazers_count ?? 0,
      language: raw.language ?? null,
    };
    const humans: Contributor[] = [];
    for (let page = 1; humans.length < MAX_PER_REPO; page++) {
      const batch = await ghGet<{ login?: string; type?: string; contributions?: number }[]>(
        `/repos/${owner}/${repo}/contributors?per_page=100&page=${page}`,
      );
      if (!batch.length) break;
      for (const c of batch) {
        if (humans.length >= MAX_PER_REPO) break;
        const login = c.login;
        if (!login) continue;
        if (c.type === "Bot" || login.toLowerCase().endsWith("[bot]")) continue;
        humans.push({ login, contributions: c.contributions ?? 0 });
      }
      if (batch.length < 100) break;
    }
    const ckpt: ContributorsCheckpoint = { fetched_at: Date.now(), meta, humans };
    writeFileSync(ckptPath, JSON.stringify(ckpt, null, 2));
    console.log(`[fetch] ${cfg.repo}: ${humans.length} human contributors (${meta.stars} stars)`);
    return ckpt;
  } catch (e) {
    console.log(`[fetch] ${cfg.repo}: FAILED (${e instanceof Error ? e.message : String(e)}), skipping repo`);
    return null;
  }
}

async function fetchProfile(login: string): Promise<ProfileInfo> {
  const fallback: ProfileInfo = { name: null, bio: null, location: null, blog: null, twitter: null, email: null };
  try {
    const u = await ghGet<{
      name: string | null; bio: string | null; location: string | null;
      blog: string | null; twitter_username: string | null; email: string | null;
    }>(`/users/${encodeURIComponent(login)}`);
    return {
      name: u.name ?? null,
      bio: u.bio ?? null,
      location: u.location ?? null,
      blog: u.blog ?? null,
      twitter: u.twitter_username ?? null,
      email: usableEmail(u.email) ? u.email : null,
    };
  } catch (e) {
    console.log(`[profile] ${login}: FAILED (${e instanceof Error ? e.message : String(e)}), using empty profile`);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// DB freshness (skip accounts scanned within --stale-days)
// ---------------------------------------------------------------------------
interface DbScoreRow {
  username: string;
  final_score: number;
  tier: string;
  sub_scores: string | null;
  scanned_at: number;
}
async function loadFreshDbScores(logins: string[]): Promise<Map<string, DbScoreRow>> {
  const map = new Map<string, DbScoreRow>();
  if (!db || !logins.length) return map;
  const staleAfter = Date.now() - STALE_DAYS * 86400_000;
  const placeholders = logins.map(() => "?").join(", ");
  const r = await db.execute({
    sql: `SELECT username, final_score, tier, sub_scores, scanned_at FROM scores WHERE username IN (${placeholders})`,
    args: logins.map((l) => l.toLowerCase()),
  });
  for (const row of r.rows as unknown as DbScoreRow[]) {
    if (Number(row.scanned_at) >= staleAfter) map.set(String(row.username).toLowerCase(), row);
  }
  return map;
}
async function loadSnapshotMetrics(username: string): Promise<RawMetrics | null> {
  if (!db) return null;
  try {
    const r = await db.execute({
      sql: `SELECT metrics FROM profile_snapshots WHERE username = ? ORDER BY scanned_at DESC LIMIT 1`,
      args: [username.toLowerCase()],
    });
    const row = r.rows[0] as unknown as { metrics: string | null } | undefined;
    if (!row?.metrics) return null;
    return JSON.parse(row.metrics) as RawMetrics;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scanning with transient-error backoff
// ---------------------------------------------------------------------------
const TRANSIENT = /invalid JSON|rate limit|ECONN|502|503|timeout/i;
const BACKOFFS = [15_000, 40_000, 90_000];
// GitHubRateLimitError carries an empty message, so match the class, not text.
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

async function publishScan(login: string, collected: Awaited<ReturnType<typeof collect>>, scoring: Scoring) {
  if (!db || NO_PUBLISH_SCAN) return;
  try {
    const scan: ScanResult = { ...collected, scoring };
    const scoreWrite = await publishCompleteQuickScan(scan);
    if (!scoreWrite) {
      console.log(`[scan] ${login}: publishCompleteQuickScan returned null, skipping roast`);
      return;
    }
    const orgs = collected.organizations ?? [];
    const ctx = buildCtx({
      username: collected.metrics.username,
      displayName: collected.metrics.name,
      m: collected.metrics,
      scoring,
      topRepos: collected.top_repos ?? [],
      impactRepos: collected.impact_repos ?? [],
      orgs,
      orgDisplay: orgs[0] ?? "",
    });
    const tags = buildTags(ctx);
    const roastLine = buildRoastLine(ctx);
    await updateRoast(collected.metrics.username, buildRoastReport(ctx, "zh"), "zh", scoreWrite, { tags, roastLine });
    await updateRoast(collected.metrics.username, buildRoastReport(ctx, "en"), "en", scoreWrite, { tags, roastLine });
  } catch (e) {
    console.log(`[scan] ${login}: publish/roast failed (${e instanceof Error ? e.message : String(e)}), continuing`);
  }
}

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------
const DIM_ZH: Record<SubScoreKey, string> = {
  account_maturity: "账号资历",
  original_project_quality: "原创项目质量",
  contribution_quality: "贡献质量",
  ecosystem_impact: "生态影响力",
  community_influence: "社区影响力",
  activity_authenticity: "活跃度真实性",
};
const COLORS = ["sage", "lavender", "peach", "blue", "rose", "sand"] as const;
function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
const q = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid numeric field");
    return String(value);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
};

interface PersonSource {
  repo: string;
  direction: string;
  description: string | null;
  language: string | null;
  stars: number;
  commits: number;
}
interface Candidate {
  login: string;
  sources: PersonSource[];
}

interface DroppedEntry {
  login: string;
  reason: string;
}
interface RepoSummary {
  repo: string;
  fetched: number;
  included: number;
  email_hits: number;
  dropped: DroppedEntry[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`[fetch] repos=${repoConfigs.length} max/repo=${MAX_PER_REPO} min-score=${MIN_SCORE} stale-days=${STALE_DAYS} pending=${PENDING} refresh=${REFRESH} turso=${db ? "on" : "off"}`);

  // A. Contributors per repo.
  const candidates = new Map<string, Candidate>(); // login lower-case key
  const repoCkpts = new Map<string, ContributorsCheckpoint>();
  for (const cfg of repoConfigs) {
    const ckpt = await fetchContributors(cfg);
    if (!ckpt) continue;
    repoCkpts.set(cfg.repo, ckpt);
    for (const h of ckpt.humans) {
      const key = h.login.toLowerCase();
      const existing = candidates.get(key);
      const source: PersonSource = {
        repo: cfg.repo,
        direction: cfg.direction,
        description: ckpt.meta.description,
        language: ckpt.meta.language,
        stars: ckpt.meta.stars,
        commits: h.contributions,
      };
      if (existing) {
        if (!existing.sources.some((s) => s.repo === cfg.repo)) existing.sources.push(source);
      } else {
        candidates.set(key, { login: h.login, sources: [source] });
      }
    }
  }
  const allLogins = [...candidates.keys()];
  console.log(`[fetch] ${allLogins.length} unique candidates across ${repoCkpts.size} repos`);

  // Editorial seed rows are curated by hand; never overwrite them with
  // auto-generated content. Skip those logins entirely.
  const editorialIds = new Set<string>(
    (JSON.parse(readFileSync(join(SCRIPTS_DIR, "data", "talent-editorial.json"), "utf8")) as { id: string }[])
      .map((r) => r.id.toLowerCase()),
  );
  let editorialSkips = 0;
  for (const key of allLogins) {
    if (editorialIds.has(key)) {
      console.log(`[skip] ${candidates.get(key)!.login}: already curated in talent-editorial.json`);
      candidates.delete(key);
      editorialSkips++;
    }
  }
  if (editorialSkips > 0) {
    allLogins.splice(0, allLogins.length, ...candidates.keys());
    console.log(`[fetch] ${editorialSkips} editorial-curated logins excluded, ${allLogins.length} remain`);
  }

  // C. Decide per-person data source: checkpoint reuse / fresh-in-DB / live scan.
  const freshDb = await loadFreshDbScores(allLogins);
  type Plan = { kind: "checkpoint" | "db" | "scan"; ckpt?: PersonCheckpoint };
  const plans = new Map<string, Plan>();
  for (const key of allLogins) {
    const ckptPath = join(PEOPLE_DIR, `${key}.json`);
    if (!REFRESH && existsSync(ckptPath)) {
      plans.set(key, { kind: "checkpoint", ckpt: JSON.parse(readFileSync(ckptPath, "utf8")) as PersonCheckpoint });
      continue;
    }
    if (freshDb.has(key)) {
      const metrics = await loadSnapshotMetrics(key);
      if (metrics) {
        const row = freshDb.get(key)!;
        const { tier, tier_label } = tierFor(Number(row.final_score));
        let subScores = score(metrics).sub_scores;
        try {
          if (row.sub_scores) subScores = JSON.parse(row.sub_scores) as Scoring["sub_scores"];
        } catch {}
        plans.set(key, {
          kind: "db",
          ckpt: {
            login: candidates.get(key)!.login,
            fetched_at: Number(row.scanned_at),
            profile: { name: null, bio: null, location: null, blog: null, twitter: null, email: null },
            metrics,
            scoring: {
              sub_scores: subScores,
              base_score: Number(row.final_score),
              red_flags: [],
              total_penalty: 0,
              final_score: Number(row.final_score),
              tier: (row.tier as Tier) || tier,
              tier_label,
            },
          },
        });
        continue;
      }
      // Fresh DB row but no snapshot metrics — must rescan.
      freshDb.delete(key);
    }
    plans.set(key, { kind: "scan" });
  }
  const scanTotal = [...plans.values()].filter((p) => p.kind === "scan").length;

  // B + C. Profile + scoring per person.
  const people = new Map<string, PersonCheckpoint>();
  const scanFailures: DroppedEntry[] = [];
  let scanIdx = 0;
  let consecutiveRateLimits = 0;
  for (const key of allLogins) {
    const plan = plans.get(key)!;
    const login = candidates.get(key)!.login;
    if (plan.kind === "checkpoint") {
      console.log(`[skip] ${login}: reusing people checkpoint`);
      people.set(key, plan.ckpt!);
      continue;
    }
    if (plan.kind === "db") {
      console.log(`[skip] ${login}: scanned within ${STALE_DAYS}d, reusing DB score + snapshot metrics`);
      const profile = await fetchProfile(login);
      const merged: PersonCheckpoint = { ...plan.ckpt!, login, profile };
      writeFileSync(join(PEOPLE_DIR, `${key}.json`), JSON.stringify(merged, null, 2));
      people.set(key, merged);
      continue;
    }
    scanIdx++;
    if (scanIdx > 1) await sleep(8000);
    console.log(`[scan ${scanIdx}/${scanTotal}] ${login}`);
    try {
      const collected = await collectWithRetry(login);
      const scoring = score(collected.metrics);
      await publishScan(login, collected, scoring);
      const profile = await fetchProfile(login);
      const ckpt: PersonCheckpoint = {
        login,
        fetched_at: Date.now(),
        profile,
        metrics: collected.metrics,
        scoring,
        top_repo_languages: (collected.top_repos ?? [])
          .map((r) => r.language)
          .filter((l): l is string => !!l),
      };
      writeFileSync(join(PEOPLE_DIR, `${key}.json`), JSON.stringify(ckpt, null, 2));
      people.set(key, ckpt);
      consecutiveRateLimits = 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[scan] ${login}: FAILED (${msg || (e as Error)?.name}), continuing`);
      scanFailures.push({ login, reason: `scan failed: ${msg || (e as Error)?.name}` });
      if (e instanceof GitHubRateLimitError) {
        consecutiveRateLimits++;
        if (consecutiveRateLimits >= 3) {
          console.log(`[scan] aborting: ${consecutiveRateLimits} consecutive GitHub rate-limit failures; re-run after the hourly window resets to resume from checkpoints`);
          break;
        }
      } else {
        consecutiveRateLimits = 0;
      }
    }
  }

  // D + E. Quality gate, then build rows (login lower-case dedup already done).
  interface BuiltRow {
    record: Record<string, unknown>;
    finalScore: number;
    email: string | null;
    sources: PersonSource[];
  }
  const built: BuiltRow[] = [];
  const droppedByLogin = new Map<string, string>();
  for (const [key, person] of people) {
    const cand = candidates.get(key)!;
    // Accounts skipped via DB freshness get their stored score/tier overlaid.
    const dbRow = freshDb.get(key);
    const scoring = dbRow
      ? { ...person.scoring, final_score: Number(dbRow.final_score), tier: (dbRow.tier as Tier) || person.scoring.tier }
      : person.scoring;
    if (scoring.final_score < MIN_SCORE) {
      droppedByLogin.set(key, `final_score ${scoring.final_score} < ${MIN_SCORE}`);
      continue;
    }
    const bot = spamBotScore(person.metrics);
    if (bot >= 3) {
      droppedByLogin.set(key, `spamBotScore ${bot} >= 3`);
      continue;
    }

    const m = person.metrics;
    const sources = cand.sources;
    const byCommits = [...sources].sort((a, b) => b.commits - a.commits)[0];
    const byStars = [...sources].sort((a, b) => b.stars - a.stars)[0];
    const maxCommits = byCommits.commits;

    const topLangs = person.top_repo_languages ?? [];
    const langCounts = new Map<string, number>();
    for (const l of topLangs) langCounts.set(l, (langCounts.get(l) ?? 0) + 1);
    const mainLang =
      [...langCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? byCommits.language ?? null;
    const role = `${mainLang ?? "开源"} 开发者`;

    const skills = [...new Set([...topLangs, ...sources.map((s) => s.language).filter((l): l is string => !!l)])].slice(0, 6);

    const topDims = (Object.entries(scoring.sub_scores) as [SubScoreKey, number][])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([k]) => DIM_ZH[k]);
    const repoList = sources.map((s) => s.repo).join("、");
    const note =
      `GHFind 评分 ${scoring.final_score}/100（${scoring.tier}）。${repoList} 贡献者，` +
      `在来源项目累计 ${maxCommits} commits，merged PR ${m.merged_pr_count} 个，` +
      `GitHub followers ${m.followers}。优势维度：${topDims.join("、")}。`;

    const bio =
      person.profile.bio ||
      m.bio ||
      `${byCommits.repo} 贡献者，GitHub followers ${m.followers}`;

    const email = person.profile.email;
    const record: Record<string, unknown> = {
      id: key,
      name: person.profile.name || m.name || cand.login,
      handle: cand.login,
      role,
      location: person.profile.location || "",
      direction: byStars.direction,
      bio,
      skills_json: JSON.stringify(skills),
      stars: m.total_stars,
      contributions: maxCommits,
      source: "GitHub 自动采集",
      project: byCommits.repo,
      project_description: byCommits.description || "",
      note,
      available: 0,
      color: COLORS[hashOf(key) % COLORS.length],
      tags_json: null,
      projects_json: JSON.stringify(
        sources.map((s) => ({
          name: s.repo,
          url: `https://github.com/${s.repo}`,
          description: s.description || "",
          relationship: "pr",
          contribution: `${s.commits} commits`,
        })),
      ),
      sources_json: JSON.stringify([
        {
          title: "GitHub 主页",
          publisher: "GitHub",
          kind: "github",
          url: `https://github.com/${cand.login}`,
          description: "",
        },
        {
          title: "GHFind 评分报告",
          publisher: "GHFind",
          kind: "website",
          url: `https://ghfind.com/u/${cand.login}`,
          description: "确定性评分与维度明细",
        },
      ]),
      public_fields_json: email ? JSON.stringify({ email }) : null,
      collection_slug: null,
      status: PENDING ? "pending" : "published",
      sort_order: 0, // assigned after sorting
      created_at: 0,
      updated_at: 0,
    };
    built.push({ record, finalScore: scoring.final_score, email, sources });
  }

  // sort_order by final_score desc, 100 + rank.
  built.sort((a, b) => b.finalScore - a.finalScore);
  const now = Date.now();
  built.forEach((row, i) => {
    row.record.sort_order = 100 + (i + 1);
    row.record.created_at = now;
    row.record.updated_at = now;
  });

  // F. SQL + summary.
  const COLUMNS = [
    "id", "name", "handle", "role", "location", "direction", "bio", "skills_json",
    "stars", "contributions", "source", "project", "project_description", "note",
    "available", "color", "tags_json", "projects_json", "sources_json",
    "public_fields_json", "collection_slug", "status", "sort_order", "created_at", "updated_at",
  ];
  const statements = built.map(({ record }) => {
    const cols = COLUMNS;
    return `INSERT INTO talent_profiles (${cols.join(", ")})
VALUES (${cols.map((c) => q(record[c])).join(", ")})
ON CONFLICT(id) DO UPDATE SET ${cols
      .filter((c) => c !== "id" && c !== "created_at")
      .map((c) => `${c} = excluded.${c}`)
      .join(", ")};`;
  });
  const sqlPath = join(OUT_DIR, "talent-import.sql");
  writeFileSync(sqlPath, statements.join("\n\n") + "\n");

  const includedKeys = new Set(built.map((r) => String(r.record.id)));
  const summaries: RepoSummary[] = repoConfigs.map((cfg) => {
    const ckpt = repoCkpts.get(cfg.repo);
    const humans = ckpt?.humans ?? [];
    const dropped: DroppedEntry[] = [];
    let included = 0;
    let emailHits = 0;
    for (const h of humans) {
      const key = h.login.toLowerCase();
      if (includedKeys.has(key)) {
        included++;
        if (people.get(key)?.profile.email) emailHits++;
      } else {
        const reason =
          droppedByLogin.get(key) ??
          scanFailures.find((f) => f.login.toLowerCase() === key)?.reason ??
          "not processed";
        dropped.push({ login: h.login, reason });
      }
    }
    return { repo: cfg.repo, fetched: humans.length, included, email_hits: emailHits, dropped };
  });
  const summary = {
    generated_at: new Date(now).toISOString(),
    args: { max: MAX_PER_REPO, min_score: MIN_SCORE, stale_days: STALE_DAYS, pending: PENDING, refresh: REFRESH, turso: !!db },
    repos: summaries,
    total_included: built.length,
    scan_failures: scanFailures,
  };
  const summaryPath = join(OUT_DIR, "summary.json");
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log(`[sql] wrote ${statements.length} rows -> ${sqlPath}`);
  console.log(`[sql] summary -> ${summaryPath}`);
  for (const s of summaries) {
    console.log(
      `[sql] ${s.repo}: fetched=${s.fetched} included=${s.included} dropped=${s.dropped.length} emails=${s.email_hits}`,
    );
  }
  console.log(`[sql] total included: ${built.length}`);
  console.log(
    `[sql] next: pnpm exec wrangler d1 execute ghfind --remote --env production --file scripts/talent-import/out/talent-import.sql`,
  );
}

main().catch((e) => {
  console.error(`[fatal] ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exitCode = 1;
});
