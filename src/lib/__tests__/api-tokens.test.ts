import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client/web";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let tokens: typeof import("../api-tokens");
let directory: string;
let databaseUrl: string;
let client: ReturnType<typeof createClient>;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "ghfind-api-tokens-"));
  databaseUrl = `file:${join(directory, "tokens.db")}`;
  process.env.TURSO_DATABASE_URL = databaseUrl;
  delete process.env.TURSO_AUTH_TOKEN;
  client = createClient({ url: databaseUrl });
  await client.execute(`CREATE TABLE users (
    github_id INTEGER PRIMARY KEY,
    login TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT,
    created_at INTEGER NOT NULL,
    last_login INTEGER NOT NULL
  )`);
  await client.execute({ sql: "INSERT INTO users (github_id, login, created_at, last_login) VALUES (?, ?, ?, ?)", args: [73, "octocat", 1, 1] });
  tokens = await import("../api-tokens");
});

afterAll(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  rmSync(directory, { recursive: true, force: true });
});

describe("personal API token storage", () => {
  it("stores only a digest, authenticates the secret, and revokes it for its owner", async () => {
    const created = await tokens.createApiToken(73, "agent");
    expect(created).not.toBeNull();
    expect(created!.token).toMatch(/^ghf_[A-Za-z0-9_-]{40,}$/);
    const rows = await client.execute("SELECT token_hash, prefix FROM ghfind_api_tokens");
    expect(rows.rows[0]?.token_hash).not.toBe(created!.token);
    expect(rows.rows[0]?.prefix).toBe(created!.token.slice(0, 12));
    expect(await tokens.authenticateApiToken(created!.token)).toBe(73);
    expect(await tokens.revokeApiToken(74, created!.record.id)).toBe(false);
    expect(await tokens.revokeApiToken(73, created!.record.id)).toBe(true);
    expect(await tokens.authenticateApiToken(created!.token)).toBeNull();
    expect(await tokens.listApiTokens(73)).toEqual([]);
  });

  it("enforces the active-token cap and allows replacement after revocation", async () => {
    const active = [];
    for (let index = 0; index < tokens.MAX_ACTIVE_API_TOKENS; index += 1) {
      active.push(await tokens.createApiToken(73, `agent-${index}`));
    }
    expect(await tokens.createApiToken(73, "over-limit")).toBeNull();
    expect(await tokens.revokeApiToken(73, active[0]!.record.id)).toBe(true);
    expect(await tokens.createApiToken(73, "replacement")).not.toBeNull();
    for (const record of await tokens.listApiTokens(73)) {
      await tokens.revokeApiToken(73, record.id);
    }
  });

  it("keeps new tokens scan-only unless the bot scope is chosen", async () => {
    const scan = await tokens.createApiToken(73, "scan-only");
    const bot = await tokens.createApiToken(73, "bot", ["scan", "bot"]);
    expect(scan!.record.scopes).toEqual(["scan"]);
    expect(bot!.record.scopes).toEqual(["scan", "bot"]);
    expect(await tokens.authenticateApiTokenScopes(scan!.token)).toEqual({ githubId: 73, scopes: ["scan"] });
    expect(await tokens.authenticateApiTokenScopes(bot!.token)).toEqual({ githubId: 73, scopes: ["scan", "bot"] });
    // Scan auth is unchanged: any valid token works.
    expect(await tokens.authenticateApiToken(scan!.token)).toBe(73);
    expect(await tokens.authenticateApiToken(bot!.token)).toBe(73);
    const listed = await tokens.listApiTokens(73);
    expect(listed.find(token => token.id === bot!.record.id)?.scopes).toEqual(["scan", "bot"]);
    expect(listed.find(token => token.id === scan!.record.id)?.scopes).toEqual(["scan"]);
    const stored = await client.execute({ sql: "SELECT scopes FROM ghfind_api_tokens WHERE id = ?", args: [bot!.record.id] });
    expect(stored.rows[0]?.scopes).toBe("scan bot");
  });

  it("normalizes scope lists to scan plus known extras", () => {
    expect(tokens.normalizeScopes([])).toEqual(["scan"]);
    expect(tokens.normalizeScopes(["bot", "admin", "bot"])).toEqual(["scan", "bot"]);
  });
});

describe("personal API tokens before the scopes migration", () => {
  let legacyDirectory: string;
  let legacy: typeof import("../api-tokens");
  let legacyClient: ReturnType<typeof createClient>;

  beforeAll(async () => {
    // A database where 0015 ran but 0018 has not: no `scopes` column. On D1
    // the module skips runtime DDL, so simulate that by making the ALTER fail.
    legacyDirectory = mkdtempSync(join(tmpdir(), "ghfind-api-tokens-legacy-"));
    const url = `file:${join(legacyDirectory, "tokens.db")}`;
    legacyClient = createClient({ url });
    await legacyClient.execute("CREATE TABLE users (github_id INTEGER PRIMARY KEY)");
    await legacyClient.execute("INSERT INTO users (github_id) VALUES (73)");
    await legacyClient.execute(`CREATE TABLE ghfind_api_tokens (
      id TEXT PRIMARY KEY, github_id INTEGER NOT NULL, name TEXT NOT NULL, prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER)`);
    vi.resetModules();
    vi.doMock("@/lib/d1-client", () => ({
      getD1Binding: () => ({}),
      d1AsLibsqlClient: () => legacyClient,
    }));
    legacy = await import("../api-tokens");
  });

  afterAll(() => {
    vi.doUnmock("@/lib/d1-client");
    legacyClient.close();
    rmSync(legacyDirectory, { recursive: true, force: true });
  });

  it("treats every token as scan-only and refuses to create bot tokens", async () => {
    const created = await legacy.createApiToken(73, "agent");
    expect(created!.record.scopes).toEqual(["scan"]);
    expect(await legacy.authenticateApiTokenScopes(created!.token)).toEqual({ githubId: 73, scopes: ["scan"] });
    expect(await legacy.authenticateApiToken(created!.token)).toBe(73);
    expect((await legacy.listApiTokens(73)).map(token => token.scopes)).toEqual([["scan"]]);
    await expect(legacy.createApiToken(73, "bot", ["scan", "bot"])).rejects.toBeInstanceOf(legacy.ApiTokenScopesUnavailableError);
    expect(await legacy.listApiTokens(73)).toHaveLength(1);
  });

  it("picks the column up as soon as the migration is applied", async () => {
    await legacyClient.execute("ALTER TABLE ghfind_api_tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT 'scan'");
    const bot = await legacy.createApiToken(73, "bot", ["scan", "bot"]);
    expect(await legacy.authenticateApiTokenScopes(bot!.token)).toEqual({ githubId: 73, scopes: ["scan", "bot"] });
  });
});
