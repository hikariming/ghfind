import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  getSettings,
  llmConfigured,
  triageConfigured,
  parseBackfillLimit,
  parseSettingsForm,
  putBackfillLimit,
  putSettings,
  SettingsForm,
} from "../src/settings";
declare const TEST_SQL: string[];
const e = env as Env;
beforeAll(async () => {
  for (const sql of TEST_SQL) await e.DB.prepare(sql).run();
});
beforeEach(async () => {
  await e.DB.prepare("DELETE FROM repo_settings").run();
});
const custom: SettingsForm = {
  issuesEnabled: false,
  prsEnabled: true,
  commentsEnabled: true,
  commentPrompt: "Reply in Chinese, friendly tone.",
  triageEnabled: true,
  allowedLabels: ["bug", "good first issue"],
};
function form(entries: [string, string][]) {
  return new URLSearchParams(entries);
}

it("returns defaults when no row exists", async () => {
  const s = await getSettings(e, 2);
  expect(s).toEqual(DEFAULT_SETTINGS);
  expect(s).toEqual({
    issuesEnabled: true,
    prsEnabled: true,
    commentsEnabled: false,
    commentPrompt: "",
    triageEnabled: false,
    allowedLabels: [],
    backfillLimit: 25,
  });
  s.allowedLabels.push("x");
  expect(DEFAULT_SETTINGS.allowedLabels).toEqual([]);
});

it("round-trips and upserts settings without touching the backfill limit", async () => {
  await putSettings(e, 1, 2, "owner/repo", custom, "alice");
  expect(await getSettings(e, 2)).toEqual({ ...custom, backfillLimit: 25 });
  expect(await getSettings(e, 3)).toEqual(DEFAULT_SETTINGS);
  await putBackfillLimit(e, 1, 2, "owner/repo", 7, "carol");
  const next = { ...custom, allowedLabels: [] };
  await putSettings(e, 1, 2, "owner/renamed", next, "bob");
  expect(await getSettings(e, 2)).toEqual({ ...next, backfillLimit: 7 });
  const row = await e.DB.prepare(
    "SELECT COUNT(*) n,MAX(full_name) full_name,MAX(updated_by) updated_by,MAX(updated) updated FROM repo_settings",
  ).first<{ n: number; full_name: string; updated_by: string; updated: number }>();
  expect(row).toMatchObject({ n: 1, full_name: "owner/renamed", updated_by: "bob" });
  expect(row!.updated).toBeGreaterThan(0);
});

it("keys settings by repository, so they survive a new installation", async () => {
  await putSettings(e, 1, 2, "owner/repo", custom, "alice");
  // Uninstall and reinstall: GitHub issues a new installation id, same repository id.
  expect(await getSettings(e, 2)).toEqual({ ...custom, backfillLimit: 25 });
  await putBackfillLimit(e, 9, 2, "owner/repo", 40, "bob");
  expect(await getSettings(e, 2)).toEqual({ ...custom, backfillLimit: 40 });
  const row = await e.DB.prepare(
    "SELECT COUNT(*) n,MAX(installation) installation FROM repo_settings",
  ).first();
  expect(row).toEqual({ n: 1, installation: 9 });
});

it("falls back to defaults only when the table is missing", async () => {
  await putSettings(e, 1, 2, "owner/repo", custom, "alice");
  await e.DB.prepare("DROP TABLE repo_settings").run();
  try {
    expect(await getSettings(e, 2)).toEqual(DEFAULT_SETTINGS);
  } finally {
    for (const sql of TEST_SQL.filter((x) => x.includes("repo_settings")))
      await e.DB.prepare(sql).run();
  }
  const broken = {
    DB: {
      prepare: () => {
        throw new Error("D1_ERROR: database is locked");
      },
    },
  } as unknown as Env;
  await expect(getSettings(broken, 2)).rejects.toThrow("database is locked");
});

it("treats corrupt allowed_labels JSON as empty", async () => {
  await putSettings(e, 1, 2, "owner/repo", custom, "alice");
  for (const bad of ["not json", '{"a":1}', '["ok",3,null]']) {
    await e.DB.prepare("UPDATE repo_settings SET allowed_labels=?")
      .bind(bad)
      .run();
    const labels = (await getSettings(e, 2)).allowedLabels;
    expect(labels).toEqual(bad.startsWith("[") ? ["ok"] : []);
  }
});

it("parses a valid settings form and ignores backfill_limit", () => {
  expect(parseSettingsForm(form([["backfill_limit", "500"]]))).toEqual({
    issuesEnabled: false,
    prsEnabled: false,
    commentsEnabled: false,
    commentPrompt: "",
    triageEnabled: false,
    allowedLabels: [],
  });
  expect(
    parseSettingsForm(
      form([
        ["issues_enabled", "on"],
        ["comments_enabled", "on"],
        ["triage_enabled", "on"],
        ["comment_prompt", "x".repeat(2000)],
        ["allowed_labels", "bug"],
        ["allowed_labels", "bug"],
        ["allowed_labels", "Feature request"],
        ...Array.from(
          { length: 48 },
          (_, i) => ["allowed_labels", `l${i}`] as [string, string],
        ),
      ]),
    ),
  ).toMatchObject({
    issuesEnabled: true,
    prsEnabled: false,
    commentsEnabled: true,
    triageEnabled: true,
    allowedLabels: expect.arrayContaining(["bug", "Feature request", "l47"]),
  });
});

it("parses a backfill limit from 1 to 100", () => {
  expect(parseBackfillLimit(form([["backfill_limit", "1"]]))).toBe(1);
  expect(parseBackfillLimit(form([["backfill_limit", "100"]]))).toBe(100);
  for (const bad of ["0", "101", "-1", "2.5", "", "1e1", "007x"])
    expect(() => parseBackfillLimit(form([["backfill_limit", bad]])), bad).toThrow(
      "Invalid settings",
    );
  expect(() => parseBackfillLimit(form([]))).toThrow("Invalid settings");
});

it("rejects invalid settings forms", () => {
  const cases: [string, string][][] = [
    [["comment_prompt", "x".repeat(2001)]],
    [["allowed_labels", "review:80+"]],
    [["allowed_labels", "Review: high"]],
    [["allowed_labels", ""]],
    [["allowed_labels", "x".repeat(101)]],
    Array.from(
      { length: 51 },
      (_, i) => ["allowed_labels", `l${i}`] as [string, string],
    ),
    [["issues_enabled", "true"]],
    [["prs_enabled", "on"], ["prs_enabled", "on"]],
  ];
  for (const c of cases)
    expect(() => parseSettingsForm(form(c)), JSON.stringify(c).slice(0, 80)).toThrow(
      "Invalid settings",
    );
});

it("reports whether an LLM key is configured", () => {
  expect(llmConfigured({ ...e, LLM_API_KEY: "k" } as unknown as Env)).toBe(true);
  expect(llmConfigured({ ...e, LLM_API_KEY: "" } as unknown as Env)).toBe(false);
  expect(llmConfigured({ ...e, LLM_API_KEY: undefined } as unknown as Env)).toBe(false);
});

it("separates intent and comment provider readiness", () => {
  const jev = { ...e, TRIAGE_PROVIDER: "jev", OPENROUTER_API_KEY: "test", LLM_API_KEY: undefined } as Env;
  expect(triageConfigured(jev)).toBe(true);
  expect(llmConfigured(jev)).toBe(false);
  expect(triageConfigured({ ...jev, OPENROUTER_API_KEY: undefined, LLM_API_KEY: "test" })).toBe(false);
  expect(triageConfigured({ ...jev, JEV_THRESHOLD: "bad" })).toBe(false);
  expect(triageConfigured({ ...jev, TRIAGE_PROVIDER: "unknown" })).toBe(false);
  expect(triageConfigured({ ...e, LLM_API_KEY: "test" } as Env)).toBe(true);
});

describe("repository ownership changes", () => {
  const optedIn = { ...DEFAULT_SETTINGS, commentsEnabled: true, triageEnabled: true,
    commentPrompt: "Old owner prompt", allowedLabels: ["bug"] };
  it("keeps preferences for rename/reinstall but defaults on transfer", async () => {
    await putSettings(e, 10, 100, "OldOwner/repo", optedIn, "admin");
    await putBackfillLimit(e, 10, 100, "OldOwner/repo", 80, "admin");
    expect(await getSettings(e, 100, "OLDOWNER/renamed")).toMatchObject({ ...optedIn, backfillLimit: 80 });
    expect(await getSettings(e, 100, "NewOwner/repo")).toEqual(DEFAULT_SETTINGS);
    await putSettings(e, 11, 100, "OldOwner/renamed", optedIn, "admin");
    expect(await getSettings(e, 100, "oldowner/renamed")).toMatchObject({ ...optedIn, backfillLimit: 80 });
  });
  it("manual backfill after transfer does not adopt old AI opt-ins", async () => {
    await putSettings(e, 10, 100, "OldOwner/repo", optedIn, "admin");
    await putBackfillLimit(e, 11, 100, "NewOwner/repo", 30, "new-admin");
    expect(await getSettings(e, 100, "NewOwner/repo")).toEqual({ ...DEFAULT_SETTINGS, backfillLimit: 30 });
  });
  it("a new owner's save resets the old backfill limit", async () => {
    await putSettings(e, 10, 100, "OldOwner/repo", optedIn, "admin");
    await putBackfillLimit(e, 10, 100, "OldOwner/repo", 80, "admin");
    await putSettings(e, 11, 100, "NewOwner/repo", DEFAULT_SETTINGS, "new-admin");
    expect(await getSettings(e, 100, "NewOwner/repo")).toEqual(DEFAULT_SETTINGS);
  });
});
