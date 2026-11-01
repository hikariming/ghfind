import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createClient } from "@libsql/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScoreEntry, ScoreWriteIdentity } from "../db";
import { PUBLIC_SCAN_COLLECTION_VERSION } from "../scan-run-types";

const { advanceScoreDetailRevision } = vi.hoisted(() => ({ advanceScoreDetailRevision: vi.fn() }));
vi.mock("../redis", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../redis")>()),
  advanceScoreDetailRevision,
}));

let db: typeof import("../db");
let tmpDir: string;

const entry: ScoreEntry = {
  username: "DemoDev",
  display_name: "Demo Dev",
  avatar_url: null,
  profile_url: "https://profiles.example.invalid/demo-dev",
  final_score: 81.4,
  tier: "顶级",
  tags: { zh: ["示例"], en: ["sample"] },
  roast_line: { zh: "", en: "" },
  bot_score: 0,
  sub_scores: {
    account_maturity: 8,
    original_project_quality: 15,
    contribution_quality: 22,
    ecosystem_impact: 16,
    community_influence: 8,
    activity_authenticity: 12.4,
  },
  scanned_at: 1_800_000_000_000,
};

async function writeScore(username: string): Promise<ScoreWriteIdentity> {
  const identity = await db.recordScore({ ...entry, username });
  if (!identity) throw new Error("expected synthetic score write");
  const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
  await client.execute({
    sql: `UPDATE scores SET score_source_collection_version = ?, score_source_snapshot_hash = ?
          WHERE username = ?`,
    args: [
      PUBLIC_SCAN_COLLECTION_VERSION,
      createHash("sha256").update(username).digest("hex"),
      username.toLowerCase(),
    ],
  });
  return identity;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ghroast-revision-"));
  process.env.TURSO_DATABASE_URL = `file:${join(tmpDir, "test.db")}`;
  delete process.env.TURSO_AUTH_TOKEN;
  db = await import("../db");
});

afterAll(() => {
  delete process.env.TURSO_DATABASE_URL;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  advanceScoreDetailRevision.mockReset();
  advanceScoreDetailRevision.mockResolvedValue(undefined);
});

describe("updateRoast score-detail freshness", () => {
  it("advances the score-detail revision after a persisted report (roast_line refreshes)", async () => {
    const identity = await writeScore("DemoDev");
    advanceScoreDetailRevision.mockClear();
    const line = { zh: "示例一句话短评。", en: "A sample one-liner." };
    await expect(
      db.updateRoast("DemoDev", "## 示例报告", "zh", identity, { tags: entry.tags, roastLine: line }),
    ).resolves.toBe(true);
    expect(advanceScoreDetailRevision).toHaveBeenCalledTimes(1);
    expect(advanceScoreDetailRevision).toHaveBeenCalledWith("demodev");
    await expect(db.getAccountDetail("DemoDev")).resolves.toMatchObject({ roast_line: line });
  });

  it("does not advance it when the CAS write loses (stale score identity)", async () => {
    const identity = await writeScore("sample-a");
    advanceScoreDetailRevision.mockClear();
    const stale = { ...identity, token: "stale-token" };
    await expect(db.updateRoast("sample-a", "## 示例报告", "zh", stale)).resolves.toBe(false);
    expect(advanceScoreDetailRevision).not.toHaveBeenCalled();
  });

  it("keeps the committed report when the revision cannot be advanced", async () => {
    const identity = await writeScore("sample-b");
    advanceScoreDetailRevision.mockRejectedValue(new Error("coordination unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(db.updateRoast("sample-b", "## Sample report", "en", identity)).resolves.toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
