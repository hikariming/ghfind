import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClient, type Client } from "@libsql/client/web";
import { d1AsLibsqlClient, getD1Binding } from "@/lib/d1-client";

export const MAX_ACTIVE_API_TOKENS = 10;

export type ApiTokenRecord = {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
};

let client: Client | null = null;
let schemaReady: Promise<void> | null = null;

function database(): Client {
  if (client) return client;
  const d1 = getD1Binding();
  if (d1) {
    client = d1AsLibsqlClient(d1);
    schemaReady = Promise.resolve();
    return client;
  }
  const url = process.env.TURSO_DATABASE_URL?.trim();
  if (!url) throw new Error("Token storage is not configured.");
  client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined });
  return client;
}

async function ensureSchema(db: Client): Promise<void> {
  if (!schemaReady) {
    schemaReady = db.execute(`CREATE TABLE IF NOT EXISTS ghfind_api_tokens (
      id TEXT PRIMARY KEY,
      github_id INTEGER NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    )`).then(async () => {
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_ghfind_api_tokens_owner
        ON ghfind_api_tokens(github_id, created_at DESC)`);
      await db.execute(`CREATE INDEX IF NOT EXISTS idx_ghfind_api_tokens_active_owner
        ON ghfind_api_tokens(github_id, revoked_at, created_at DESC)`);
    }).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

function mapRecord(row: Record<string, unknown>): ApiTokenRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    prefix: String(row.prefix),
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
  };
}

export async function listApiTokens(githubId: number): Promise<ApiTokenRecord[]> {
  const db = database();
  await ensureSchema(db);
  const result = await db.execute({
    sql: `SELECT id, name, prefix, created_at, last_used_at
      FROM ghfind_api_tokens WHERE github_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    args: [githubId],
  });
  return result.rows.map((row) => mapRecord(row as Record<string, unknown>));
}

export async function createApiToken(githubId: number, name: string): Promise<{ token: string; record: ApiTokenRecord } | null> {
  const db = database();
  await ensureSchema(db);
  const token = `ghf_${randomBytes(32).toString("base64url")}`;
  const record: ApiTokenRecord = {
    id: randomUUID(),
    name,
    prefix: token.slice(0, 12),
    createdAt: Date.now(),
    lastUsedAt: null,
  };
  const result = await db.execute({
    sql: `INSERT INTO ghfind_api_tokens
      (id, github_id, name, prefix, token_hash, created_at)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM ghfind_api_tokens
        WHERE github_id = ? AND revoked_at IS NULL) < ?`,
    args: [record.id, githubId, record.name, record.prefix, hashToken(token), record.createdAt, githubId, MAX_ACTIVE_API_TOKENS],
  });
  if (Number(result.rowsAffected ?? 0) === 0) return null;
  return { token, record };
}

export async function revokeApiToken(githubId: number, id: string): Promise<boolean> {
  const db = database();
  await ensureSchema(db);
  const result = await db.execute({
    sql: `UPDATE ghfind_api_tokens SET revoked_at = ?
      WHERE id = ? AND github_id = ? AND revoked_at IS NULL`,
    args: [Date.now(), id, githubId],
  });
  return Number(result.rowsAffected ?? 0) > 0;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function authenticateApiToken(token: string): Promise<number | null> {
  if (!/^ghf_[A-Za-z0-9_-]{40,}$/.test(token)) return null;
  const db = database();
  await ensureSchema(db);
  const tokenHash = hashToken(token);
  const now = Date.now();
  const result = await db.execute({
    sql: `SELECT github_id, last_used_at FROM ghfind_api_tokens
      WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
    args: [tokenHash],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const lastUsedAt = row.last_used_at == null ? 0 : Number(row.last_used_at);
  if (now - lastUsedAt >= 60 * 60 * 1000) {
    await db.execute({
      sql: `UPDATE ghfind_api_tokens SET last_used_at = ?
        WHERE token_hash = ? AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at < ?)`,
      args: [now, tokenHash, now - 60 * 60 * 1000],
    });
  }
  return Number(row.github_id);
}
