import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client/web";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
  });
});
