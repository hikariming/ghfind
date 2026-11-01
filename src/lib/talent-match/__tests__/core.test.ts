import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { admitReport, monthWindow, parseTokenBudget, quotaFor, type AdmissionInput } from "../quota";
import {
  canonicalizeRequirementSkills,
  canonicalizeSkills,
  extractedProfileSchema,
  extractedRequirementSchema,
} from "../schema";
import { OTHER_SKILL, SKILLS, isSkillId, resolveSkill, skillLabel, skillVocabulary } from "../taxonomy";

describe("taxonomy", () => {
  it("has unique ids and resolves ids, labels, Chinese labels and aliases", () => {
    expect(new Set(SKILLS.map((s) => s.id)).size).toBe(SKILLS.length);
    expect(isSkillId(OTHER_SKILL)).toBe(false);
    expect(resolveSkill("C++")).toBe("cpp");
    expect(resolveSkill("Jupyter Notebook")).toBe("python");
    expect(resolveSkill("LLM_Inference")).toBe("llm-inference");
    expect(resolveSkill("vLLM")).toBe("llm-inference");
    expect(resolveSkill("分布式训练")).toBe("distributed-training");
    expect(resolveSkill("Megatron-LM")).toBe("distributed-training");
    expect(resolveSkill("cobol")).toBeNull();
  });

  it("labels skills per language and lists the vocabulary for prompts", () => {
    expect(skillLabel("distributed-training", true)).toBe("分布式训练");
    expect(skillLabel("python", true)).toBe("Python");
    expect(skillLabel("unknown-id")).toBe("unknown-id");
    expect(skillVocabulary()).toContain("llm-inference: LLM inference");
  });
});

describe("canonicalizeSkills", () => {
  it("resolves aliases, keeps the highest duplicate level and maps unknowns to other", () => {
    const result = canonicalizeSkills([
      { id: "golang", level: 2, evidence: "a" },
      { id: "go", level: 3, evidence: "b" },
      { id: "COBOL", level: 4, evidence: "c" },
    ]);
    expect(result.skills).toEqual([
      { id: "go", level: 3, evidence: "b" },
      { id: OTHER_SKILL, level: 4, evidence: "c", name: "COBOL" },
    ]);
    expect(result.unknown).toEqual(["COBOL"]);
  });

  it("drops unknown requirement skills", () => {
    expect(canonicalizeRequirementSkills([{ id: "torch", level: 3 }, { id: "fortran-77", level: 2 }])).toEqual({
      skills: [{ id: "pytorch", level: 3 }],
      unknown: ["fortran-77"],
    });
  });
});

describe("extraction schemas", () => {
  it("accept a well-formed candidate and requirement, filling defaults", () => {
    const profile = extractedProfileSchema.parse({
      name: "Lin",
      headline: { zh: "推理工程师", en: "Inference engineer" },
      direction: "ai",
      years: 4,
      skills: [{ id: "python", level: 4, evidence: "résumé" }],
      experience: [{ title: "Engineer", detail: "" }],
      research: [{ title: "Paper", detail: "" }],
      education: [{ degree: "master", school: "X", field: "CS" }],
    });
    expect(profile.research[0]).toMatchObject({ venue: "", firstAuthor: false, topVenue: false });
    expect(extractedRequirementSchema.safeParse({
      title: { zh: "推理工程师", en: "Inference engineer" },
      direction: "ai",
      yearsMin: 3,
      location: "Beijing",
      employment: ["full_time"],
      mustHave: [{ id: "cuda", level: 3 }],
      niceToHave: [],
      degree: "none",
      research: "preferred",
    }).success).toBe(true);
  });

  it("reject out-of-range levels and unknown directions", () => {
    const base = { name: "", headline: { zh: "", en: "" }, years: 1, skills: [], experience: [], research: [], education: [] };
    expect(extractedProfileSchema.safeParse({ ...base, direction: "astrology" }).success).toBe(false);
    expect(extractedProfileSchema.safeParse({ ...base, direction: "ai", skills: [{ id: "go", level: 9, evidence: "" }] }).success).toBe(false);
  });
});

describe("quota", () => {
  const now = Date.UTC(2026, 9, 12, 8);
  const input = (over: Partial<AdmissionInput> = {}): AdmissionInput => ({
    doneThisMonth: 0, inFlight: 0, byoKey: false, monthTokens: 0, monthTokenBudget: null, ...over,
  });

  it("uses the UTC calendar month, including December rollover", () => {
    expect(monthWindow(now)).toEqual({ start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 10, 1) });
    expect(monthWindow(Date.UTC(2026, 11, 31, 23)).end).toBe(Date.UTC(2027, 0, 1));
    expect(quotaFor(5, now)).toEqual({ used: 2, limit: 2, resetsAt: "2026-11-01T00:00:00.000Z" });
  });

  it("admits within quota and rejects exhausted quota, in-flight reports and spent budgets", () => {
    expect(admitReport(input())).toEqual({ ok: true });
    expect(admitReport(input({ doneThisMonth: 2 }))).toEqual({ ok: false, reason: "quota_exhausted" });
    expect(admitReport(input({ inFlight: 1, byoKey: true }))).toEqual({ ok: false, reason: "in_flight" });
    expect(admitReport(input({ monthTokens: 100, monthTokenBudget: 100 }))).toEqual({ ok: false, reason: "budget_exhausted" });
  });

  it("lets a user's own key bypass the monthly limit and global budget", () => {
    expect(admitReport(input({ byoKey: true, doneThisMonth: 9, monthTokenBudget: 0 }))).toEqual({ ok: true });
  });

  it("fails closed on an invalid budget", () => {
    expect(parseTokenBudget(undefined)).toBeNull();
    expect(parseTokenBudget(" ")).toBeNull();
    expect(parseTokenBudget("2000000")).toBe(2_000_000);
    expect(parseTokenBudget("2m")).toBe(0);
    expect(admitReport(input({ monthTokenBudget: parseTokenBudget("-1") }))).toEqual({ ok: false, reason: "budget_exhausted" });
  });
});

describe("0025_talent_match migration", () => {
  it("applies after the jobs schema, enforces checks and cascades job deletes", async () => {
    const db = createClient({ url: "file::memory:" });
    try {
      await db.execute("PRAGMA foreign_keys = ON");
      for (const name of ["0020_jobs.sql", "0025_talent_match.sql"]) {
        await db.executeMultiple(readFileSync(new URL(`../../../../migrations/${name}`, import.meta.url), "utf8"));
      }
      const job = (await db.execute("SELECT id FROM jobs LIMIT 1")).rows[0].id as string;
      await db.execute({ sql: "INSERT INTO job_requirements VALUES (?, ?, '{}', 'h', NULL, 1, 0)", args: [`req-${job}`, job] });
      await db.execute({ sql: "DELETE FROM job_translations WHERE job_id = ?", args: [job] });
      await db.execute({ sql: "DELETE FROM jobs WHERE id = ?", args: [job] });
      expect((await db.execute("SELECT COUNT(*) AS n FROM job_requirements")).rows[0].n).toBe(0);
      await expect(db.execute(
        "INSERT INTO talent_reports (id, github_id, kind, input_hash, status, match_version, created_at, updated_at) VALUES ('r', 1, 'candidate', 'h', 'pending', 1, 0, 0)",
      )).rejects.toThrow(/CHECK/);
      const plan = await db.execute(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM talent_reports WHERE github_id = 1 AND kind = 'candidate'",
      );
      expect(plan.rows.some((row) => String(row.detail).includes("idx_talent_reports_quota"))).toBe(true);
      const month = await db.execute(
        "EXPLAIN QUERY PLAN SELECT SUM(tokens_in) FROM talent_reports WHERE byo_key = 0 AND created_at >= 0 AND created_at < 1",
      );
      expect(month.rows.some((row) => String(row.detail).includes("idx_talent_reports_month"))).toBe(true);
    } finally {
      db.close();
    }
  });
});
