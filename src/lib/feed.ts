import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createClient, type Client, type InStatement } from "@libsql/client/web";
import { d1AsLibsqlClient, getD1Binding, getFeedD1Binding } from "@/lib/d1-client";
import {
  normalizeGitHubRepository,
  type ProjectAnalysisArtifact,
  projectAnalysisArtifactSchema,
} from "@/lib/project-analysis-contract";

/**
 * Cloudflare-native Feed baseline.
 *
 * D1 owns Feed-only facts; project assessments remain owned by the existing
 * evaluation store.  There is deliberately no runtime DDL against D1: the
 * production schema is migration-owned. The small local schema below exists
 * solely for Turso/file-backed tests and development.
 */

export const FEED_ALGORITHM_VERSION = "cloudflare-tag-quality-v1";
export const FEED_TAXONOMY_VERSION = 1;
const DAY = 24 * 60 * 60 * 1000;
const CURSOR_TTL = 30 * 60 * 1000;
const FEED_NAMESPACES = ["domain", "use_case", "audience", "artifact", "stack", "stage"] as const;
const HARD_HIGH_RISK_CATEGORIES = new Set(["license", "security", "supply_chain", "privacy"]);

type FeedNamespace = (typeof FEED_NAMESPACES)[number];
type FeedEventType = "impression" | "detail_open" | "dwell" | "github_outbound" | "share";

export type FeedTag = {
  id: string;
  namespace: FeedNamespace;
  slug: string;
  labelZh: string;
  labelEn: string;
  description: string;
  taxonomyVersion: number;
};

export type FeedPreference = {
  tagId: string;
  value: -1 | 1;
  source: "explicit" | "graph" | "behavior";
  strength: number;
  taxonomyVersion: number;
};

export type FeedProject = {
  repoKey: string;
  ownerLogin: string;
  name: string;
  canonicalUrl: string;
  summary: string;
  language: string | null;
  topics: string[];
  projectType: string;
  lifecycle: string;
  productScore: number;
  confidence: number;
  verificationLevel: string;
  exposureBand: string;
  treasureEligible: boolean;
  classicEligible: boolean;
  analyzedAt: string;
  tags: FeedTag[];
};

export type FeedPage = {
  requestId: string;
  algorithmVersion: string;
  taxonomyVersion: number;
  items: Array<{ project: FeedProject; reasonCodes: string[]; impressionToken: string }>;
  nextCursor: string | null;
  degraded: string[];
};

export class FeedError extends Error {
  constructor(
    readonly code:
      | "feed_disabled"
      | "feed_unavailable"
      | "feed_cursor_expired"
      | "invalid_cursor"
      | "invalid_pagination"
      | "invalid_impression_token"
      | "taxonomy_version_changed"
      | "invalid_preferences"
      | "invalid_state_patch"
      | "project_not_found"
      | "invalid_events"
      | "invalid_body"
      | "rate_limited"
      | "stale_tag_proposal",
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "FeedError";
  }
}

type Viewer = { githubId: number; login: string; image: string | null };
type DbRow = Record<string, unknown>;
type Candidate = {
  project: FeedProject;
  tagIds: string[];
  score: number;
  tagAffinity: number;
  savedSimilarity: number;
  source: string;
  exploration: boolean;
  propensity: number;
};
type CursorPayload = {
  v: 1;
  u: number;
  pv: number;
  r: string;
  s: string;
  o: number;
  e: number;
  c: string;
};
type ImpressionPayload = { v: 1; u: number; p: string; r: string; k: number; e: number };

const DEFAULT_TAGS: ReadonlyArray<Omit<FeedTag, "taxonomyVersion">> = [
  ["artifact", "micro-tool", "微型工具", "Micro tool", "A focused utility for one task."],
  ["artifact", "sdk-library", "SDK / 库", "SDK / library", "A reusable developer library or SDK."],
  ["artifact", "web-app", "Web 应用", "Web app", "A browser-delivered application."],
  ["artifact", "desktop-app", "桌面应用", "Desktop app", "A native desktop application."],
  ["artifact", "framework-platform", "框架 / 平台", "Framework / platform", "A framework, runtime or platform."],
  ["artifact", "database-infra", "数据 / 基础设施", "Data / infrastructure", "A database or infrastructure component."],
  ["artifact", "template-scaffold", "模板 / 脚手架", "Template / scaffold", "A starter, template or scaffolding tool."],
  ["artifact", "enterprise-system", "企业系统", "Enterprise system", "A system intended for organizational workflows."],
  ["stage", "active-evolution", "活跃演进", "Active evolution", "Actively evolving project."],
  ["stage", "stable-maintenance", "稳定维护", "Stable maintenance", "Stable project in maintenance."],
  ["stage", "feature-complete", "功能完成", "Feature complete", "Project primarily receiving fixes."],
  ["stage", "experimental", "实验阶段", "Experimental", "Early experimental project."],
  ["stage", "abandoned", "已停更", "Abandoned", "No longer actively maintained."],
].map(([namespace, slug, labelZh, labelEn, description]) => ({
  id: `${namespace}:${slug}`,
  namespace: namespace as FeedNamespace,
  slug,
  labelZh,
  labelEn,
  description,
}));

let client: Client | null = null;
let coreClient: Client | null = null;
let schemaReady: Promise<void> | null = null;

function database(): Client {
  if (client) return client;
  const d1 = getFeedD1Binding();
  if (d1) {
    client = d1AsLibsqlClient(d1);
    // Schema and seed taxonomy are both migration-owned on D1. Runtime Feed
    // requests must never perform DDL or bootstrap writes against production.
    schemaReady = Promise.resolve();
    return client;
  }
  if (getD1Binding()) {
    throw new FeedError("feed_unavailable", 503, "Dedicated Feed D1 binding is not configured.");
  }
  const url = process.env.TURSO_DATABASE_URL?.trim();
  if (!url) throw new FeedError("feed_unavailable", 503, "Feed storage is not configured.");
  client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined });
  return client;
}

/** Core D1 is a read-only source for assessment/repository projection. */
function sourceDatabase(): Client {
  const d1 = getD1Binding();
  if (!d1) return database();
  if (!coreClient) coreClient = d1AsLibsqlClient(d1);
  return coreClient;
}

const LOCAL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS feed_taxonomy_versions (version INTEGER PRIMARY KEY, status TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS feed_tag_definitions (id TEXT PRIMARY KEY, namespace TEXT NOT NULL, slug TEXT NOT NULL, label_zh TEXT NOT NULL, label_en TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, taxonomy_version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(namespace, slug))`,
  `CREATE TABLE IF NOT EXISTS feed_tag_aliases (namespace TEXT NOT NULL, slug TEXT NOT NULL, canonical_tag_id TEXT NOT NULL, taxonomy_version INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(namespace, slug))`,
  `CREATE TABLE IF NOT EXISTS feed_projects (repo_key TEXT PRIMARY KEY, analysis_id TEXT NOT NULL, owner_login TEXT NOT NULL, name TEXT NOT NULL, canonical_url TEXT NOT NULL, summary TEXT NOT NULL, language TEXT, topics_json TEXT NOT NULL DEFAULT '[]', project_type TEXT NOT NULL, lifecycle TEXT NOT NULL, product_score REAL NOT NULL, confidence REAL NOT NULL, verification_level TEXT NOT NULL, exposure_band TEXT NOT NULL, treasure_eligible INTEGER NOT NULL DEFAULT 0, classic_eligible INTEGER NOT NULL DEFAULT 0, analyzed_at INTEGER NOT NULL, risks_json TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0, source_hash TEXT NOT NULL, projected_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS feed_project_moderation (repo_key TEXT PRIMARY KEY, removed INTEGER NOT NULL DEFAULT 0, allow_high_risk INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS feed_project_tags (repo_key TEXT NOT NULL, tag_id TEXT NOT NULL, source TEXT NOT NULL, weight REAL NOT NULL, confidence REAL NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]', analysis_id TEXT NOT NULL, taxonomy_version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(repo_key, tag_id))`,
  `CREATE TABLE IF NOT EXISTS feed_tag_proposals (id TEXT PRIMARY KEY, repo_key TEXT NOT NULL, analysis_id TEXT NOT NULL, namespace TEXT NOT NULL, slug TEXT NOT NULL, label_zh TEXT NOT NULL, label_en TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, reviewed_by TEXT, review_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(repo_key, analysis_id, namespace, slug))`,
  `CREATE TABLE IF NOT EXISTS feed_users (github_id INTEGER PRIMARY KEY, login TEXT NOT NULL, avatar_url TEXT, profile_version INTEGER NOT NULL DEFAULT 1, taxonomy_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS feed_user_tag_preferences (github_id INTEGER NOT NULL, tag_id TEXT NOT NULL, value INTEGER NOT NULL, source TEXT NOT NULL, strength REAL NOT NULL, taxonomy_version INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(github_id, tag_id, source))`,
  `CREATE TABLE IF NOT EXISTS feed_user_project_states (github_id INTEGER NOT NULL, repo_key TEXT NOT NULL, saved INTEGER NOT NULL DEFAULT 0, not_interested INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(github_id, repo_key))`,
  `CREATE TABLE IF NOT EXISTS feed_events (id TEXT PRIMARY KEY, github_id INTEGER NOT NULL, repo_key TEXT NOT NULL, type TEXT NOT NULL, occurred_at INTEGER NOT NULL, duration_ms INTEGER, request_id TEXT NOT NULL, rank INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS feed_served_items (request_id TEXT NOT NULL, github_id INTEGER NOT NULL, repo_key TEXT NOT NULL, rank INTEGER NOT NULL, algorithm_version TEXT NOT NULL, source TEXT NOT NULL, propensity REAL NOT NULL, exploration INTEGER NOT NULL DEFAULT 0, served_at INTEGER NOT NULL, PRIMARY KEY(request_id, repo_key))`,
  `CREATE TABLE IF NOT EXISTS feed_rate_windows (github_id INTEGER NOT NULL, bucket TEXT NOT NULL, window_started INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(github_id, bucket, window_started))`,
  `CREATE INDEX IF NOT EXISTS idx_feed_projects_candidate_order ON feed_projects(published, product_score DESC, confidence DESC, analyzed_at DESC, repo_key)`,
  `CREATE INDEX IF NOT EXISTS idx_feed_project_tags_tag ON feed_project_tags(tag_id, repo_key)`,
  `CREATE INDEX IF NOT EXISTS idx_feed_events_user_repo_type_time ON feed_events(github_id, repo_key, type, occurred_at DESC)`,
];

async function ensureSchema(db: Client): Promise<void> {
  if (!schemaReady) {
    schemaReady = db.batch(LOCAL_SCHEMA, "write").then(async () => {
      await seedDefaultTaxonomy(db);
    });
  }
  await schemaReady;
}

async function seedDefaultTaxonomy(db: Client): Promise<void> {
  const now = Date.now();
  const statements: InStatement[] = [
    { sql: "INSERT OR IGNORE INTO feed_taxonomy_versions(version, status, created_at) VALUES (?, 'active', ?)", args: [FEED_TAXONOMY_VERSION, now] },
    ...DEFAULT_TAGS.map((tag) => ({
      sql: `INSERT OR IGNORE INTO feed_tag_definitions
            (id, namespace, slug, label_zh, label_en, description, status, taxonomy_version, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'canonical', ?, ?, ?)`,
      args: [tag.id, tag.namespace, tag.slug, tag.labelZh, tag.labelEn, tag.description, FEED_TAXONOMY_VERSION, now, now],
    })),
  ];
  await db.batch(statements, "write");
}

async function ready(): Promise<Client> {
  assertFeedEnabled();
  const db = database();
  await ensureSchema(db);
  return db;
}

function assertFeedEnabled(): void {
  const mode = process.env.FEED_MODE?.trim().toLowerCase();
  if (mode === "off") throw new FeedError("feed_disabled", 503, "Feed is disabled by configuration.");
  if (mode && !["baseline", "baseline_gorse_shadow", "gorse_canary"].includes(mode)) {
    throw new FeedError("feed_disabled", 503, "Feed configuration is invalid.");
  }
}

function rowString(row: DbRow, key: string): string {
  return typeof row[key] === "string" ? row[key] : "";
}

function rowNumber(row: DbRow, key: string): number {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function isNamespace(value: unknown): value is FeedNamespace {
  return typeof value === "string" && (FEED_NAMESPACES as readonly string[]).includes(value);
}

function asTag(row: DbRow): FeedTag {
  const namespace = rowString(row, "namespace");
  if (!isNamespace(namespace)) throw new FeedError("feed_unavailable", 503, "Feed taxonomy contains an invalid namespace.");
  return {
    id: rowString(row, "id"),
    namespace,
    slug: rowString(row, "slug"),
    labelZh: rowString(row, "label_zh"),
    labelEn: rowString(row, "label_en"),
    description: rowString(row, "description"),
    taxonomyVersion: rowNumber(row, "taxonomy_version"),
  };
}

function sourceHash(analysis: ProjectAnalysisArtifact): string {
  const descriptor = JSON.stringify({
    analysisId: analysis.analysis_id,
    repo: analysis.repository,
    project: analysis.project,
    scores: analysis.scores.product_score,
    confidence: analysis.confidence,
    verification: analysis.verification_level,
    exposure: analysis.exposure,
    risks: analysis.risks,
  });
  return createHash("sha256").update(descriptor).digest("hex");
}

export function isFeedPublishable(analysis: ProjectAnalysisArtifact): boolean {
  if (analysis.verification_level === "metadata_only") return false;
  return !analysis.risks.some(
    (risk) =>
      risk.severity === "critical" ||
      (risk.severity === "high" && HARD_HIGH_RISK_CATEGORIES.has(risk.category)),
  );
}

async function canonicalTagId(db: Client, namespace: FeedNamespace, slug: string): Promise<string | null> {
  const direct = await db.execute({
    sql: "SELECT id FROM feed_tag_definitions WHERE namespace = ? AND slug = ? AND status = 'canonical' LIMIT 1",
    args: [namespace, slug],
  });
  if (direct.rows[0]) return rowString(direct.rows[0] as DbRow, "id") || null;
  const alias = await db.execute({
    sql: "SELECT canonical_tag_id FROM feed_tag_aliases WHERE namespace = ? AND slug = ? LIMIT 1",
    args: [namespace, slug],
  });
  return alias.rows[0] ? rowString(alias.rows[0] as DbRow, "canonical_tag_id") || null : null;
}

/** Project-analysis finalization invokes this best-effort projection after its own durable commit. */
export async function syncFeedProjectProjection(
  analysis: ProjectAnalysisArtifact,
  analysisId = analysis.analysis_id,
): Promise<void> {
  const db = await ready();
  const sourceDb = sourceDatabase();
  const normalized = normalizeGitHubRepository(analysis.repository.repo_key);
  const repoKey = normalized.repoKey.toLowerCase();
  const [ownerLogin, name] = repoKey.split("/", 2);
  if (!ownerLogin || !name) throw new FeedError("feed_unavailable", 503, "Invalid repository key in project assessment.");
  const now = Date.now();
  let repoRow: DbRow | undefined;
  try {
    const repo = await sourceDb.execute({ sql: "SELECT language, topics FROM repos WHERE repo_key = ? LIMIT 1", args: [repoKey] });
    repoRow = repo.rows[0] as DbRow | undefined;
  } catch (error) {
    // The standalone Turso test/dev schema intentionally does not claim
    // ownership of the core repository graph. D1 always has `repos` from
    // migration 0001, so a production query failure must still surface.
    if (getD1Binding()) throw error;
  }
  const language = repoRow ? rowString(repoRow, "language") || null : null;
  const topics = repoRow ? parseStringArray(repoRow.topics) : [];
  const publishable = isFeedPublishable(analysis) ? 1 : 0;

  await db.batch(
    [
      {
        sql: `INSERT INTO feed_projects
              (repo_key, analysis_id, owner_login, name, canonical_url, summary, language, topics_json,
               project_type, lifecycle, product_score, confidence, verification_level, exposure_band,
               treasure_eligible, classic_eligible, analyzed_at, risks_json, published, source_hash, projected_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)
              ON CONFLICT(repo_key) DO UPDATE SET
                analysis_id = excluded.analysis_id, owner_login = excluded.owner_login, name = excluded.name,
                canonical_url = excluded.canonical_url, summary = excluded.summary, language = excluded.language,
                topics_json = excluded.topics_json, project_type = excluded.project_type, lifecycle = excluded.lifecycle,
                product_score = excluded.product_score, confidence = excluded.confidence,
                verification_level = excluded.verification_level, exposure_band = excluded.exposure_band,
                analyzed_at = excluded.analyzed_at, risks_json = excluded.risks_json, published = excluded.published,
                source_hash = excluded.source_hash, projected_at = excluded.projected_at`,
        args: [
          repoKey, analysisId, ownerLogin, name, analysis.repository.canonical_url, analysis.project.summary,
          language, JSON.stringify(topics), analysis.project.project_type, analysis.project.lifecycle,
          analysis.scores.product_score, analysis.confidence, analysis.verification_level, analysis.exposure.band,
          Date.parse(analysis.analyzed_at), JSON.stringify(analysis.risks), publishable, sourceHash(analysis), now,
        ],
      },
      { sql: "DELETE FROM feed_project_tags WHERE repo_key = ? AND source IN ('derived', 'assessment')", args: [repoKey] },
      {
        sql: `INSERT INTO feed_project_tags
              (repo_key, tag_id, source, weight, confidence, evidence_json, analysis_id, taxonomy_version, created_at, updated_at)
              VALUES (?, ?, 'derived', ?, 1, '[]', ?, ?, ?, ?)
              ON CONFLICT(repo_key, tag_id) DO UPDATE SET analysis_id = excluded.analysis_id, updated_at = excluded.updated_at`,
        args: [repoKey, `artifact:${analysis.project.project_type.replace(/_/g, "-")}`, 0.7, analysisId, FEED_TAXONOMY_VERSION, now, now],
      },
      {
        sql: `INSERT INTO feed_project_tags
              (repo_key, tag_id, source, weight, confidence, evidence_json, analysis_id, taxonomy_version, created_at, updated_at)
              VALUES (?, ?, 'derived', ?, 1, '[]', ?, ?, ?, ?)
              ON CONFLICT(repo_key, tag_id) DO UPDATE SET analysis_id = excluded.analysis_id, updated_at = excluded.updated_at`,
        args: [repoKey, `stage:${analysis.project.lifecycle.replace(/_/g, "-")}`, 0.45, analysisId, FEED_TAXONOMY_VERSION, now, now],
      },
    ],
    "write",
  );

  for (const candidate of analysis.project.product_tags) {
    // v1/v2 assessments carry evidence-backed product characteristics but no
    // governed namespace. Put those into a review-only intake bucket instead
    // of silently discarding them or granting them use_case recall. An admin
    // can still map a legacy proposal to a canonical tag in any namespace.
    const namespace = "namespace" in candidate && isNamespace(candidate.namespace)
      ? candidate.namespace
      : "use_case";
    const tagId = await canonicalTagId(db, namespace, candidate.slug);
    if (tagId) {
      await db.execute({
        sql: `INSERT INTO feed_project_tags
              (repo_key, tag_id, source, weight, confidence, evidence_json, analysis_id, taxonomy_version, created_at, updated_at)
              VALUES (?, ?, 'assessment', ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(repo_key, tag_id) DO UPDATE SET source = excluded.source, weight = excluded.weight,
                confidence = excluded.confidence, evidence_json = excluded.evidence_json, analysis_id = excluded.analysis_id,
                taxonomy_version = excluded.taxonomy_version, updated_at = excluded.updated_at`,
        args: [repoKey, tagId, 0.9, Math.min(1, analysis.confidence / 100), JSON.stringify(candidate.evidence_ids), analysisId, FEED_TAXONOMY_VERSION, now, now],
      });
      continue;
    }
    const proposalId = `${repoKey}:${analysisId}:${namespace}:${candidate.slug}`;
    await db.execute({
      sql: `INSERT INTO feed_tag_proposals
            (id, repo_key, analysis_id, namespace, slug, label_zh, label_en, evidence_json, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)
            ON CONFLICT(repo_key, analysis_id, namespace, slug) DO UPDATE SET
              label_zh = excluded.label_zh, label_en = excluded.label_en, evidence_json = excluded.evidence_json,
              updated_at = excluded.updated_at`,
      args: [proposalId, repoKey, analysisId, namespace, candidate.slug, candidate.labels.zh, candidate.labels.en, JSON.stringify(candidate.evidence_ids), now, now],
    });
  }
}

export async function reconcileFeedCatalog(
  limit = 100,
  cursor?: { updatedAt: number; repoKey: string },
): Promise<{ processed: number; skipped: number; nextCursor: { updatedAt: number; repoKey: string } | null }> {
  await ready();
  const sourceDb = sourceDatabase();
  const bounded = Math.max(1, Math.min(250, Math.floor(limit)));
  const after = cursor ?? { updatedAt: 0, repoKey: "" };
  const rows = await sourceDb.execute({
    sql: `SELECT pa.repo_key, pa.updated_at, pr.id, pr.analysis_json
          FROM project_assessments pa
          JOIN project_analysis_runs pr ON pr.id = pa.latest_analysis_id AND pr.status = 'completed'
          WHERE pa.updated_at > ? OR (pa.updated_at = ? AND pa.repo_key > ?)
          ORDER BY pa.updated_at ASC, pa.repo_key ASC LIMIT ?`,
    args: [after.updatedAt, after.updatedAt, after.repoKey, bounded],
  });
  let processed = 0;
  let skipped = 0;
  let last: { updatedAt: number; repoKey: string } | null = null;
  for (const raw of rows.rows) {
    const row = raw as DbRow;
    last = { updatedAt: rowNumber(row, "updated_at"), repoKey: rowString(row, "repo_key") };
    try {
      const analysis = projectAnalysisArtifactSchema.parse(JSON.parse(rowString(row, "analysis_json")));
      await syncFeedProjectProjection(analysis, rowString(row, "id"));
      processed += 1;
    } catch {
      skipped += 1;
    }
  }
  return { processed, skipped, nextCursor: rows.rows.length === bounded ? last : null };
}

async function ensureUser(db: Client, viewer: Viewer): Promise<{ profileVersion: number }> {
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO feed_users(github_id, login, avatar_url, profile_version, taxonomy_version, created_at, updated_at)
          VALUES (?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, avatar_url = excluded.avatar_url, updated_at = excluded.updated_at`,
    args: [viewer.githubId, viewer.login, viewer.image, FEED_TAXONOMY_VERSION, now, now],
  });
  const result = await db.execute({ sql: "SELECT profile_version FROM feed_users WHERE github_id = ?", args: [viewer.githubId] });
  return { profileVersion: rowNumber((result.rows[0] ?? {}) as DbRow, "profile_version") || 1 };
}

export async function listFeedTags(): Promise<{ taxonomyVersion: number; tags: FeedTag[] }> {
  const db = await ready();
  const rows = await db.execute({
    sql: "SELECT id, namespace, slug, label_zh, label_en, description, taxonomy_version FROM feed_tag_definitions WHERE status = 'canonical' AND taxonomy_version = ? ORDER BY namespace, slug",
    args: [FEED_TAXONOMY_VERSION],
  });
  return { taxonomyVersion: FEED_TAXONOMY_VERSION, tags: rows.rows.map((row) => asTag(row as DbRow)) };
}

export async function getFeedPreferences(viewer: Viewer): Promise<{
  taxonomyVersion: number;
  profileVersion: number;
  preferences: FeedPreference[];
  weakProfile: { positiveTags: number; negativeTags: number; weakSignals: number };
}> {
  const db = await ready();
  const user = await ensureUser(db, viewer);
  const rows = await db.execute({
    sql: `SELECT tag_id, value, source, strength, taxonomy_version
          FROM feed_user_tag_preferences WHERE github_id = ? ORDER BY source, tag_id`,
    args: [viewer.githubId],
  });
  const preferences = rows.rows.map((raw) => {
    const row = raw as DbRow;
    return {
      tagId: rowString(row, "tag_id"),
      value: (rowNumber(row, "value") === -1 ? -1 : 1) as -1 | 1,
      source: rowString(row, "source") as FeedPreference["source"],
      strength: rowNumber(row, "strength"),
      taxonomyVersion: rowNumber(row, "taxonomy_version"),
    };
  });
  return {
    taxonomyVersion: FEED_TAXONOMY_VERSION,
    profileVersion: user.profileVersion,
    preferences,
    weakProfile: {
      positiveTags: preferences.filter((preference) => preference.value === 1).length,
      negativeTags: preferences.filter((preference) => preference.value === -1).length,
      weakSignals: preferences.filter((preference) => preference.source !== "explicit").length,
    },
  };
}

export async function replaceFeedPreferences(
  viewer: Viewer,
  input: { taxonomyVersion: number; preferences: Array<{ tagId: string; value: number }> },
): Promise<Awaited<ReturnType<typeof getFeedPreferences>>> {
  if (!Number.isInteger(input.taxonomyVersion) || input.taxonomyVersion !== FEED_TAXONOMY_VERSION) {
    throw new FeedError("taxonomy_version_changed", 409, "The Feed taxonomy changed; refetch tags before saving preferences.");
  }
  if (!Array.isArray(input.preferences) || input.preferences.length > 30) {
    throw new FeedError("invalid_preferences", 400, "At most 30 explicit preferences are allowed.");
  }
  const unique = new Set<string>();
  for (const preference of input.preferences) {
    if (!preference || typeof preference.tagId !== "string" || ![1, -1].includes(preference.value) || unique.has(preference.tagId)) {
      throw new FeedError("invalid_preferences", 400, "Preferences must contain unique canonical tags with value +1 or -1.");
    }
    unique.add(preference.tagId);
  }
  const db = await ready();
  await ensureUser(db, viewer);
  if (unique.size > 0) {
    const values = [...unique];
    const valid = await db.execute({
      sql: `SELECT id FROM feed_tag_definitions WHERE status = 'canonical' AND taxonomy_version = ? AND id IN (${values.map(() => "?").join(",")})`,
      args: [FEED_TAXONOMY_VERSION, ...values],
    });
    if (valid.rows.length !== values.length) throw new FeedError("invalid_preferences", 400, "Only current canonical tags may be preferences.");
  }
  const now = Date.now();
  await db.batch(
    [
      { sql: "DELETE FROM feed_user_tag_preferences WHERE github_id = ? AND source = 'explicit'", args: [viewer.githubId] },
      ...input.preferences.map((preference) => ({
        sql: `INSERT INTO feed_user_tag_preferences(github_id, tag_id, value, source, strength, taxonomy_version, updated_at)
              VALUES (?, ?, ?, 'explicit', 1, ?, ?)`,
        args: [viewer.githubId, preference.tagId, preference.value, FEED_TAXONOMY_VERSION, now],
      })),
      { sql: "UPDATE feed_users SET profile_version = profile_version + 1, updated_at = ? WHERE github_id = ?", args: [now, viewer.githubId] },
    ],
    "write",
  );
  return getFeedPreferences(viewer);
}

async function consumeRateLimit(db: Client, githubId: number, bucket: string, maximum: number): Promise<void> {
  const now = Date.now();
  const window = Math.floor(now / 60_000) * 60_000;
  const results = await db.batch(
    [
      { sql: "DELETE FROM feed_rate_windows WHERE github_id = ? AND bucket = ? AND window_started < ?", args: [githubId, bucket, window - 120_000] },
      {
        sql: `INSERT INTO feed_rate_windows(github_id, bucket, window_started, count) VALUES (?, ?, ?, 1)
              ON CONFLICT(github_id, bucket, window_started) DO UPDATE SET count = count + 1 WHERE count < ?`,
        args: [githubId, bucket, window, maximum],
      },
    ],
    "write",
  );
  if ((results[1]?.rowsAffected ?? 0) !== 1) {
    throw new FeedError("rate_limited", 429, "Feed request rate limit exceeded.", Math.max(1, Math.ceil((window + 60_000 - now) / 1000)));
  }
}

function clamp(value: number, low = 0, high = 1): number {
  return Math.max(low, Math.min(high, value));
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const left = new Set(a);
  const right = new Set(b);
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap += 1;
  return overlap / (left.size + right.size - overlap);
}

function freshness(analyzedAt: string): number {
  const time = Date.parse(analyzedAt);
  if (!Number.isFinite(time)) return 0;
  return Math.exp(-Math.max(0, Date.now() - time) / (180 * DAY));
}

function discoveryBoost(exposureBand: string): number {
  if (exposureBand === "low") return 1;
  if (exposureBand === "emerging") return 0.7;
  if (exposureBand === "unknown") return 0.35;
  return 0;
}

function pseudoRandom(seed: string): () => number {
  // The request id is visible in the response. Key the deterministic sequence
  // so an observer cannot predict which long-tail candidate will be explored.
  let state = Number.parseInt(createHmac("sha256", signingSecret()).update(seed).digest("hex").slice(0, 8), 16) || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function orderedMmr(candidates: Candidate[]): Candidate[] {
  const remaining = [...candidates].sort((a, b) => b.score - a.score || a.project.repoKey.localeCompare(b.project.repoKey));
  const selected: Candidate[] = [];
  const ownerCounts = new Map<string, number>();
  while (remaining.length > 0) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    const positionInPage = selected.length % 20;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      const ownerCount = positionInPage === 0 ? 0 : ownerCounts.get(candidate.project.ownerLogin) ?? 0;
      if (ownerCount >= 2) continue;
      const diversityPenalty = selected.length === 0 ? 0 : Math.max(...selected.slice(-20).map((item) => jaccard(candidate.tagIds, item.tagIds)));
      const score = 0.78 * candidate.score - 0.22 * diversityPenalty;
      if (score > bestScore || (score === bestScore && candidate.project.repoKey < remaining[bestIndex]?.project.repoKey)) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) bestIndex = 0; // catalogue exhaustion is preferable to returning an empty page.
    const [picked] = remaining.splice(bestIndex, 1);
    if (!picked) break;
    if (positionInPage === 0) ownerCounts.clear();
    ownerCounts.set(picked.project.ownerLogin, (ownerCounts.get(picked.project.ownerLogin) ?? 0) + 1);
    selected.push(picked);
  }
  return selected;
}

function applyExploration(candidates: Candidate[], seed: string): Candidate[] {
  const ordered = candidates.map((candidate) => ({ ...candidate, exploration: false, propensity: 0.9 }));
  const random = pseudoRandom(seed);
  let usedInPage = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    if (index % 20 === 0) usedInPage = 0;
    if (usedInPage >= 2 || random() >= 0.1) continue;
    const end = Math.min(ordered.length, index + 20);
    const pool = ordered.slice(index, end);
    const max = Math.max(...pool.map((candidate) => candidate.score));
    const weights = pool.map((candidate) => Math.exp((candidate.score - max) / 0.12));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let target = random() * total;
    let chosen = 0;
    for (let offset = 0; offset < weights.length; offset += 1) {
      target -= weights[offset]!;
      if (target <= 0) {
        chosen = offset;
        break;
      }
    }
    const [explored] = ordered.splice(index + chosen, 1);
    if (!explored) continue;
    const conditional = 0.1 * (weights[chosen] ?? 0) / total;
    ordered.splice(index, 0, { ...explored, exploration: true, propensity: conditional });
    usedInPage += 1;
  }
  return ordered;
}

function signingSecret(): string {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) throw new FeedError("feed_unavailable", 503, "Feed signing is not configured.");
  return secret;
}

function encodeSigned(kind: "cursor" | "impression", value: CursorPayload | ImpressionPayload): string {
  const body = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signature = createHmac("sha256", signingSecret()).update(`ghfind:feed:${kind}:${body}`).digest("base64url");
  return `${body}.${signature}`;
}

function decodeSigned<T>(kind: "cursor" | "impression", raw: string): T | null {
  const [body, signature, extra] = raw.split(".");
  if (!body || !signature || extra) return null;
  const expected = createHmac("sha256", signingSecret()).update(`ghfind:feed:${kind}:${body}`).digest("base64url");
  const actualBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

async function loadCandidates(db: Client, viewer: Viewer, since: number): Promise<Candidate[]> {
  const rows = await db.execute({
    sql: `SELECT p.* FROM feed_projects p
          LEFT JOIN feed_project_moderation m ON m.repo_key = p.repo_key
          LEFT JOIN feed_user_project_states s ON s.repo_key = p.repo_key AND s.github_id = ?
          WHERE p.published = 1 AND COALESCE(m.removed, 0) = 0 AND COALESCE(s.not_interested, 0) = 0
            AND NOT EXISTS (
              SELECT 1 FROM feed_events e WHERE e.github_id = ? AND e.repo_key = p.repo_key
                AND e.type = 'impression' AND e.occurred_at >= ?
            )
          ORDER BY p.product_score DESC, p.confidence DESC, p.analyzed_at DESC, p.repo_key ASC LIMIT 240`,
    args: [viewer.githubId, viewer.githubId, since],
  });
  if (rows.rows.length === 0) return [];
  const projectRows = rows.rows as DbRow[];
  const repoKeys = projectRows.map((row) => rowString(row, "repo_key"));
  const placeholders = repoKeys.map(() => "?").join(",");
  const [tagRows, preferenceRows, savedTagRows] = await Promise.all([
    db.execute({ sql: `SELECT repo_key, tag_id FROM feed_project_tags WHERE repo_key IN (${placeholders})`, args: repoKeys }),
    db.execute({ sql: "SELECT tag_id, value, strength FROM feed_user_tag_preferences WHERE github_id = ?", args: [viewer.githubId] }),
    db.execute({
      sql: `SELECT pt.tag_id FROM feed_user_project_states state
            JOIN feed_project_tags pt ON pt.repo_key = state.repo_key
            WHERE state.github_id = ? AND state.saved = 1`,
      args: [viewer.githubId],
    }),
  ]);
  const tags = new Map<string, string[]>();
  for (const raw of tagRows.rows) {
    const row = raw as DbRow;
    const repoKey = rowString(row, "repo_key");
    tags.set(repoKey, [...(tags.get(repoKey) ?? []), rowString(row, "tag_id")]);
  }
  const preferences = new Map<string, { value: number; strength: number }>();
  for (const raw of preferenceRows.rows) {
    const row = raw as DbRow;
    preferences.set(rowString(row, "tag_id"), { value: rowNumber(row, "value"), strength: rowNumber(row, "strength") });
  }
  const savedTags = [...new Set(savedTagRows.rows.map((raw) => rowString(raw as DbRow, "tag_id")))];
  return projectRows.map((row) => {
    const repoKey = rowString(row, "repo_key");
    const tagIds = tags.get(repoKey) ?? [];
    let affinitySum = 0;
    let affinityWeight = 0;
    for (const tag of tagIds) {
      const preference = preferences.get(tag);
      if (!preference) continue;
      affinitySum += preference.value * preference.strength;
      affinityWeight += preference.strength;
    }
    const tagAffinity = affinityWeight > 0 ? clamp((affinitySum / affinityWeight + 1) / 2) : 0.5;
    const savedSimilarity = jaccard(tagIds, savedTags);
    const project: FeedProject = {
      repoKey,
      ownerLogin: rowString(row, "owner_login"),
      name: rowString(row, "name"),
      canonicalUrl: rowString(row, "canonical_url"),
      summary: rowString(row, "summary"),
      language: rowString(row, "language") || null,
      topics: parseStringArray(row.topics_json),
      projectType: rowString(row, "project_type"),
      lifecycle: rowString(row, "lifecycle"),
      productScore: rowNumber(row, "product_score"),
      confidence: rowNumber(row, "confidence"),
      verificationLevel: rowString(row, "verification_level"),
      exposureBand: rowString(row, "exposure_band"),
      treasureEligible: rowNumber(row, "treasure_eligible") === 1,
      classicEligible: rowNumber(row, "classic_eligible") === 1,
      analyzedAt: new Date(rowNumber(row, "analyzed_at")).toISOString(),
      tags: [],
    };
    // Embeddings are intentionally absent from this first Cloudflare-native
    // release. Re-normalize the declared baseline weights instead of treating
    // semantic similarity as a zero-value feature.
    const affinity = Math.max(tagAffinity, savedSimilarity > 0 ? 0.5 + savedSimilarity / 2 : 0);
    const score = (
      0.38 * affinity +
      0.14 * clamp(project.productScore / 100) +
      0.06 * clamp(project.confidence / 100) +
      0.06 * freshness(project.analyzedAt) +
      0.06 * discoveryBoost(project.exposureBand)
    ) / 0.7;
    return { project, tagIds, score: clamp(score), tagAffinity: affinity, savedSimilarity, source: "tag_quality", exploration: false, propensity: 0.9 };
  });
}

async function hydrateTags(db: Client, candidates: Candidate[]): Promise<void> {
  const ids = [...new Set(candidates.flatMap((candidate) => candidate.tagIds))];
  if (ids.length === 0) return;
  const rows = await db.execute({
    sql: `SELECT id, namespace, slug, label_zh, label_en, description, taxonomy_version
          FROM feed_tag_definitions WHERE id IN (${ids.map(() => "?").join(",")}) AND status = 'canonical'`,
    args: ids,
  });
  const tags = new Map(rows.rows.map((row) => {
    const tag = asTag(row as DbRow);
    return [tag.id, tag];
  }));
  for (const candidate of candidates) candidate.project.tags = candidate.tagIds.flatMap((id) => tags.get(id) ? [tags.get(id)!] : []);
}

function catalogueFingerprint(candidates: Candidate[]): string {
  // Scores contain a freshness component, so they are intentionally excluded:
  // a page must not expire merely because several seconds elapsed. Profile
  // mutations have their own monotonic cursor guard.
  return createHash("sha256").update(candidates.map((item) => `${item.project.repoKey}:${item.project.analyzedAt}`).join("|"), "utf8").digest("base64url");
}

function reasonCodes(candidate: Candidate): string[] {
  const codes: string[] = [];
  if (candidate.tagAffinity > 0.5) codes.push("matches_tags");
  if (candidate.savedSimilarity > 0) codes.push("similar_to_saved");
  if (candidate.project.productScore >= 80) codes.push("high_product_value");
  if (Date.now() - Date.parse(candidate.project.analyzedAt) <= 30 * DAY) codes.push("newly_evaluated");
  if (["low", "emerging"].includes(candidate.project.exposureBand)) codes.push("long_tail_discovery");
  return codes.length ? codes : ["catalog_discovery"];
}

export async function getFeedPage(
  viewer: Viewer,
  input: { limit: number; cursor?: string | null },
): Promise<FeedPage> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
    throw new FeedError("invalid_pagination", 400, "limit must be an integer from 1 to 50.");
  }
  const db = await ready();
  await consumeRateLimit(db, viewer.githubId, "feed", 60);
  const user = await ensureUser(db, viewer);
  let cursor: CursorPayload | null = null;
  if (input.cursor) {
    cursor = decodeSigned<CursorPayload>("cursor", input.cursor);
    if (!cursor || cursor.v !== 1 || cursor.u !== viewer.githubId || cursor.o < 0 || !Number.isInteger(cursor.o)) {
      throw new FeedError("invalid_cursor", 400, "Feed cursor is invalid.");
    }
    if (cursor.e <= Date.now() || cursor.pv !== user.profileVersion) {
      throw new FeedError("feed_cursor_expired", 410, "Feed cursor expired; start a new stream.");
    }
  }
  const requestId = cursor?.r ?? randomUUID();
  const seed = cursor?.s ?? `${viewer.githubId}:${requestId}:${FEED_ALGORITHM_VERSION}`;
  let candidates = await loadCandidates(db, viewer, Date.now() - 30 * DAY);
  if (candidates.length < input.limit) {
    const relaxed = await loadCandidates(db, viewer, Date.now() - 7 * DAY);
    const seen = new Set(candidates.map((candidate) => candidate.project.repoKey));
    candidates = [...candidates, ...relaxed.filter((candidate) => !seen.has(candidate.project.repoKey))].slice(0, 240);
  }
  const ranked = applyExploration(orderedMmr(candidates), seed);
  await hydrateTags(db, ranked);
  const fingerprint = catalogueFingerprint(ranked);
  if (cursor && cursor.c !== fingerprint) {
    throw new FeedError("feed_cursor_expired", 410, "Feed catalogue changed; start a new stream.");
  }
  const offset = cursor?.o ?? 0;
  const page = ranked.slice(offset, offset + input.limit);
  const now = Date.now();
  await db.batch(page.map((candidate, index) => ({
    sql: `INSERT OR IGNORE INTO feed_served_items
          (request_id, github_id, repo_key, rank, algorithm_version, source, propensity, exploration, served_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [requestId, viewer.githubId, candidate.project.repoKey, offset + index + 1, FEED_ALGORITHM_VERSION, candidate.source, candidate.propensity, candidate.exploration ? 1 : 0, now],
  })), "write");
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < ranked.length
    ? encodeSigned("cursor", { v: 1, u: viewer.githubId, pv: user.profileVersion, r: requestId, s: seed, o: nextOffset, e: now + CURSOR_TTL, c: fingerprint })
    : null;
  return {
    requestId,
    algorithmVersion: FEED_ALGORITHM_VERSION,
    taxonomyVersion: FEED_TAXONOMY_VERSION,
    items: page.map((candidate, index) => ({
      project: candidate.project,
      reasonCodes: reasonCodes(candidate),
      impressionToken: encodeSigned("impression", { v: 1, u: viewer.githubId, p: candidate.project.repoKey, r: requestId, k: offset + index + 1, e: now + CURSOR_TTL }),
    })),
    nextCursor,
    degraded: [],
  };
}

function verifyImpressionToken(viewer: Viewer, repoKey: string, raw: string): ImpressionPayload {
  const token = decodeSigned<ImpressionPayload>("impression", raw);
  if (!token || token.v !== 1 || token.u !== viewer.githubId || token.p !== repoKey || token.e <= Date.now()) {
    throw new FeedError("invalid_impression_token", 400, "Impression token is invalid, expired, or belongs to another user.");
  }
  return token;
}

export async function updateFeedProjectState(
  viewer: Viewer,
  rawRepo: string,
  input: { saved?: unknown; notInterested?: unknown; impressionToken?: unknown },
): Promise<{ repoKey: string; saved: boolean; notInterested: boolean }> {
  const normalized = normalizeGitHubRepository(rawRepo).repoKey.toLowerCase();
  const hasSaved = typeof input.saved === "boolean";
  const hasNotInterested = typeof input.notInterested === "boolean";
  if (hasSaved === hasNotInterested) throw new FeedError("invalid_state_patch", 400, "Exactly one of saved or notInterested is required.");
  if (typeof input.impressionToken !== "string") throw new FeedError("invalid_impression_token", 400, "A valid impression token is required.");
  verifyImpressionToken(viewer, normalized, input.impressionToken);
  const db = await ready();
  await consumeRateLimit(db, viewer.githubId, "state", 20);
  await ensureUser(db, viewer);
  const project = await db.execute({
    sql: `SELECT p.repo_key, COALESCE(s.saved, 0) AS saved, COALESCE(s.not_interested, 0) AS not_interested
          FROM feed_projects p LEFT JOIN feed_user_project_states s
            ON s.repo_key = p.repo_key AND s.github_id = ?
          WHERE p.repo_key = ? LIMIT 1`,
    args: [viewer.githubId, normalized],
  });
  const current = project.rows[0] as DbRow | undefined;
  if (!current) throw new FeedError("project_not_found", 404, "Project is not present in the Feed catalogue.");
  // A false patch removes only the requested state. Setting either state true
  // clears its mutually-exclusive counterpart; this avoids turning "unsave"
  // into an accidental negative preference.
  const saved = hasSaved
    ? input.saved === true
    : input.notInterested === true ? false : rowNumber(current, "saved") === 1;
  const notInterested = hasNotInterested
    ? input.notInterested === true
    : input.saved === true ? false : rowNumber(current, "not_interested") === 1;
  if (saved === (rowNumber(current, "saved") === 1) && notInterested === (rowNumber(current, "not_interested") === 1)) {
    return { repoKey: normalized, saved, notInterested };
  }
  const now = Date.now();
  const statements: InStatement[] = [
    {
      sql: `INSERT INTO feed_user_project_states(github_id, repo_key, saved, not_interested, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(github_id, repo_key) DO UPDATE SET saved = excluded.saved, not_interested = excluded.not_interested, updated_at = excluded.updated_at`,
      args: [viewer.githubId, normalized, saved ? 1 : 0, notInterested ? 1 : 0, now],
    },
  ];
  statements.push({ sql: "UPDATE feed_users SET profile_version = profile_version + 1, updated_at = ? WHERE github_id = ?", args: [now, viewer.githubId] });
  await db.batch(statements, "write");
  return { repoKey: normalized, saved, notInterested };
}

function parseEventTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= Date.now() + 5 * 60_000 && time >= Date.now() - 190 * DAY ? time : null;
}

export async function appendFeedEvents(
  viewer: Viewer,
  inputs: unknown,
): Promise<{ accepted: number; duplicate: number }> {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 50) {
    throw new FeedError("invalid_events", 400, "events must contain 1 to 50 entries.");
  }
  const db = await ready();
  await consumeRateLimit(db, viewer.githubId, "events", 120);
  await ensureUser(db, viewer);
  const statements: InStatement[] = [];
  for (const raw of inputs) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new FeedError("invalid_events", 400, "Event payload is invalid.");
    const event = raw as Record<string, unknown>;
    if (typeof event.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.id)) {
      throw new FeedError("invalid_events", 400, "Every Feed event requires a UUID id.");
    }
    if (!(["impression", "detail_open", "dwell", "github_outbound", "share"] as string[]).includes(event.type as string)) {
      throw new FeedError("invalid_events", 400, "Feed event type is invalid.");
    }
    if (typeof event.repoKey !== "string" || typeof event.impressionToken !== "string") throw new FeedError("invalid_events", 400, "Event repository and impression token are required.");
    const repoKey = normalizeGitHubRepository(event.repoKey).repoKey.toLowerCase();
    const token = verifyImpressionToken(viewer, repoKey, event.impressionToken);
    const occurredAt = parseEventTime(event.occurredAt);
    if (occurredAt === null) throw new FeedError("invalid_events", 400, "Event time is invalid.");
    const durationMs = event.durationMs === undefined ? null : Number(event.durationMs);
    if (durationMs !== null && (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 1_800_000)) {
      throw new FeedError("invalid_events", 400, "Event duration is invalid.");
    }
    statements.push({
      sql: `INSERT OR IGNORE INTO feed_events(id, github_id, repo_key, type, occurred_at, duration_ms, request_id, rank, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [event.id, viewer.githubId, repoKey, event.type as FeedEventType, occurredAt, durationMs, token.r, token.k, Date.now()],
    });
  }
  const results = await db.batch(statements, "write");
  const accepted = results.reduce((total, result) => total + (result.rowsAffected ?? 0), 0);
  return { accepted, duplicate: inputs.length - accepted };
}

export async function deleteFeedProfile(viewer: Viewer): Promise<{ deletionId: string; status: "completed" }> {
  // Deletion remains available while the serving kill-switch is off.
  const db = database();
  await ensureSchema(db);
  await db.batch([
    { sql: "DELETE FROM feed_events WHERE github_id = ?", args: [viewer.githubId] },
    { sql: "DELETE FROM feed_served_items WHERE github_id = ?", args: [viewer.githubId] },
    { sql: "DELETE FROM feed_user_project_states WHERE github_id = ?", args: [viewer.githubId] },
    { sql: "DELETE FROM feed_user_tag_preferences WHERE github_id = ?", args: [viewer.githubId] },
    { sql: "DELETE FROM feed_rate_windows WHERE github_id = ?", args: [viewer.githubId] },
    { sql: "DELETE FROM feed_users WHERE github_id = ?", args: [viewer.githubId] },
  ], "write");
  return { deletionId: randomUUID(), status: "completed" };
}

export async function reviewFeedTagProposal(input: {
  proposalId: string;
  action: "create" | "map" | "reject";
  reviewer: string;
  reason: string;
  canonicalTagId?: string;
}): Promise<{ proposalId: string; status: "accepted" | "rejected"; canonicalTagId?: string }> {
  const db = await ready();
  const found = await db.execute({ sql: "SELECT * FROM feed_tag_proposals WHERE id = ? LIMIT 1", args: [input.proposalId] });
  const row = found.rows[0] as DbRow | undefined;
  if (!row || rowString(row, "status") !== "proposed") throw new FeedError("stale_tag_proposal", 409, "Tag proposal is not pending review.");
  const namespace = rowString(row, "namespace");
  if (!isNamespace(namespace)) throw new FeedError("feed_unavailable", 503, "Stored tag proposal is invalid.");
  const now = Date.now();
  if (input.action === "reject") {
    await db.execute({ sql: "UPDATE feed_tag_proposals SET status = 'rejected', reviewed_by = ?, review_reason = ?, updated_at = ? WHERE id = ?", args: [input.reviewer, input.reason.slice(0, 2000), now, input.proposalId] });
    return { proposalId: input.proposalId, status: "rejected" };
  }
  let canonicalTagId = input.canonicalTagId;
  if (input.action === "create") {
    canonicalTagId = `${namespace}:${rowString(row, "slug")}`;
    await db.execute({
      sql: `INSERT INTO feed_tag_definitions(id, namespace, slug, label_zh, label_en, description, status, taxonomy_version, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, '', 'canonical', ?, ?, ?)
            ON CONFLICT(id) DO NOTHING`,
      args: [canonicalTagId, namespace, rowString(row, "slug"), rowString(row, "label_zh"), rowString(row, "label_en"), FEED_TAXONOMY_VERSION, now, now],
    });
  }
  if (typeof canonicalTagId !== "string" || !canonicalTagId) throw new FeedError("invalid_preferences", 400, "A canonical tag is required when mapping a proposal.");
  const canonical = await db.execute({ sql: "SELECT id FROM feed_tag_definitions WHERE id = ? AND status = 'canonical' LIMIT 1", args: [canonicalTagId] });
  if (!canonical.rows[0]) throw new FeedError("invalid_preferences", 400, "Target canonical tag does not exist.");
  await db.batch([
    {
      sql: `INSERT INTO feed_project_tags(repo_key, tag_id, source, weight, confidence, evidence_json, analysis_id, taxonomy_version, created_at, updated_at)
            VALUES (?, ?, 'admin', 0.9, 1, ?, ?, ?, ?, ?)
            ON CONFLICT(repo_key, tag_id) DO UPDATE SET source = excluded.source, evidence_json = excluded.evidence_json, analysis_id = excluded.analysis_id, updated_at = excluded.updated_at`,
      args: [rowString(row, "repo_key"), canonicalTagId, rowString(row, "evidence_json"), rowString(row, "analysis_id"), FEED_TAXONOMY_VERSION, now, now],
    },
    { sql: "UPDATE feed_tag_proposals SET status = 'accepted', reviewed_by = ?, review_reason = ?, updated_at = ? WHERE id = ?", args: [input.reviewer, input.reason.slice(0, 2000), now, input.proposalId] },
  ], "write");
  return { proposalId: input.proposalId, status: "accepted", canonicalTagId };
}

export async function listPendingFeedTagProposals(limit = 100): Promise<Array<{
  id: string;
  repoKey: string;
  analysisId: string;
  namespace: FeedNamespace;
  slug: string;
  labelZh: string;
  labelEn: string;
  evidenceIds: string[];
  createdAt: number;
}>> {
  const db = await ready();
  const rows = await db.execute({
    sql: `SELECT id, repo_key, analysis_id, namespace, slug, label_zh, label_en, evidence_json, created_at
          FROM feed_tag_proposals WHERE status = 'proposed'
          ORDER BY created_at ASC, id ASC LIMIT ?`,
    args: [Math.max(1, Math.min(250, Math.floor(limit)))],
  });
  return rows.rows.flatMap((raw) => {
    const row = raw as DbRow;
    const namespace = rowString(row, "namespace");
    if (!isNamespace(namespace)) return [];
    return [{
      id: rowString(row, "id"),
      repoKey: rowString(row, "repo_key"),
      analysisId: rowString(row, "analysis_id"),
      namespace,
      slug: rowString(row, "slug"),
      labelZh: rowString(row, "label_zh"),
      labelEn: rowString(row, "label_en"),
      evidenceIds: parseStringArray(row.evidence_json),
      createdAt: rowNumber(row, "created_at"),
    }];
  });
}

export function resetFeedDbForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new FeedError("feed_unavailable", 503, "Feed database reset is test-only.");
  client?.close();
  client = null;
  coreClient?.close();
  coreClient = null;
  schemaReady = null;
}
