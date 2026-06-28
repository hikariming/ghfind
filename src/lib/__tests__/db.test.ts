import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScoreEntry } from "../db";

let db: typeof import("../db");
let tmpDir: string;

const entry: ScoreEntry = {
  username: "RockChinQ",
  display_name: "Rock",
  avatar_url: null,
  profile_url: "https://github.com/RockChinQ",
  final_score: 95.2,
  tier: "夯",
  tags: { zh: ["开源狠人"], en: ["oss beast"] },
  roast_line: { zh: "强到没法吐槽。", en: "Too good to roast." },
  bot_score: 0,
  sub_scores: {
    account_maturity: 10,
    original_project_quality: 18,
    contribution_quality: 27,
    ecosystem_impact: 20,
    community_influence: 8,
    activity_authenticity: 12.2,
  },
  scanned_at: 1_800_000_000_000,
};

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ghroast-db-"));
  process.env.TURSO_DATABASE_URL = `file:${join(tmpDir, "test.db")}`;
  delete process.env.TURSO_AUTH_TOKEN;
  db = await import("../db");
});

afterAll(() => {
  delete process.env.TURSO_DATABASE_URL;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getArchivedRoast", () => {
  it("replays archived reports by username and language", async () => {
    await db.recordScore(entry);
    await db.updateRoast("RockChinQ", "## 中文报告", "zh");
    await db.updateRoast("RockChinQ", "## English report", "en");

    await expect(db.getArchivedRoast("rockchinq", "zh")).resolves.toMatchObject({
      username: "rockchinq",
      final_score: 95.2,
      tier: "夯",
      tags: entry.tags,
      report: "## 中文报告",
    });
    await expect(db.getArchivedRoast("RockChinQ", "en")).resolves.toMatchObject({
      report: "## English report",
    });
  });
});

describe("getTrendingLeaderboard", () => {
  it("counts unique lookups from the last seven days only", async () => {
    const now = Date.now();
    await db.recordScore({ ...entry, username: "fresh", final_score: 92, scanned_at: now });
    await db.recordScore({ ...entry, username: "stale", final_score: 100, scanned_at: now - 1 });

    await db.recordAccountLookup("fresh", "203.0.113.1");
    await db.recordAccountLookup("fresh", "203.0.113.2");
    await db.recordAccountLookup("fresh", "203.0.113.2"); // same visitor, same 24h window
    await db.recordAccountLookup("stale", "203.0.113.3");

    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    await client.execute({
      sql: `UPDATE account_lookup_limits
            SET last_counted_at = ?
            WHERE username = ?`,
      args: [now - 8 * 24 * 60 * 60 * 1000, "stale"],
    });
    await client.execute({
      sql: `UPDATE account_stats
            SET last_lookup_at = ?
            WHERE username = ?`,
      args: [now - 8 * 24 * 60 * 60 * 1000, "stale"],
    });

    const entries = await db.getTrendingLeaderboard(10);
    const fresh = entries.find((e) => e.username === "fresh");
    const stale = entries.find((e) => e.username === "stale");

    expect(fresh?.recent_lookup_count).toBe(2);
    expect(stale?.recent_lookup_count).toBe(0);
    expect(fresh?.trending_score).toBeGreaterThan(0);
    expect(entries[0]?.username).toBe("fresh");
  });
});
