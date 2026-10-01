import { createClient, type InArgs } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SCORE_CACHE_VERSION } from "../cache-version";
import type { D1DatabaseLike } from "../d1-client";

const state = vi.hoisted(() => ({ binding: null as D1DatabaseLike | null }));
vi.mock("../d1-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../d1-client")>(),
  getD1Binding: () => state.binding,
}));

const client = createClient({ url: "file::memory:" });
const statements: { sql: string; args: unknown[] }[] = [];
let db: typeof import("../db");

beforeAll(async () => {
  await client.executeMultiple(`
    CREATE TABLE scores (
      username TEXT PRIMARY KEY, display_name TEXT, avatar_url TEXT,
      final_score REAL, tier TEXT, hidden INTEGER DEFAULT 0, score_version TEXT
    );
    CREATE INDEX idx_scores_hidden_score ON scores(hidden, final_score DESC);
    CREATE TABLE repos (
      repo_key TEXT PRIMARY KEY, name_with_owner TEXT, owner_login TEXT, name TEXT,
      description TEXT, stars INTEGER, forks INTEGER, language TEXT, topics TEXT
    );
    CREATE TABLE repo_developers (
      repo_key TEXT, username TEXT, relation TEXT,
      PRIMARY KEY(repo_key, username, relation)
    );
    CREATE INDEX idx_repo_developers_user ON repo_developers(username);
    CREATE TABLE account_lookup_limits (username TEXT, last_counted_at INTEGER);
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO scores(username, final_score, tier, hidden, score_version)
      SELECT 'unrelated-'||i, 80, '顶级', 0, '${SCORE_CACHE_VERSION}' FROM n;
  `);
  for (const [username, score, hidden, version] of [
    ["alice", 95, 0, SCORE_CACHE_VERSION],
    ["bob", 90, 0, SCORE_CACHE_VERSION],
    ["carol", 90, 0, SCORE_CACHE_VERSION],
    ["hidden", 100, 1, SCORE_CACHE_VERSION],
    ["low", 59, 0, SCORE_CACHE_VERSION],
    ["stale", 100, 0, "previous-fixture-version"],
  ] as const) {
    await client.execute({
      sql: "INSERT INTO scores(username, final_score, tier, hidden, score_version) VALUES(?,?,?,?,?)",
      args: [username, score, "顶级", hidden, version],
    });
  }
  for (const repo of ["fixture/one", "fixture/two"]) {
    await client.execute({
      sql: "INSERT INTO repos VALUES(?,?,?,'project',NULL,100,1,'TypeScript','[]')",
      args: [repo, repo, "alice"],
    });
    for (const username of ["alice", "bob", "carol", "hidden", "low", "stale"]) {
      await client.execute({
        sql: "INSERT INTO repo_developers VALUES(?,?,'contributor')",
        args: [repo, username],
      });
    }
    // An owner who also contributes must still occupy only one Top 3 position.
    await client.execute({
      sql: "INSERT INTO repo_developers VALUES(?,'alice','owner')", args: [repo],
    });
  }
  state.binding = {
    prepare(sql) {
      let args: unknown[] = [];
      const prepared = {
        bind(...values: unknown[]) { args = values; return prepared; },
        async all() {
          statements.push({ sql, args });
          const result = await client.execute({ sql, args: args as InArgs });
          return { results: result.rows.map((row) => ({ ...row })), meta: {} };
        },
      };
      return prepared;
    },
    batch: (prepared) => Promise.all(prepared.map((statement) => statement.all())),
  };
  db = await import("../db");
});

afterAll(() => { client.close(); });

describe("project contributors with a large unrelated score population", () => {
  it("keeps Top 3 ordering, visibility, version filtering and relation deduplication", async () => {
    const projects = await db.getDeveloperCommonProjects("alice", "bob", 6);
    expect(projects).toHaveLength(2);
    for (const project of projects) {
      expect(project.contributorCount).toBe(3);
      expect(project.topContributors.map((user) => user.username)).toEqual(["alice", "bob", "carol"]);
    }
  });

  it("looks up scores by username after scanning only the selected project edges", async () => {
    statements.length = 0;
    await db.getDeveloperCommonProjects("alice", "bob", 6);
    const query = statements.find((statement) => statement.sql.startsWith("SELECT edges.repo_key"));
    expect(query).toBeDefined();
    const plan = await client.execute({ sql: `EXPLAIN QUERY PLAN ${query!.sql}`, args: query!.args as InArgs });
    const details = plan.rows.map((row) => String(row.detail));
    const edges = details.findIndex((detail) => detail.includes("SCAN edges"));
    const scores = details.findIndex((detail) => detail.includes("SEARCH s") && detail.includes("username=?"));
    expect(edges).toBeGreaterThanOrEqual(0);
    expect(scores).toBeGreaterThan(edges);
    expect(details.some((detail) => detail.includes("SEARCH repo_developers") && detail.includes("repo_key=?"))).toBe(true);
    expect(details.some((detail) => detail.includes("idx_scores_hidden_score"))).toBe(false);
  });
});
