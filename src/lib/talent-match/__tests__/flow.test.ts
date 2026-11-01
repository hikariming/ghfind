import { createClient, type Client } from "@libsql/client";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/lib/llm";
import type { ExtractedRequirement } from "../schema";

const mocks = vi.hoisted(() => ({
  db: null as Client | null,
  workflow: { create: vi.fn() },
  user: { githubId: 7, login: "lin" } as { githubId: number; login: string } | null,
  rateLimited: false,
}));

vi.mock("../http", async (original) => ({
  ...(await original<typeof import("../http")>()),
  sessionUser: async () => mocks.user,
  coreDb: () => mocks.db,
  reportWorkflow: () => mocks.workflow,
}));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: async (token: string | null) => token !== "bad" }));
// Uploaded PDFs are extracted inside the POST; route that through the fake model.
vi.mock("../extract", async (original) => ({
  ...(await original<typeof import("../extract")>()),
  llmCompleter: () => (messages: ChatMessage[]) => complete(messages),
}));
vi.mock("@/lib/redis", async (original) => ({
  ...(await original<typeof import("@/lib/redis")>()),
  checkTalentReportRateLimit: async () => (mocks.rateLimited ? { success: false, limit: 1, remaining: 0, reset: Date.now() + 1000 } : { success: true }),
}));

import { GET as getLatest, POST } from "@/app/api/talent-match/reports/route";
import { GET as getReport } from "@/app/api/talent-match/reports/[id]/route";
import { GET as getQuota } from "@/app/api/talent-match/quota/route";
import { DELETE as deleteProfile, GET as getProfileRoute, PUT as putProfile } from "@/app/api/talent-match/profile/route";
import {
  candidateInputHash,
  failReport,
  jobsNeedingSync,
  jobsRevision,
  loadResumeText,
  runAdvise,
  runExtract,
  runFinish,
  runMatch,
  runVerify,
  syncJobRequirement,
  type CandidateParams,
} from "../pipeline";
import { getOwnReport, getProfile, upsertJobRequirement, upsertProfile, updateReport } from "../store";

const core = createClient({ url: "file::memory:" });
const feed = createClient({ url: ":memory:" });

async function migrate(db: Client, dir: string) {
  const url = new URL(`../../../../${dir}/`, import.meta.url);
  for (const name of readdirSync(url).filter((n) => n.endsWith(".sql")).sort()) {
    await db.executeMultiple(readFileSync(new URL(name, url), "utf8"));
  }
}

const library = {
  version: 1,
  resumes: [{
    id: "r1", name: "CV", template: "modern", updatedAt: "2026-10-01T00:00:00Z",
    basics: { name: "Lin", role: "Inference engineer", email: "lin@example.com", phone: "", city: "Beijing", website: "", summary: "LLM serving" },
    sections: [{ id: "s", type: "experience", title: "Experience", entries: [{ id: "e", title: "Cloud", subtitle: "Engineer", period: "2023–", details: "vLLM scheduler" }] }],
  }],
};

const extraction = {
  name: "Lin", headline: { zh: "推理工程师", en: "Inference engineer" }, direction: "ai", years: 4,
  skills: [{ id: "python", level: 4, evidence: "résumé" }, { id: "cuda", level: 2, evidence: "résumé" }],
  experience: [{ title: "Engineer · Cloud", detail: "2023–" }], research: [], education: [{ degree: "master", school: "X", field: "CS" }],
};

const requirement: ExtractedRequirement = {
  title: { zh: "推理工程师", en: "Inference engineer" }, direction: "ai", yearsMin: 3, location: "Beijing",
  employment: ["full_time"], mustHave: [{ id: "python", level: 3 }, { id: "cuda", level: 3 }], niceToHave: [], degree: "none", research: "none",
};

/** Fake model: extraction for the résumé prompt, advice for the report prompt. */
const prompts: string[] = [];
let extractionReply: () => string = () => JSON.stringify(extraction);
const complete = vi.fn(async (messages: ChatMessage[]) => {
  prompts.push(messages.map((m) => m.content).join("\n"));
  if (messages[0].content.includes("extract a candidate profile")) return extractionReply();
  const facts = JSON.parse(messages[1].content);
  return JSON.stringify({
    summary: { zh: "总结", en: "Summary" },
    strengths: [],
    reasons: facts.jobs.map((j: { jobId: string }) => ({ jobId: j.jobId, reason: { zh: "理由", en: "Reason" } })),
    growth: facts.repositories.map((r: { repo: string; closes: string[] }) => ({
      kind: "open_source", title: { zh: "贡献", en: "Contribute" }, detail: { zh: "d", en: "d" }, repo: r.repo, closes: r.closes, horizon: { zh: "1 个月", en: "1 month" },
    })),
  });
});

let jobId = "";

beforeAll(async () => {
  await migrate(core, "migrations");
  await migrate(feed, "migrations-feed");
  mocks.db = core;
  await core.execute({ sql: "INSERT INTO user_resume_libraries (github_id, login, data, updated_at) VALUES (7, 'lin', ?, 0)", args: [JSON.stringify(library)] });
  jobId = String((await core.execute("SELECT id FROM jobs WHERE status = 'open' AND company_id = 'deepseek' ORDER BY id LIMIT 1")).rows[0].id);
  await upsertJobRequirement(core, { jobId, requirement, inputHash: "h", vectorId: null, now: 1 });
  await feed.execute(`INSERT INTO feed_projects (repo_key, analysis_id, owner_login, name, canonical_url, summary, language, topics_json,
    project_type, lifecycle, product_score, confidence, verification_level, exposure_band, analyzed_at, risks_json, published, source_hash, projected_at)
    VALUES ('nvidia/cutlass', 'a', 'nvidia', 'cutlass', '', 'CUDA templates', 'C++', '["cuda"]', 'library', 'active', 0.9, 1, 'x', 'x', 0, '[]', 1, 'h', 0)`);
  await core.execute("INSERT INTO repos (repo_key, name_with_owner, owner_login, name, stars, topics, updated_at) VALUES ('nvidia/cutlass', 'NVIDIA/cutlass', 'nvidia', 'cutlass', 7000, '[]', 0)");
});
afterAll(() => { core.close(); feed.close(); });
beforeEach(async () => {
  await core.executeMultiple("DELETE FROM talent_reports; DELETE FROM talent_match_profiles;");
  mocks.workflow.create.mockReset();
  mocks.user = { githubId: 7, login: "lin" };
  mocks.rateLimited = false;
  prompts.length = 0;
  extractionReply = () => JSON.stringify(extraction);
});

const post = (body: unknown) =>
  POST(new Request("https://ghfind.com/api/talent-match/reports", { method: "POST", body: JSON.stringify(body) }) as never);
const validBody = { source: { kind: "resume", id: "r1" }, preferences: { location: "Beijing", remote: true, employment: ["full_time", "full_time"] }, turnstileToken: "ok" };

describe("candidate pipeline", () => {
  it("runs extract → verify → match → advise → finish into a done report", async () => {
    const now = Date.UTC(2026, 9, 12);
    const params: CandidateParams = {
      reportId: "rep", githubId: 7, login: "lin", source: { kind: "resume", id: "r1" },
      preferences: { location: "Beijing", remote: true, employment: ["full_time"] }, inputHash: "ih", createdAt: now,
    };
    await core.execute({ sql: "INSERT INTO talent_reports (id, github_id, kind, input_hash, status, match_version, created_at, updated_at) VALUES ('rep', 7, 'candidate', 'ih', 'queued', 1, ?, ?)", args: [now, now] });

    const { extracted } = await runExtract(core, complete, params, now);
    const verified = await runVerify(core, params, extracted, "v11", now);
    expect((await getProfile(core, 7))?.profile.login).toBe("lin");
    const match = await runMatch(core, feed, verified.profile, Date.now());
    expect(match.scored.map((s) => s.job.id)).toEqual([jobId]);
    expect(match.projects.map((p) => [p.project.fullName, p.project.stars])).toEqual([["nvidia/cutlass", 7000]]);
    const advice = await runAdvise(core, complete, "rep", verified.profile, match, now);
    const report = await runFinish(core, params, { ...verified, match, advice }, now);

    expect(report.matches[0]).toMatchObject({ jobId, reason: { en: "Reason" } });
    expect(report.growth[0].repo).toEqual({ fullName: "nvidia/cutlass", stars: 7000, language: "C++" });
    const row = await getOwnReport(core, "rep", 7);
    expect(row?.status).toBe("done");
    const tokens = await core.execute("SELECT tokens_in, tokens_out FROM talent_reports WHERE id = 'rep'");
    expect(Number(tokens.rows[0].tokens_in)).toBeGreaterThan(0);
  });

  it("does not match jobs that state no skills (non-engineering roles, title-only listings)", async () => {
    const empty = { ...requirement, mustHave: [], niceToHave: [] };
    const other = String((await core.execute({ sql: "SELECT id FROM jobs WHERE status = 'open' AND company_id = 'deepseek' AND id <> ? ORDER BY id LIMIT 1", args: [jobId] })).rows[0].id);
    await upsertJobRequirement(core, { jobId: other, requirement: empty, inputHash: "e", vectorId: null, now: 1 });
    try {
      const profile = (await runVerify(core, { reportId: "v", githubId: 9, login: "nobody", source: { kind: "profile" }, preferences: { location: "", remote: false, employment: [] }, inputHash: "", createdAt: 0 }, JSON.parse(JSON.stringify(extraction)), "v11", 0)).profile;
      const match = await runMatch(core, null, profile, Date.now());
      expect(match.scored.map((s) => s.job.id)).toEqual([jobId]);
    } finally {
      await core.execute({ sql: "DELETE FROM job_requirements WHERE id = ?", args: [other] });
    }
  });

  it("excludes other employers even when their requirements match perfectly", async () => {
    const other = String((await core.execute("SELECT id FROM jobs WHERE status = 'open' AND company_id <> 'deepseek' ORDER BY id LIMIT 1")).rows[0].id);
    await upsertJobRequirement(core, { jobId: other, requirement: { ...requirement, mustHave: [{ id: "python", level: 1 }] }, inputHash: "other", vectorId: null, now: 1 });
    try {
      const profile = (await runVerify(core, { reportId: "v", githubId: 9, login: "nobody", source: { kind: "profile" }, preferences: { location: "", remote: false, employment: [] }, inputHash: "", createdAt: 0 }, JSON.parse(JSON.stringify(extraction)), "v11", 0)).profile;
      const match = await runMatch(core, null, profile, Date.now());
      expect(match.scored.map((s) => s.job.id)).toEqual([jobId]);
      expect(match.gaps).toEqual(match.scored[0].score.gaps);
    } finally {
      await core.execute({ sql: "DELETE FROM job_requirements WHERE id = ?", args: [other] });
    }
  });

  it("never sends contact details to the model and reports a missing résumé as input error", async () => {
    const text = await loadResumeText(core, 7, { kind: "resume", id: "r1" });
    expect(text).toContain("vLLM scheduler");
    expect(text).not.toContain("lin@example.com");
    expect(await loadResumeText(core, 7, { kind: "resume", id: "nope" })).toBeNull();
    expect(await loadResumeText(core, 7, { kind: "profile" })).toBeNull();
    const params = { reportId: "x", githubId: 7, login: "lin", source: { kind: "profile" as const }, preferences: { location: "", remote: false, employment: [] }, inputHash: "", createdAt: 0 };
    await expect(runExtract(core, complete, params, 0)).rejects.toThrow("resume_missing");
  });

  it("hashes input together with rules and the job board revision", async () => {
    const base = { login: "Lin", resumeText: "cv", preferences: { location: "", remote: false, employment: [] as never[] }, jobsRevision: await jobsRevision(core) };
    expect(candidateInputHash(base)).toBe(candidateInputHash({ ...base, login: "lin" }));
    expect(candidateInputHash(base)).not.toBe(candidateInputHash({ ...base, jobsRevision: "other" }));
  });
});

describe("job requirement sync", () => {
  it("extracts only jobs whose copy changed, and nothing on a second pass", async () => {
    const now = Date.now();
    const pending = await jobsNeedingSync(core, now);
    // The seeded job's requirement was stored with a placeholder hash, so every open job is pending.
    const open = Number((await core.execute("SELECT COUNT(*) AS n FROM jobs WHERE status = 'open'")).rows[0].n);
    expect(pending).toHaveLength(open);
    const job = pending.find((j) => j.id === jobId)!;
    const jd = vi.fn(async () => JSON.stringify({ ...requirement, mustHave: [{ id: "vLLM", level: 3 }, { id: "fortran", level: 2 }] }));
    expect(await syncJobRequirement(core, jd, job, now)).toEqual({ unknownSkills: ["fortran"] });
    expect((await jobsNeedingSync(core, now)).some((j) => j.id === jobId)).toBe(false);
    expect((await jobsNeedingSync(core, now, true)).some((j) => j.id === jobId)).toBe(true);
    // Restore the fixture requirement the other tests score against.
    await upsertJobRequirement(core, { jobId, requirement, inputHash: "h", vectorId: null, now: 1 });
  });
});

describe("POST /api/talent-match/reports", () => {
  it("queues a report and starts the Workflow without résumé text in its params", async () => {
    const res = await post(validBody);
    expect(res.status).toBe(202);
    const { id } = await res.json();
    const [[{ id: instanceId, params }]] = mocks.workflow.create.mock.calls;
    expect(instanceId).toBe(id);
    expect(params).toMatchObject({ reportId: id, githubId: 7, login: "lin", source: { kind: "resume", id: "r1" }, preferences: { employment: ["full_time"] } });
    expect(JSON.stringify(params)).not.toContain("vLLM");
    expect((await post(validBody)).status).toBe(409);
  });

  it("reuses a finished report for identical input instead of spending quota", async () => {
    const { id } = await (await post(validBody)).json();
    await updateReport(core, id, { status: "done", now: Date.now(), result: { ok: true } });
    const res = await post(validBody);
    expect(await res.json()).toEqual({ id, status: "done", reused: true });
    expect(mocks.workflow.create).toHaveBeenCalledTimes(1);
  });

  it("enforces the monthly quota", async () => {
    for (const id of ["a", "b"]) {
      await core.execute({ sql: "INSERT INTO talent_reports (id, github_id, kind, input_hash, status, match_version, created_at, updated_at) VALUES (?, 7, 'candidate', ?, 'done', 1, ?, ?)", args: [id, id, Date.now(), Date.now()] });
    }
    const res = await post(validBody);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "quota_exhausted" });
    const quota = await (await getQuota()).json();
    expect(quota).toMatchObject({ used: 2, limit: 2, inFlight: false });
  });

  it("rejects bad input, failed checks, missing résumés and anonymous callers", async () => {
    expect((await post({ ...validBody, source: { kind: "pdf" } })).status).toBe(400);
    expect((await post({ ...validBody, turnstileToken: "bad" })).status).toBe(403);
    expect((await post({ ...validBody, source: { kind: "resume", id: "missing" } })).status).toBe(400);
    mocks.rateLimited = true;
    expect((await post(validBody)).status).toBe(429);
    mocks.user = null;
    expect((await post(validBody)).status).toBe(401);
    expect(mocks.workflow.create).not.toHaveBeenCalled();
  });

  it("fails the queued report when the Workflow cannot start", async () => {
    mocks.workflow.create.mockRejectedValueOnce(new Error("no workflow"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await post(validBody)).status).toBe(503);
    } finally { error.mockRestore(); }
    const { rows } = await core.execute("SELECT status, error FROM talent_reports");
    expect(rows.map((r) => [r.status, r.error])).toEqual([["failed", "start_failed"]]);
  });
});

describe("PDF résumés", () => {
  const pdfText = [
    "Lin — Inference engineer", "lin@example.com · +86 138 0013 8000", "UNIQUE_RAW_LINE vLLM scheduler work 2021–2023",
    "x".repeat(150),
  ].join("\n");
  const pdfBody = { ...validBody, source: { kind: "pdf", text: pdfText } };

  it("extracts during the request and hands the Workflow only facts, with short retention", async () => {
    const res = await post(pdfBody);
    expect(res.status).toBe(202);
    const [[{ params, retention }]] = mocks.workflow.create.mock.calls;
    expect(params.source.kind).toBe("extracted");
    expect(params.source.profile.name).toBe("Lin");
    expect(JSON.stringify(params)).not.toContain("UNIQUE_RAW_LINE");
    expect(retention).toEqual({ successRetention: "1 day", errorRetention: "1 day" });
    // Contact details never reach the model.
    expect(prompts.join()).toContain("UNIQUE_RAW_LINE");
    expect(prompts.join()).not.toMatch(/lin@example\.com|138 0013 8000/);
    expect(prompts.join()).toContain("2021–2023");
    const tokens = await core.execute("SELECT tokens_in FROM talent_reports");
    expect(Number(tokens.rows[0].tokens_in)).toBeGreaterThan(0);
  });

  it("skips the Workflow's own extraction for uploaded facts", async () => {
    const extracted = await runExtract(core, async () => { throw new Error("must not call the model"); }, {
      reportId: "p", githubId: 7, login: "lin", source: { kind: "extracted", profile: JSON.parse(JSON.stringify(extraction)), unknownSkills: ["cobol"] },
      preferences: { location: "", remote: false, employment: [] }, inputHash: "", createdAt: 0,
    }, 0);
    expect(extracted.unknownSkills).toEqual(["cobol"]);
  });

  it("rejects scans without text, and fails unreadable model output without spending quota", async () => {
    expect(await (await post({ ...validBody, source: { kind: "pdf", text: "   scanned  " } })).json()).toEqual({ error: "pdf_unreadable" });
    extractionReply = () => "not json";
    const res = await post(pdfBody);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "model_output_invalid" });
    expect(mocks.workflow.create).not.toHaveBeenCalled();
    const { rows } = await core.execute("SELECT status, error FROM talent_reports");
    expect(rows.map((r) => [r.status, r.error])).toEqual([["failed", "model_output_invalid"]]);
    expect((await (await getQuota()).json()).used).toBe(0);
  });
});

describe("open to opportunities", () => {
  const put = (body: unknown) =>
    putProfile(new Request("https://ghfind.com/api/talent-match/profile", { method: "PUT", body: JSON.stringify(body) }) as never);

  it("needs a profile, then toggles consent that survives a regenerated profile", async () => {
    expect(await (await getProfileRoute()).json()).toEqual({ profile: null });
    const missing = await put({ optedIn: true });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ error: "profile_missing" });

    const profile = (await runVerify(core, { reportId: "o", githubId: 7, login: "lin", source: { kind: "profile" }, preferences: { location: "", remote: false, employment: [] }, inputHash: "a", createdAt: 0 }, JSON.parse(JSON.stringify(extraction)), "v11", 0)).profile;
    expect(await (await getProfileRoute()).json()).toEqual({ profile: { optedIn: false } });
    expect(await (await put({ optedIn: true })).json()).toEqual({ optedIn: true });
    await upsertProfile(core, { githubId: 7, login: "lin", profile, inputHash: "b", vectorId: null, now: 1 });
    expect(await (await getProfileRoute()).json()).toEqual({ profile: { optedIn: true } });
    expect(await (await put({ optedIn: false })).json()).toEqual({ optedIn: false });
    expect((await getProfile(core, 7))?.optedIn).toBe(false);
  });

  it("rejects bad bodies and anonymous callers", async () => {
    expect((await put({ optedIn: "yes" })).status).toBe(400);
    mocks.user = null;
    expect((await put({ optedIn: true })).status).toBe(401);
    expect((await getProfileRoute()).status).toBe(401);
  });
});

describe("report, quota and profile routes", () => {
  it("returns the caller's latest report and history so the page can resume and reopen them", async () => {
    expect(await (await getLatest()).json()).toEqual({ latest: null, history: [] });
    const { id } = await (await post(validBody)).json();
    expect(await (await getLatest()).json()).toMatchObject({
      latest: { id, status: "queued", report: null },
      history: [{ id, status: "queued", error: null, headline: null, matchCount: 0, topFit: null }],
    });
    mocks.user = { githubId: 8, login: "other" };
    expect(await (await getLatest()).json()).toEqual({ latest: null, history: [] });
  });

  it("shows reports to their owner only, and deletes all talent data", async () => {
    const { id } = await (await post(validBody)).json();
    const ctx = { params: Promise.resolve({ id }) };
    expect(await (await getReport(new Request("https://x") as never, ctx)).json()).toMatchObject({ id, status: "queued", report: null });
    await failReport(core, id, "model_output_invalid", Date.now());
    expect(await (await getReport(new Request("https://x") as never, ctx)).json()).toMatchObject({ status: "failed", error: "model_output_invalid" });
    mocks.user = { githubId: 8, login: "other" };
    expect((await getReport(new Request("https://x") as never, ctx)).status).toBe(404);
    mocks.user = { githubId: 7, login: "lin" };
    expect((await deleteProfile()).status).toBe(204);
    expect((await getReport(new Request("https://x") as never, ctx)).status).toBe(404);
  });
});
