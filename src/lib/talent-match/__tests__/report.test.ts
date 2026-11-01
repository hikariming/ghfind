import { describe, expect, it, vi } from "vitest";
import {
  adviceMessages,
  assembleCandidateReport,
  commonGaps,
  gapKey,
  gapLabel,
  generateAdvice,
  sanitizeAdvice,
  type Advice,
  type AdviceInput,
  type ScoredJob,
} from "../report";
import {
  EMBEDDING_DIMENSIONS,
  embed,
  pickGrowthProjects,
  profileEmbeddingText,
  recallJobIds,
  type GrowthProject,
  type VectorizeLike,
} from "../retrieve";
import type { ExtractedRequirement, StoredProfile } from "../schema";
import { scoreMatch } from "../score";

const profile: StoredProfile = {
  login: "lin",
  name: "Lin",
  headline: { zh: "推理工程师", en: "Inference engineer" },
  direction: "ai",
  years: 4,
  skills: [
    { id: "python", level: 4, evidence: "GitHub · Python 62%", source: "verified" },
    { id: "other", level: 2, evidence: "résumé", source: "claimed", name: "COBOL" },
  ],
  experience: [{ title: "Engineer · Cloud", detail: "2023–", source: "claimed" }],
  research: [],
  education: [{ degree: "master", school: "Tsinghua", field: "CS", source: "claimed" }],
  preferences: { location: "Beijing", remote: true, employment: ["full_time", "intern"] },
};

const requirement = (mustHave: ExtractedRequirement["mustHave"]): ExtractedRequirement => ({
  title: { zh: "推理工程师", en: "Inference engineer" }, direction: "ai", yearsMin: null, location: "",
  employment: [], mustHave, niceToHave: [], degree: "none", research: "none",
});

const job = (id: string, mustHave: ExtractedRequirement["mustHave"]): ScoredJob => {
  const req = requirement(mustHave);
  return {
    job: { id, company: `Co ${id}`, title: { zh: `岗位 ${id}`, en: `Role ${id}` }, location: { zh: "北京", en: "Beijing" }, requirement: req },
    score: scoreMatch(profile, req),
  };
};

const scored = [
  job("a", [{ id: "python", level: 3 }]),
  job("b", [{ id: "python", level: 3 }, { id: "cuda", level: 3 }]),
  job("c", [{ id: "cuda", level: 2 }, { id: "rust", level: 2 }]),
];

const project = (fullName: string, topics: string[], language: string | null = null): GrowthProject => ({
  repoKey: fullName, fullName, summary: "s", language, topics, productScore: 1, stars: 0,
});

describe("gaps", () => {
  it("keys and labels gaps in both languages", () => {
    const [cuda] = scored[1].score.gaps;
    expect(gapKey(cuda)).toBe("skill:cuda");
    expect(gapLabel(cuda)).toEqual({ zh: "CUDA", en: "CUDA" });
    expect(gapLabel({ kind: "skill", skillId: "distributed-training", required: 3, have: 2, mustHave: true, cost: "low" }))
      .toEqual({ zh: "分布式训练 提升到 3 级", en: "Distributed training to level 3" });
    expect(gapLabel({ kind: "experience", required: 5, have: 2, cost: "high" }).en).toBe("5+ years of experience");
  });

  it("orders common gaps by frequency across matches", () => {
    expect(commonGaps(scored).map(gapKey)).toEqual(["skill:cuda", "skill:rust"]);
  });
});

describe("growth projects", () => {
  it("picks projects whose language or topics resolve to a gap, capped per gap", () => {
    const gaps = commonGaps(scored);
    const picked = pickGrowthProjects(gaps, [
      project("x/cuda1", ["cuda"]),
      project("x/none", ["web"]),
      project("x/rust", [], "Rust"),
      project("x/cuda2", ["gpu", "CUDA"]),
      project("x/cuda3", ["cuda"]),
    ]);
    expect(picked.map((p) => [p.project.fullName, p.closes])).toEqual([
      ["x/cuda1", ["cuda"]],
      ["x/rust", ["rust"]],
      ["x/cuda2", ["cuda"]],
    ]);
    expect(pickGrowthProjects([], [project("x/cuda1", ["cuda"])])).toEqual([]);
  });
});

const advice: Advice = {
  summary: { zh: "总结", en: "Summary" },
  strengths: [{ zh: "Python", en: "Python" }],
  reasons: [
    { jobId: "a", reason: { zh: "适合", en: "Fits" } },
    { jobId: "invented", reason: { zh: "x", en: "x" } },
  ],
  growth: [
    { kind: "open_source", title: { zh: "贡献", en: "Contribute" }, detail: { zh: "d", en: "d" }, repo: "x/cuda1", closes: ["skill:cuda", "skill:made-up"], horizon: { zh: "1 个月", en: "1 month" } },
    { kind: "open_source", title: { zh: "假仓库", en: "Fake" }, detail: { zh: "d", en: "d" }, repo: "evil/repo", closes: [], horizon: { zh: "1", en: "1" } },
    { kind: "skill", title: { zh: "学 Rust", en: "Learn Rust" }, detail: { zh: "d", en: "d" }, repo: "evil/repo", closes: ["skill:rust"], horizon: { zh: "2", en: "2" } },
  ],
};

const adviceInput = (): AdviceInput => {
  const gaps = commonGaps(scored);
  return { profile, matches: scored, gaps, projects: pickGrowthProjects(gaps, [project("x/cuda1", ["cuda"])]) };
};

describe("advice", () => {
  it("gives the model only facts and rules against invention", () => {
    const [system, user] = adviceMessages(adviceInput());
    expect(system.content).toContain("never invent");
    const facts = JSON.parse(user.content);
    expect(facts.jobs.map((j: { jobId: string }) => j.jobId)).toEqual(["a", "b", "c"]);
    expect(facts.repositories).toEqual([{ repo: "x/cuda1", summary: "s", language: null, closes: ["skill:cuda"] }]);
    expect(JSON.stringify(facts)).not.toContain("Tsinghua");
  });

  it("drops invented jobs, repositories and gap keys", () => {
    const clean = sanitizeAdvice(advice, adviceInput());
    expect(clean.reasons.map((r) => r.jobId)).toEqual(["a"]);
    expect(clean.growth.map((g) => [g.title.en, g.repo, g.closes])).toEqual([
      ["Contribute", "x/cuda1", ["skill:cuda"]],
      ["Learn Rust", null, ["skill:rust"]],
    ]);
  });

  it("validates and sanitizes the model reply", async () => {
    const complete = vi.fn(async () => JSON.stringify(advice));
    const { advice: result, usage } = await generateAdvice(complete, adviceInput());
    expect(result.reasons).toHaveLength(1);
    expect(usage.tokensIn).toBeGreaterThan(0);
  });
});

describe("assembleCandidateReport", () => {
  it("builds the frontend contract with ranked matches, fallback reasons and whitelisted growth", () => {
    const input = adviceInput();
    const projects = input.projects.map((p) => ({ ...p, project: { ...p.project, stars: 1200 } }));
    const dimensions = { account_maturity: 8, original_project_quality: 12, contribution_quality: 17, ecosystem_impact: 9, community_influence: 4, activity_authenticity: 15 };
    const report = assembleCandidateReport({
      id: "r1", createdAt: Date.UTC(2026, 9, 12), matchVersion: 1, profile, dimensions,
      scored, gaps: input.gaps, projects, advice: sanitizeAdvice(advice, { ...input, projects }),
    });
    expect(report.createdAt).toBe("2026-10-12T00:00:00.000Z");
    expect(report.matches.map((m) => [m.jobId, m.fit])).toEqual([["a", 63], ["b", 60], ["c", 28]]);
    expect(report.matches[0].reason.en).toBe("Fits");
    expect(report.matches[1].reason.en).toBe("Meets 1 of 2 skill requirements");
    expect(report.matches[1].gaps).toEqual([{ label: { zh: "CUDA", en: "CUDA" }, kind: "skill", cost: "medium" }]);
    expect(report.growth[0]).toMatchObject({ repo: { fullName: "x/cuda1", stars: 1200, language: "" }, closes: [{ zh: "CUDA", en: "CUDA" }] });
    expect(report.growth[1].repo).toBeUndefined();
    expect(report.profile).toMatchObject({
      direction: { zh: "AI 与模型基础设施", en: "AI & model infrastructure" },
      dimensions,
      preferences: { employment: { zh: "全职 / 实习", en: "Full-time / Internship" } },
    });
    expect(report.profile.skills.map((s) => s.label)).toEqual(["Python", "COBOL"]);
    expect(report.profile.education[0].detail.en).toBe("Master's degree · CS");
  });
});

describe("embeddings and recall", () => {
  it("validates the embedding shape", async () => {
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1);
    expect(await embed({ run: async () => ({ data: [vector] }) }, "x")).toEqual(vector);
    await expect(embed({ run: async () => ({ data: [[1, 2]] }) }, "x")).rejects.toThrow(/bge-m3/);
  });

  it("embeds known skills only and recalls job ids filtered by kind", async () => {
    const text = profileEmbeddingText(profile);
    expect(text).toContain("Python (4)");
    expect(text).not.toContain("COBOL");
    const query = vi.fn<VectorizeLike["query"]>(async () => ({ matches: [{ id: "job:j1", score: 0.9 }, { id: "talent:3", score: 0.8 }] }));
    const index: VectorizeLike = { query, upsert: vi.fn(), deleteByIds: vi.fn() };
    expect(await recallJobIds(index, [0.1])).toEqual(["j1"]);
    expect(query).toHaveBeenCalledWith([0.1], { topK: 50, filter: { kind: "job" }, returnMetadata: "none" });
  });
});
