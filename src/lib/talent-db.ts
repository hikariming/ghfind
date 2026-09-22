import { createClient, type Client } from "@libsql/client/web";
import { d1AsLibsqlClient, getD1Binding } from "@/lib/d1-client";
import { normLang } from "@/lib/lang";
import type { Talent } from "@/components/talent/data";

export class TalentDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TalentDatabaseError";
  }
}

let client: Client | null = null;
let schemaReady: Promise<void> | null = null;

function database(): Client {
  if (client) return client;
  const d1 = getD1Binding();
  if (d1) {
    client = d1AsLibsqlClient(d1);
    // D1 schema is owned by wrangler migrations (0008_talent_profiles.sql);
    // never run runtime DDL there.
    schemaReady = Promise.resolve();
    return client;
  }
  const url = process.env.TURSO_DATABASE_URL?.trim();
  if (!url) {
    throw new TalentDatabaseError("TURSO_DATABASE_URL is required for talent persistence.");
  }
  client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined });
  return client;
}

const SCHEMA_STATEMENT = `CREATE TABLE IF NOT EXISTS talent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  handle TEXT,
  role TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL DEFAULT '未分类',
  bio TEXT NOT NULL DEFAULT '',
  skills_json TEXT NOT NULL DEFAULT '[]',
  stars INTEGER,
  contributions INTEGER,
  source TEXT NOT NULL DEFAULT '人工整理',
  project TEXT NOT NULL DEFAULT '',
  project_description TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  available INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT 'sage',
  tags_json TEXT,
  projects_json TEXT,
  sources_json TEXT,
  public_fields_json TEXT,
  collection_slug TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('published', 'pending')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const I18N_STATEMENT = `ALTER TABLE talent_profiles ADD COLUMN content_i18n_json TEXT`;

const OFFICIAL_TAGS_STATEMENT = `ALTER TABLE talent_profiles ADD COLUMN official_tags_json TEXT`;

const PIN_STATEMENT = `ALTER TABLE talent_profiles ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`;

const CORNER_TAG_STATEMENT = `ALTER TABLE talent_profiles ADD COLUMN corner_tag TEXT`;

function ensureSchema(db: Client): Promise<void> {
  if (!schemaReady) {
    schemaReady = db.execute(SCHEMA_STATEMENT)
      // Best-effort twins of migrations/0009_talent_i18n.sql,
      // migrations/0010_talent_official_tags.sql and
      // migrations/0011_talent_pin_corner.sql for Turso/local;
      // a duplicate-column error just means the column already exists.
      .then(() => db.execute(I18N_STATEMENT).catch(() => undefined))
      .then(() => db.execute(OFFICIAL_TAGS_STATEMENT).catch(() => undefined))
      .then(() => db.execute(PIN_STATEMENT).catch(() => undefined))
      .then(() => db.execute(CORNER_TAG_STATEMENT).catch(() => undefined))
      .then(() => undefined)
      .catch((error) => {
        schemaReady = null;
        throw error;
      });
  }
  return schemaReady;
}

function rowString(value: unknown): string {
  return String(value ?? "");
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const AVATAR_COLORS = ["sage", "lavender", "peach", "blue", "rose", "sand"] as const;

type TalentI18nField = "role" | "direction" | "bio" | "note" | "project_description";
type TalentI18n = { en?: Partial<Record<TalentI18nField, string>> };

function mapTalent(row: Record<string, unknown>, lang: "zh" | "en" = "zh"): Talent {
  const name = rowString(row.name);
  const i18n = lang === "en" ? parseJson<TalentI18n>(row.content_i18n_json, {}).en ?? {} : {};
  const pick = (field: TalentI18nField, zh: string): string => {
    const translated = i18n[field]?.trim();
    return translated || zh;
  };
  const direction = pick("direction", rowString(row.direction) || "未分类");
  const skills = parseJson<string[]>(row.skills_json, []);
  const available = Number(row.available) === 1;
  return {
    id: rowString(row.id),
    name,
    handle: rowString(row.handle),
    initials: name.replace(/[（(].*$/, "").trim().slice(0, 2).toUpperCase(),
    color: AVATAR_COLORS.includes(row.color as (typeof AVATAR_COLORS)[number])
      ? rowString(row.color)
      : "sage",
    role: pick("role", rowString(row.role)),
    location: rowString(row.location) || "未公开",
    direction,
    bio: pick("bio", rowString(row.bio)),
    skills,
    stars: nullableNumber(row.stars),
    contributions: nullableNumber(row.contributions),
    score: nullableNumber(row.ghfind_score),
    source: rowString(row.source) || "人工整理",
    project: rowString(row.project),
    projectDescription: pick("project_description", rowString(row.project_description)),
    note: pick("note", rowString(row.note)),
    available,
    officialTags: parseJson<string[]>(row.official_tags_json, [])
      .filter((tag) => typeof tag === "string" && tag.trim())
      .map((tag) => tag.trim()),
    pinned: Number(row.pinned) === 1 ? true : undefined,
    cornerTag: rowString(row.corner_tag).trim() || undefined,
    tags: [direction, ...skills, ...(available ? ["愿意交流"] : [])],
    projects: parseJson<Talent["projects"]>(row.projects_json, []),
    sources: parseJson<Talent["sources"]>(row.sources_json, []),
    publicFields: parseJson<Talent["publicFields"]>(row.public_fields_json, {}),
    pending: rowString(row.status) === "pending" ? true : undefined,
  };
}

/** Directory listing: published records only, editorial order. */
export async function listPublishedTalents(locale?: string): Promise<Talent[]> {
  const db = database();
  await ensureSchema(db);
  const lang = normLang(locale);
  const result = await db.execute({
    // scores.username stores the lowercased GitHub login; hidden scores stay private.
    sql: `SELECT t.*, s.final_score AS ghfind_score
          FROM talent_profiles t
          LEFT JOIN scores s ON s.username = lower(t.id) AND s.hidden = 0
          WHERE t.status = 'published'
          ORDER BY t.pinned DESC, t.sort_order ASC, t.created_at DESC`,
    args: [],
  });
  return result.rows.map((row) => mapTalent(row as Record<string, unknown>, lang));
}

// ---------------------------------------------------------------------------
// Paginated directory queries. The list page reads light rows (heavy JSON
// columns such as projects/sources/note stay out of the payload and are
// fetched per-talent via getTalentById when the detail modal opens), so a
// page view costs ~pageSize row reads instead of the whole published set.
// ---------------------------------------------------------------------------

const LIST_COLUMNS = `t.id, t.name, t.handle, t.role, t.location, t.direction, t.bio,
  t.skills_json, t.stars, t.contributions, t.source, t.project, t.project_description,
  t.available, t.color, t.official_tags_json, t.pinned, t.corner_tag, t.status,
  t.sort_order, t.created_at, t.content_i18n_json`;

export type TalentSort = "recommended" | "stars" | "activity";

export type TalentListParams = {
  locale?: string;
  query?: string;
  direction?: string;
  location?: string;
  source?: "github" | "manual";
  available?: boolean;
  sort?: TalentSort;
  /** 0-based page index. */
  page?: number;
  pageSize?: number;
  /** Saved-tab lookup by id; bypasses every other filter. */
  ids?: string[];
};

export type TalentListResult = {
  items: Talent[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
};

const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 96;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// Field-prefixed query tokens, e.g. `技能:Rust 地点:上海`. Chinese and English
// prefixes both work; values are matched against the raw stored fields.
const QUERY_FIELD_PREFIXES: Record<string, "location" | "skill" | "direction"> = {
  "地点": "location", "位置": "location", "城市": "location",
  loc: "location", location: "location", city: "location",
  "技能": "skill", "技术": "skill",
  skill: "skill", tech: "skill", stack: "skill",
  "方向": "direction", "领域": "direction",
  dir: "direction", direction: "direction", field: "direction",
};

function parseTalentQuery(raw: string): {
  fields: Record<"location" | "skill" | "direction", string[]>;
  free: string;
} {
  const fields = { location: [] as string[], skill: [] as string[], direction: [] as string[] };
  const free: string[] = [];
  for (const token of raw.split(/\s+/).filter(Boolean)) {
    const match = token.match(/^([^\s:：]{1,16})[:：](.+)$/);
    const field = match ? QUERY_FIELD_PREFIXES[match[1].toLowerCase()] : undefined;
    if (match && field && match[2].trim()) fields[field].push(match[2].trim());
    else free.push(token);
  }
  return { fields, free: free.join(" ") };
}

export async function listTalentsPage(params: TalentListParams = {}): Promise<TalentListResult> {
  const db = database();
  await ensureSchema(db);
  const lang = normLang(params.locale);
  const page = Math.max(0, Math.floor(params.page ?? 0));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(params.pageSize ?? DEFAULT_PAGE_SIZE)));

  const where: string[] = ["t.status = 'published'"];
  const args: (string | number)[] = [];
  const ids = (params.ids ?? []).map((id) => id.trim().toLowerCase()).filter(Boolean).slice(0, 100);
  if (ids.length) {
    where.push(`t.id IN (${ids.map(() => "?").join(", ")})`);
    args.push(...ids);
  } else {
    const query = params.query?.trim();
    if (query) {
      const { fields, free } = parseTalentQuery(query);
      if (free) {
        const like = `%${escapeLike(free)}%`;
        where.push(`(t.name LIKE ? ESCAPE '\\' OR t.handle LIKE ? ESCAPE '\\' OR t.role LIKE ? ESCAPE '\\' OR t.bio LIKE ? ESCAPE '\\' OR t.location LIKE ? ESCAPE '\\' OR t.skills_json LIKE ? ESCAPE '\\')`);
        args.push(like, like, like, like, like, like);
      }
      for (const value of fields.location) {
        where.push(`t.location LIKE ? ESCAPE '\\'`);
        args.push(`%${escapeLike(value)}%`);
      }
      for (const value of fields.skill) {
        where.push(`t.skills_json LIKE ? ESCAPE '\\'`);
        args.push(`%${escapeLike(value)}%`);
      }
      for (const value of fields.direction) {
        where.push(`t.direction LIKE ? ESCAPE '\\'`);
        args.push(`%${escapeLike(value)}%`);
      }
    }
    if (params.direction) { where.push("t.direction = ?"); args.push(params.direction); }
    if (params.location) { where.push("t.location = ?"); args.push(params.location); }
    if (params.source === "github") where.push("t.source LIKE '%GitHub%'");
    if (params.source === "manual") where.push("t.source NOT LIKE '%GitHub%'");
    if (params.available) where.push("t.available = 1");
  }
  const whereSql = where.join(" AND ");
  const sort = params.sort ?? "recommended";
  const orderSql = sort === "stars"
    ? "t.stars DESC, t.pinned DESC, t.sort_order ASC, t.created_at DESC"
    : sort === "activity"
      ? "t.contributions DESC, t.pinned DESC, t.sort_order ASC, t.created_at DESC"
      : "t.pinned DESC, t.sort_order ASC, t.created_at DESC";

  const countResult = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM talent_profiles t WHERE ${whereSql}`,
    args,
  });
  const total = Number(countResult.rows[0]?.n ?? 0);
  // An out-of-range page (e.g. a shared ?page=9 link) falls back to the last
  // page instead of rendering an empty grid.
  const safePage = Math.min(page, Math.max(0, Math.ceil(total / pageSize) - 1));
  const result = await db.execute({
    // scores.username stores the lowercased GitHub login; hidden scores stay private.
    sql: `SELECT ${LIST_COLUMNS}, s.final_score AS ghfind_score
          FROM talent_profiles t
          LEFT JOIN scores s ON s.username = lower(t.id) AND s.hidden = 0
          WHERE ${whereSql}
          ORDER BY ${orderSql}
          LIMIT ? OFFSET ?`,
    args: [...args, pageSize, safePage * pageSize],
  });
  const items = result.rows.map((row) => mapTalent(row as Record<string, unknown>, lang));
  return { items, total, page: safePage, pageSize, hasMore: (safePage + 1) * pageSize < total };
}

/** Full record for the detail modal, including the heavy JSON columns the
 * paginated list deliberately leaves out. */
export async function getTalentById(id: string, locale?: string): Promise<Talent | null> {
  const db = database();
  await ensureSchema(db);
  const lang = normLang(locale);
  const result = await db.execute({
    sql: `SELECT t.*, s.final_score AS ghfind_score
          FROM talent_profiles t
          LEFT JOIN scores s ON s.username = lower(t.id) AND s.hidden = 0
          WHERE t.id = ? AND t.status = 'published'
          LIMIT 1`,
    args: [id.trim().toLowerCase()],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? mapTalent(row, lang) : null;
}

export type TalentFacets = { directions: string[]; locations: string[] };

// Facets require a distinct scan of the published set; cache briefly per
// isolate so a directory visit pays it at most once per TTL.
let facetsCache: { at: number; value: TalentFacets } | null = null;
const FACETS_TTL_MS = 5 * 60 * 1000;

export async function listTalentFacets(): Promise<TalentFacets> {
  if (facetsCache && Date.now() - facetsCache.at < FACETS_TTL_MS) return facetsCache.value;
  const db = database();
  await ensureSchema(db);
  const [directions, locations] = await Promise.all([
    db.execute("SELECT DISTINCT direction FROM talent_profiles WHERE status = 'published' ORDER BY direction"),
    db.execute("SELECT DISTINCT location FROM talent_profiles WHERE status = 'published' ORDER BY location"),
  ]);
  const value: TalentFacets = {
    directions: directions.rows.map((r) => String(r.direction ?? "")).filter(Boolean),
    locations: locations.rows.map((r) => String(r.location ?? "")).filter(Boolean),
  };
  facetsCache = { at: Date.now(), value };
  return value;
}

const MAX_FIELD_LENGTH = 2_000;

function clipped(value: string | undefined): string {
  return (value ?? "").slice(0, MAX_FIELD_LENGTH);
}

/**
 * Intake submissions are stored as pending and never listed by
 * listPublishedTalents; an operator publishes them after review.
 */
export async function createPendingTalent(talent: Talent): Promise<void> {
  const db = database();
  await ensureSchema(db);
  const now = Date.now();
  const name = clipped(talent.name).trim();
  if (!name) throw new TalentDatabaseError("Talent name is required.");
  const result = await db.execute({
    sql: `INSERT INTO talent_profiles (
            id, name, handle, role, location, direction, bio, skills_json,
            stars, contributions, source, project, project_description, note,
            available, color, projects_json, sources_json, public_fields_json,
            status, sort_order, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, '', '', ?, 0, 'sage', '[]', '[]', ?, 'pending', 0, ?, ?)`,
    args: [
      talent.id,
      name,
      clipped(talent.handle) || null,
      clipped(talent.role),
      clipped(talent.location),
      clipped(talent.direction) || "未分类",
      clipped(talent.bio),
      JSON.stringify((talent.skills ?? []).slice(0, 12).map((s) => clipped(s))),
      clipped(talent.source) || "人工整理",
      clipped(talent.note),
      JSON.stringify(talent.publicFields ?? {}),
      now,
      now,
    ],
  });
  if (result.rowsAffected !== 1) throw new TalentDatabaseError("Talent intake was not stored.");
}

export function resetTalentDbForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new TalentDatabaseError("Database reset is test-only.");
  }
  client?.close();
  client = null;
  schemaReady = null;
}
