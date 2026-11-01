import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClient, type Client } from "@libsql/client/web";
import { d1AsLibsqlClient, getD1Binding } from "@/lib/d1-client";

export const MAX_ACTIVE_API_TOKENS = 10;

/** `scan` is what every token can do (the scan API, MCP, CLI scoring). `bot`
 *  is opt-in at creation: it lets the ghfind Review bot accept the token for
 *  managing repositories the account administers. */
export const API_TOKEN_SCOPES = ["scan", "bot"] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];
/** Scopes a user may add when creating a token; `scan` is always included. */
export const OPTIONAL_API_TOKEN_SCOPES: readonly ApiTokenScope[] = ["bot"];

export type ApiTokenRecord = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiTokenScope[];
  createdAt: number;
  lastUsedAt: number | null;
};

/** The `scopes` column (migration 0018) is not applied yet, so a scoped token
 *  cannot be stored. Scan-only tokens keep working without it. */
export class ApiTokenScopesUnavailableError extends Error {
  constructor() {
    super("API token scopes are not available yet.");
    this.name = "ApiTokenScopesUnavailableError";
  }
}

/** Canonical scope list: always `scan`, then known extras in a fixed order. */
export function normalizeScopes(scopes: Iterable<string>): ApiTokenScope[] {
  const wanted = new Set(scopes);
  return API_TOKEN_SCOPES.filter(scope => scope === "scan" || wanted.has(scope));
}

function parseScopes(raw: unknown): ApiTokenScope[] {
  // A missing column or value means a token from before scopes: scan only.
  return normalizeScopes(typeof raw === "string" ? raw.split(/[\s,]+/) : []);
}

// On D1 the schema is owned by migrations, so until 0018 is applied a query
// naming `scopes` fails. Readers then retry without it (scan only).
function isMissingScopesColumn(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such column:?\s*scopes|no column named scopes/i.test(message);
}

async function withScopesFallback<T>(withScopes: () => Promise<T>, withoutScopes: () => Promise<T>): Promise<T> {
  try {
    return await withScopes();
  } catch (error) {
    if (!isMissingScopesColumn(error)) throw error;
    return withoutScopes();
  }
}

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
      revoked_at INTEGER,
      scopes TEXT NOT NULL DEFAULT 'scan'
    )`).then(async () => {
      try {
        await db.execute(`ALTER TABLE ghfind_api_tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT 'scan'`);
      } catch (error) {
        if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
      }
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
    scopes: parseScopes(row.scopes),
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
  };
}

export async function listApiTokens(githubId: number): Promise<ApiTokenRecord[]> {
  const db = database();
  await ensureSchema(db);
  const select = (columns: string) => db.execute({
    sql: `SELECT ${columns}
      FROM ghfind_api_tokens WHERE github_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    args: [githubId],
  });
  const result = await withScopesFallback(
    () => select("id, name, prefix, scopes, created_at, last_used_at"),
    () => select("id, name, prefix, created_at, last_used_at"),
  );
  return result.rows.map((row) => mapRecord(row as Record<string, unknown>));
}

export async function createApiToken(
  githubId: number,
  name: string,
  scopes: readonly ApiTokenScope[] = ["scan"],
): Promise<{ token: string; record: ApiTokenRecord } | null> {
  const db = database();
  await ensureSchema(db);
  const token = `ghf_${randomBytes(32).toString("base64url")}`;
  const record: ApiTokenRecord = {
    id: randomUUID(),
    name,
    prefix: token.slice(0, 12),
    scopes: normalizeScopes(scopes),
    createdAt: Date.now(),
    lastUsedAt: null,
  };
  // A scan-only token leaves `scopes` to its column default, so it can be
  // created whether or not migration 0018 has been applied.
  const scoped = record.scopes.length > 1;
  const columns = scoped ? ", scopes" : "";
  const values = scoped ? ", ?" : "";
  let result;
  try {
    result = await db.execute({
      sql: `INSERT INTO ghfind_api_tokens
        (id, github_id, name, prefix, token_hash, created_at${columns})
        SELECT ?, ?, ?, ?, ?, ?${values}
        WHERE (SELECT COUNT(*) FROM ghfind_api_tokens
          WHERE github_id = ? AND revoked_at IS NULL) < ?`,
      args: [
        record.id, githubId, record.name, record.prefix, hashToken(token), record.createdAt,
        ...(scoped ? [record.scopes.join(" ")] : []),
        githubId, MAX_ACTIVE_API_TOKENS,
      ],
    });
  } catch (error) {
    if (scoped && isMissingScopesColumn(error)) throw new ApiTokenScopesUnavailableError();
    throw error;
  }
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

/** Any valid token is enough for the scan API; use
 *  `authenticateApiTokenScopes` where a specific scope is required. */
export async function authenticateApiToken(token: string): Promise<number | null> {
  return (await authenticateApiTokenScopes(token))?.githubId ?? null;
}

export async function authenticateApiTokenScopes(
  token: string,
): Promise<{ githubId: number; scopes: ApiTokenScope[] } | null> {
  if (!/^ghf_[A-Za-z0-9_-]{40,}$/.test(token)) return null;
  const db = database();
  await ensureSchema(db);
  const tokenHash = hashToken(token);
  const now = Date.now();
  const select = (columns: string) => db.execute({
    sql: `SELECT ${columns} FROM ghfind_api_tokens
      WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
    args: [tokenHash],
  });
  const result = await withScopesFallback(
    () => select("github_id, last_used_at, scopes"),
    () => select("github_id, last_used_at"),
  );
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
  return { githubId: Number(row.github_id), scopes: parseScopes(row.scopes) };
}
