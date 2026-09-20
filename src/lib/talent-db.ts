import { createClient, type Client } from "@libsql/client/web";
import { d1AsLibsqlClient, getD1Binding } from "@/lib/d1-client";
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

function ensureSchema(db: Client): Promise<void> {
  if (!schemaReady) {
    schemaReady = db.execute(SCHEMA_STATEMENT).then(() => undefined).catch((error) => {
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

function mapTalent(row: Record<string, unknown>): Talent {
  const name = rowString(row.name);
  const direction = rowString(row.direction) || "未分类";
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
    role: rowString(row.role),
    location: rowString(row.location) || "未公开",
    direction,
    bio: rowString(row.bio),
    skills,
    stars: nullableNumber(row.stars),
    contributions: nullableNumber(row.contributions),
    source: rowString(row.source) || "人工整理",
    project: rowString(row.project),
    projectDescription: rowString(row.project_description),
    note: rowString(row.note),
    available,
    tags: [direction, ...skills, ...(available ? ["愿意交流"] : [])],
    projects: parseJson<Talent["projects"]>(row.projects_json, []),
    sources: parseJson<Talent["sources"]>(row.sources_json, []),
    publicFields: parseJson<Talent["publicFields"]>(row.public_fields_json, {}),
    pending: rowString(row.status) === "pending" ? true : undefined,
  };
}

/** Directory listing: published records only, editorial order. */
export async function listPublishedTalents(): Promise<Talent[]> {
  const db = database();
  await ensureSchema(db);
  const result = await db.execute({
    sql: `SELECT * FROM talent_profiles
          WHERE status = 'published'
          ORDER BY sort_order ASC, created_at DESC`,
    args: [],
  });
  return result.rows.map((row) => mapTalent(row as Record<string, unknown>));
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
