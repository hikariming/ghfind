import { describe, expect, it } from "vitest";
import {
  MATCH_VERSION,
  rankMatches,
  reachOf,
  requirementSpecificity,
  scoreMatch,
  type MatchCandidate,
  type MatchRequirement,
} from "../score";

const candidate = (over: Partial<MatchCandidate> = {}): MatchCandidate => ({
  years: 4,
  skills: [
    { id: "python", level: 4, source: "verified", evidence: "" },
    { id: "llm-inference", level: 3, source: "verified", evidence: "" },
    { id: "cuda", level: 2, source: "claimed", evidence: "" },
  ],
  education: [{ degree: "master", school: "", field: "", source: "claimed" }],
  research: [],
  ...over,
});

const requirement = (over: Partial<MatchRequirement> = {}): MatchRequirement => ({
  yearsMin: null,
  mustHave: [],
  niceToHave: [],
  degree: "none",
  research: "none",
  ...over,
});

describe("scoreMatch", () => {
  it("scores a fully met, fully specific verified requirement at 100 with high reach", () => {
    const skills = [
      { id: "python", level: 4, source: "verified" as const, evidence: "" },
      { id: "llm-inference", level: 4, source: "verified" as const, evidence: "" },
    ];
    const score = scoreMatch(candidate({ skills }), requirement({
      yearsMin: 3,
      mustHave: [{ id: "python", level: 4 }, { id: "llm-inference", level: 4 }],
      degree: "bachelor",
    }));
    expect(score).toMatchObject({
      matchVersion: MATCH_VERSION,
      fit: 100,
      reach: "high",
      breakdown: { mustHave: 100, niceToHave: 100, conditions: 100 },
      specificity: 1,
      matched: ["python", "llm-inference"],
      gaps: [],
      verifiedShare: 1,
    });
  });

  it("weights claimed evidence at 0.7 and partial levels proportionally", () => {
    const score = scoreMatch(candidate(), requirement({
      mustHave: [{ id: "cuda", level: 2 }, { id: "python", level: 4 }],
      niceToHave: [{ id: "llm-inference", level: 4 }],
    }));
    // cuda: claimed 0.7; python: 1 → 85. nice: 3/4 → 75. conditions: none → 100.
    expect(score.breakdown).toEqual({ mustHave: 85, niceToHave: 75, conditions: 100 });
    expect(score.fit).toBe(Math.round(0.6 * 85 + 0.2 * 75 + 0.2 * 100));
    expect(score.verifiedShare).toBe(0.5);
    expect(score.gaps).toEqual([
      { kind: "skill", skillId: "llm-inference", required: 4, have: 3, mustHave: false, cost: "low" },
    ]);
    // A nice-to-have gap never blocks reach.
    expect(score.reach).toBe("high");
  });

  it("caps fit at 60 when a must-have is absent, and marks it medium cost", () => {
    const score = scoreMatch(candidate(), requirement({
      mustHave: [{ id: "python", level: 4 }, { id: "llm-inference", level: 3 }, { id: "distributed-training", level: 3 }],
    }));
    // must 67, nice none → 100, conditions 100: 80 uncapped, fully specific.
    expect(score.breakdown.mustHave).toBe(67);
    expect(score.fit).toBe(60);
    expect(score.gaps).toEqual([
      { kind: "skill", skillId: "distributed-training", required: 3, have: 0, mustHave: true, cost: "medium" },
    ]);
    expect(score.reach).toBe("medium");
  });

  it("applies the cap even when the uncapped fit would be higher", () => {
    const score = scoreMatch(candidate(), requirement({
      mustHave: [{ id: "python", level: 1 }, { id: "llm-inference", level: 1 }, { id: "python", level: 1 }, { id: "rust", level: 1 }],
    }));
    expect(score.fit).toBeLessThanOrEqual(60);
  });

  it("treats a skill listed as both must and nice as must only", () => {
    const score = scoreMatch(candidate(), requirement({
      mustHave: [{ id: "python", level: 4 }],
      niceToHave: [{ id: "python", level: 4 }],
    }));
    expect(score.matched).toEqual(["python"]);
    expect(score.breakdown.niceToHave).toBe(100);
  });

  it("scores years, degree and required research as conditions", () => {
    const score = scoreMatch(candidate({ years: 2 }), requirement({ yearsMin: 5, degree: "phd", research: "required" }));
    // years 2/5 = 0.4, degree 0, research 0 → 13.
    expect(score.breakdown.conditions).toBe(13);
    expect(score.gaps).toEqual([
      { kind: "experience", required: 5, have: 2, cost: "high" },
      { kind: "education", degree: "phd", cost: "high" },
      { kind: "research", required: true, cost: "high" },
    ]);
    expect(score.reach).toBe("low");
  });

  it("gives half credit for non-top research when research is required", () => {
    const research = [{ title: "Paper", detail: "", venue: "Workshop", firstAuthor: true, topVenue: false, source: "claimed" as const }];
    expect(scoreMatch(candidate({ research }), requirement({ research: "required" })).breakdown.conditions).toBe(50);
  });

  it("lists preferred research as a gap without lowering fit or reach", () => {
    const mustHave = [{ id: "python", level: 4 }, { id: "llm-inference", level: 3 }, { id: "cuda", level: 1 }];
    const score = scoreMatch(candidate(), requirement({ mustHave, research: "preferred" }));
    expect(score.fit).toBe(scoreMatch(candidate(), requirement({ mustHave })).fit);
    expect(score.reach).toBe("high");
    expect(score.gaps).toEqual([{ kind: "research", required: false, cost: "high" }]);
  });

  it("rates a short experience gap as medium", () => {
    const score = scoreMatch(candidate({ years: 3 }), requirement({ yearsMin: 5 }));
    expect(score.gaps).toEqual([{ kind: "experience", required: 5, have: 3, cost: "medium" }]);
    expect(score.reach).toBe("medium");
  });

  it("uses the stronger entry when a candidate lists a skill twice", () => {
    const skills = [
      { id: "go", level: 2, source: "claimed" as const, evidence: "" },
      { id: "go", level: 2, source: "verified" as const, evidence: "" },
    ];
    expect(scoreMatch(candidate({ skills }), requirement({ mustHave: [{ id: "go", level: 2 }] })).breakdown.mustHave).toBe(100);
  });
});

describe("reachOf", () => {
  it("is high with no gaps and medium for a two-level skill gap", () => {
    expect(reachOf([])).toBe("high");
    expect(reachOf([{ kind: "skill", skillId: "go", required: 3, have: 1, mustHave: true, cost: "medium" }])).toBe("medium");
  });
});

describe("rankMatches", () => {
  it("orders by fit, then reach, then id", () => {
    const base = scoreMatch(candidate(), requirement());
    const ranked = rankMatches([
      { id: "c", score: { ...base, fit: 80, reach: "low" as const } },
      { id: "b", score: { ...base, fit: 80, reach: "high" as const } },
      { id: "a", score: { ...base, fit: 80, reach: "high" as const } },
      { id: "d", score: { ...base, fit: 90, reach: "low" as const } },
    ]);
    expect(ranked.map((m) => m.id)).toEqual(["d", "a", "b", "c"]);
  });

  it("orders roles sharing the must-have cap by their uncapped fit", () => {
    const base = scoreMatch(candidate(), requirement());
    const ranked = rankMatches([
      { id: "a", score: { ...base, fit: 60, uncappedFit: 60 } },
      { id: "b", score: { ...base, fit: 60, uncappedFit: 72 } },
    ]);
    expect(ranked.map((m) => m.id)).toEqual(["b", "a"]);
  });
});

describe("sparse and non-engineering roles", () => {
  it("rates specificity by skill levels, with nice-to-haves and soft skills at half", () => {
    expect(requirementSpecificity(requirement({ mustHave: [{ id: "llm-inference", level: 3 }, { id: "python", level: 3 }, { id: "cuda", level: 2 }] }))).toBe(1);
    expect(requirementSpecificity(requirement({ mustHave: [{ id: "python", level: 3 }] }))).toBe(3 / 8);
    // HR copy extracted to soft skills: team-leadership (practice) and prompt-engineering.
    expect(requirementSpecificity(requirement({
      mustHave: [{ id: "team-leadership", level: 1 }],
      niceToHave: [{ id: "prompt-engineering", level: 1 }],
    }))).toBe((0.5 + 0.25) / 8);
  });

  it("does not treat an empty must-have list as fully met", () => {
    const score = scoreMatch(candidate(), requirement({ niceToHave: [{ id: "rust", level: 2 }, { id: "go", level: 2 }] }));
    // Core and nice both 0, conditions 100 → 20, scaled by specificity and no domain evidence.
    expect(score.fit).toBeLessThan(20);
  });

  it("ranks a sparse soft-skill role below a specific role with one missing must-have", () => {
    const hr = scoreMatch(candidate({ skills: [...candidate().skills, { id: "technical-writing", level: 2, source: "verified", evidence: "" }] }), requirement({
      niceToHave: [{ id: "technical-writing", level: 1 }],
    }));
    const inference = scoreMatch(candidate(), requirement({
      mustHave: [{ id: "llm-inference", level: 3 }, { id: "python", level: 3 }, { id: "distributed-systems", level: 2 }],
    }));
    expect(inference.fit).toBe(60);
    expect(hr.fit).toBeLessThan(50);
  });

  it("discounts a role whose only match is a language", () => {
    const req = requirement({ mustHave: [{ id: "python", level: 3 }, { id: "kubernetes", level: 2 }] });
    const withDomain = scoreMatch(candidate({ skills: [...candidate().skills, { id: "kubernetes", level: 1, source: "verified", evidence: "" }] }), req);
    const languageOnly = scoreMatch(candidate(), req);
    expect(languageOnly.breakdown.mustHave).toBe(50);
    expect(languageOnly.fit).toBeLessThan(withDomain.fit);
  });
});
