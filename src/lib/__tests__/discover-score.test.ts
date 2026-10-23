import { describe, expect, it } from "vitest";
import {
  DISCOVER_CALIBRATION_KNOTS,
  DISCOVER_PARTITION_WEIGHTS,
  discoverScoreInputFromArtifact,
  discoverTryGate,
  type DiscoverScoreInput,
} from "../../../platform/shared/discover-score";
import {
  DISCOVER_SCORE_VERSION,
  computeDiscoverScore,
  discoverScoreBand,
  discoverInternalGithubIds,
  discoverScoreFromAssessment,
  isDiscoverScoreEnabled,
  isDiscoverScoreViewer,
  sortByDiscoverScore,
  lintDiscoverHookV6,
  scoringPartitionFromTags,
} from "../discover/score";
import { cardFromAssessment } from "../discover/map";
import type { ProjectAssessment } from "../project-analysis-db";

// Anonymized fixtures: no real owners/repos.
const base: DiscoverScoreInput = {
  pain: 18,
  effectiveness: 22,
  experience: 20,
  valueDensity: 10,
  productScore: 70,
  confidence: 70,
  verificationLevel: "source_inspected",
  lifecycle: "active_evolution",
  exposureBand: "low",
  communityStrength: 20,
  risks: [],
  partition: "none",
};

const withScores = (pain: number, eff: number, exp: number, vd: number, extra: Partial<DiscoverScoreInput> = {}) =>
  computeDiscoverScore({ ...base, pain, effectiveness: eff, experience: exp, valueDensity: vd, productScore: pain + eff + exp + vd, ...extra });

describe("discover-score-v1", () => {
  it("is versioned and every partition weight row sums to 1", () => {
    expect(DISCOVER_SCORE_VERSION).toBe("discover-score-v1.1");
    for (const weights of Object.values(DISCOVER_PARTITION_WEIGHTS)) {
      const sum = Object.values(weights).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 10);
    }
  });

  it("calibration knots are strictly increasing", () => {
    for (let i = 1; i < DISCOVER_CALIBRATION_KNOTS.length; i += 1) {
      expect(DISCOVER_CALIBRATION_KNOTS[i][0]).toBeGreaterThan(DISCOVER_CALIBRATION_KNOTS[i - 1][0]);
      expect(DISCOVER_CALIBRATION_KNOTS[i][1]).toBeGreaterThan(DISCOVER_CALIBRATION_KNOTS[i - 1][1]);
    }
  });

  it("maps bands at the documented floors", () => {
    expect(discoverScoreBand(85)).toBe("must_try");
    expect(discoverScoreBand(84)).toBe("worth_a_look");
    expect(discoverScoreBand(70)).toBe("worth_a_look");
    expect(discoverScoreBand(69)).toBe("situational");
    expect(discoverScoreBand(55)).toBe("situational");
    expect(discoverScoreBand(54)).toBe("weak");
    expect(discoverScoreBand(40)).toBe("weak");
    expect(discoverScoreBand(39)).toBe("skip");
  });

  it("spreads the crowded 60-75 product_score middle into distinct bands", () => {
    const mid = withScores(15, 18, 17, 9, { confidence: 62 }); // product_score 59
    const good = withScores(20, 24, 22, 12, { confidence: 72 }); // product_score 78
    expect(good.score - mid.score).toBeGreaterThan(78 - 59);
    expect(mid.band).not.toBe(good.band);
  });

  it("is monotonic in every product dimension", () => {
    const a = withScores(15, 20, 18, 9);
    expect(withScores(18, 20, 18, 9).score).toBeGreaterThanOrEqual(a.score);
    expect(withScores(15, 24, 18, 9).score).toBeGreaterThanOrEqual(a.score);
    expect(withScores(15, 20, 24, 9).score).toBeGreaterThanOrEqual(a.score);
    expect(withScores(15, 20, 18, 13).score).toBeGreaterThanOrEqual(a.score);
  });

  it("thin evidence pulls high scores down but never lifts low ones", () => {
    const high = withScores(23, 28, 27, 14, { confidence: 90 });
    const highThin = withScores(23, 28, 27, 14, { confidence: 45 });
    expect(highThin.score).toBeLessThan(high.score);
    const low = withScores(8, 10, 9, 4, { confidence: 90 });
    const lowThin = withScores(8, 10, 9, 4, { confidence: 30 });
    expect(lowThin.score).toBe(low.score);
  });

  it("applies lifecycle, evidence and risk caps", () => {
    const strong = { pain: 23, effectiveness: 28, experience: 27, valueDensity: 14, productScore: 92, confidence: 90 };
    expect(computeDiscoverScore({ ...base, ...strong, lifecycle: "abandoned" }).score).toBeLessThanOrEqual(39);
    expect(computeDiscoverScore({ ...base, ...strong, lifecycle: "experimental" }).score).toBeLessThanOrEqual(69);
    expect(computeDiscoverScore({ ...base, ...strong, verificationLevel: "metadata_only" }).score).toBeLessThanOrEqual(54);
    const critical = computeDiscoverScore({ ...base, ...strong, risks: [{ severity: "critical", category: "license" }] });
    expect(critical.score).toBeLessThanOrEqual(54);
    expect(critical.caps).toContain("critical_risk");
  });

  it("caps sandboxes with a high security risk but not other partitions", () => {
    const strong = { pain: 22, effectiveness: 27, experience: 25, valueDensity: 13, productScore: 87, confidence: 85 };
    const risk = [{ severity: "high" as const, category: "security" }];
    expect(computeDiscoverScore({ ...base, ...strong, partition: "sandbox", risks: risk }).score).toBeLessThanOrEqual(54);
    expect(computeDiscoverScore({ ...base, ...strong, partition: "none", risks: risk }).score).toBeGreaterThan(54);
  });

  it("hides empty repos and fixtures from Discover", () => {
    const fixture = withScores(4, 2, 2, 2, { confidence: 80 });
    expect(fixture.eligible).toBe(false);
    expect(fixture.score).toBeLessThanOrEqual(24);
    expect(fixture.caps).toContain("not_discover_eligible");
  });

  it("adoption saturates: mainstream earns nothing over established", () => {
    const established = computeDiscoverScore({ ...base, exposureBand: "established", communityStrength: 90 });
    const mainstream = computeDiscoverScore({ ...base, exposureBand: "mainstream", communityStrength: 90 });
    expect(mainstream.score).toBe(established.score);
  });

  it("partition fit changes weights: skills reward a small focused surface", () => {
    const focused = { pain: 16, effectiveness: 20, experience: 26, valueDensity: 14, productScore: 76 };
    expect(computeDiscoverScore({ ...base, ...focused, partition: "skill" }).raw).toBeGreaterThan(
      computeDiscoverScore({ ...base, ...focused, partition: "microservice" }).raw,
    );
  });

  it("explains itself with at most two reasons and two limits", () => {
    const result = withScores(23, 27, 26, 13, { confidence: 55, lifecycle: "experimental" });
    expect(result.reasons.length).toBeLessThanOrEqual(2);
    expect(result.limits).toEqual(["early_stage", "thin_evidence"]);
  });
});

describe("scoring partition", () => {
  const tag = (namespace: "use_case" | "artifact" | "domain", slug: string, zh = "标签") => ({
    namespace,
    slug,
    labels: { zh, en: slug },
    evidence_ids: ["e1"],
  });

  it("uses canonical tags only, never keyword cues", () => {
    expect(scoringPartitionFromTags([tag("use_case", "ai-agent")])).toBe("agent");
    expect(scoringPartitionFromTags([tag("use_case", "agent-skill")])).toBe("skill");
    expect(scoringPartitionFromTags([tag("artifact", "microservice")])).toBe("microservice");
    expect(scoringPartitionFromTags([tag("artifact", "sandbox")])).toBe("sandbox");
    // A reverse proxy labelled "代理" or a plugin API must not become agent/skill.
    expect(scoringPartitionFromTags([tag("domain", "multi-role-proxy", "多角色统一代理"), tag("domain", "plugin-api", "插件 API")])).toBe("none");
  });
});

describe("Discover card opt-in", () => {
  const assessment = {
    repoKey: "example-owner/example-tool",
    latestAnalysisId: "00000000-0000-4000-8000-000000000001",
    projectType: "micro_tool",
    lifecycle: "active_evolution",
    productScore: 70,
    painScore: 18,
    effectivenessScore: 22,
    experienceScore: 20,
    valueDensityScore: 10,
    communityStrength: 20,
    confidence: 70,
    verificationLevel: "source_inspected",
    unknowns: [],
    risks: [],
    exposureBand: "low",
    stars: 10,
    treasureEligible: true,
    classicEligible: false,
    resolvedCommitSha: "a".repeat(40),
    analyzedAt: 0,
    reportMarkdown: "",
    analysis: {
      repository: { canonical_url: "https://github.com/example-owner/example-tool" },
      project: {
        name: "example-tool",
        summary: "Turns a manual chore into one command.",
        discover_hook: "Stop redoing the same release chore by hand.",
        pain_statement: "Release chores repeat every week.",
        target_users: ["maintainers"],
        product_tags: [{ namespace: "use_case", slug: "agent-skill", labels: { zh: "Agent 技能", en: "Agent skill" }, evidence_ids: ["e1"] }],
      },
    },
  } as unknown as ProjectAssessment;

  it("leaves cards untouched by default", () => {
    expect(cardFromAssessment(assessment, "en").discoverScore).toBeUndefined();
    expect(isDiscoverScoreEnabled({})).toBe(false);
  });

  it("attaches the versioned score only when asked", () => {
    const card = cardFromAssessment(assessment, "en", { discoverScore: true });
    expect(card.discoverScore?.version).toBe("discover-score-v1.1");
    expect(card.discoverScore?.partition).toBe("skill");
    expect(card.productScore).toBe(70);
    expect(discoverScoreFromAssessment(assessment).score).toBe(card.discoverScore?.score);
  });
});

describe("Discover hook copy contract v6", () => {
  it("accepts short, concrete, audience-first hooks", () => {
    expect(lintDiscoverHookV6("同时跑多个编程 Agent？刘海上统一看进度、批权限，一点跳回对应终端。", "example-owner/example-island")).toEqual([]);
    expect(lintDiscoverHookV6("Stop redoing the same release chore by hand: one command, reproducible output.")).toEqual([]);
    expect(lintDiscoverHookV6("一个进程扛住万级并发：反向代理、负载均衡和 TLS 终止用一份配置搞定。")).toEqual([]);
  });

  it("rejects template leads, name leads, report voice, filler and truncation", () => {
    expect(lintDiscoverHookV6("ExampleTool 是一款强大的工具")).toEqual(expect.arrayContaining(["template_lead", "marketing_filler"]));
    expect(lintDiscoverHookV6("一个用于测试评测系统的最小对抗夹具")).toContain("template_lead");
    expect(lintDiscoverHookV6("example-tool lets you convert files", "example-owner/example-tool")).toContain("name_lead");
    expect(lintDiscoverHookV6("目标用户需要避免重复执行副作用。")).toContain("report_voice");
    expect(lintDiscoverHookV6("ExampleTool is a library for parsing")).toContain("template_lead");
    expect(lintDiscoverHookV6("运维团队需要一个统一代理层，既要避免进程膨胀…")).toContain("truncated");
    expect(lintDiscoverHookV6("长".repeat(65))).toContain("too_long");
    expect(lintDiscoverHookV6("   ")).toEqual(["empty"]);
  });
});

// v1.1: famous-but-hard-to-try projects must not fill the top band.
describe("discover-score-v1.1 try gate", () => {
  // A mainstream infrastructure tree: excellent for its own experts.
  const megaInfra: DiscoverScoreInput = {
    ...base,
    pain: 23,
    effectiveness: 28,
    experience: 23,
    valueDensity: 13,
    productScore: 87,
    confidence: 85,
    lifecycle: "stable_maintenance",
    exposureBand: "mainstream",
    communityStrength: 95,
    projectType: "framework_platform",
  };
  // The same numbers on a small tool a stranger installs in minutes.
  const smallTool: DiscoverScoreInput = { ...megaInfra, exposureBand: "emerging", communityStrength: 45, projectType: "micro_tool" };

  it("does not cap by popularity alone", () => {
    const popularEasy = computeDiscoverScore({ ...megaInfra, experience: 27, productScore: 91, projectType: "micro_tool" });
    expect(popularEasy.band).toBe("must_try");
    expect(popularEasy.caps).not.toContain("hard_to_try");
  });

  it("keeps a hard-to-try mega project out of must_try (experience proxy)", () => {
    const uncapped = computeDiscoverScore(smallTool);
    const gated = computeDiscoverScore(megaInfra);
    expect(uncapped.band).toBe("must_try");
    expect(gated.score).toBe(84);
    expect(gated.band).toBe("worth_a_look");
    expect(gated.caps).toContain("hard_to_try");
    expect(gated.limits).toContain("steep_setup");
    expect(gated.tryGate).toMatchObject({ source: "experience_proxy", mega: true, threshold: 0.8 });
  });

  it("uses a higher bar only for mega projects", () => {
    expect(discoverTryGate(megaInfra).threshold).toBe(0.8);
    expect(discoverTryGate(smallTool).threshold).toBe(0.7);
    expect(discoverTryGate({ ...smallTool, communityStrength: 80 }).mega).toBe(true);
  });

  it("prefers skill v6 time_to_first_value over the proxy", () => {
    const minutes = computeDiscoverScore({ ...megaInfra, timeToFirstValue: "minutes" });
    expect(minutes.tryGate.source).toBe("time_to_first_value");
    expect(minutes.caps).not.toContain("hard_to_try");
    const day = computeDiscoverScore({ ...smallTool, timeToFirstValue: "day" });
    expect(day.score).toBeLessThanOrEqual(84);
    const weeks = computeDiscoverScore({ ...megaInfra, timeToFirstValue: "weeks" });
    expect(weeks.score).toBeLessThanOrEqual(69);
    expect(weeks.caps).toContain("weeks_to_value");
  });

  it("weights time_to_first_value into tryability", () => {
    const fast = computeDiscoverScore({ ...base, timeToFirstValue: "minutes" });
    const slow = computeDiscoverScore({ ...base, timeToFirstValue: "day" });
    expect(fast.components.tryability).toBeGreaterThan(slow.components.tryability);
    expect(fast.score).toBeGreaterThan(slow.score);
  });

  it("never lifts a score below the top band", () => {
    const mid = computeDiscoverScore({ ...megaInfra, pain: 15, effectiveness: 18, productScore: 69 });
    const midProxyOff = computeDiscoverScore({ ...megaInfra, pain: 15, effectiveness: 18, productScore: 69, projectType: null });
    expect(mid.score).toBe(midProxyOff.score);
  });
});

describe("artifact -> scorer input", () => {
  const artifact = {
    project: {
      project_type: "micro_tool",
      lifecycle: "active_evolution" as const,
      product_tags: [
        { namespace: "use_case", slug: "agent-skill" },
        { namespace: "domain", slug: "example-domain" },
      ],
      discover_partition: "skill",
      time_to_first_value: "minutes",
    },
    scores: {
      pain: { score: 18 },
      effectiveness: { score: 22 },
      experience: { score: 20 },
      value_density: { score: 10 },
      product_score: 70,
    },
    confidence: 70,
    verification_level: "source_inspected" as const,
    risks: [{ severity: "low" as const, category: "maintenance" }],
    community_strength: { score: 20 },
    exposure: { band: "low" as const },
  };

  it("maps canonical tags, project type and TTFV", () => {
    const input = discoverScoreInputFromArtifact(artifact);
    expect(input).toMatchObject({ partition: "skill", projectType: "micro_tool", timeToFirstValue: "minutes", communityStrength: 20 });
  });

  it("ignores unknown enum values instead of guessing", () => {
    const input = discoverScoreInputFromArtifact({
      ...artifact,
      project: { ...artifact.project, project_type: "something_else", time_to_first_value: "soon", product_tags: [] },
      community_strength: null,
      exposure: null,
    });
    expect(input).toMatchObject({ partition: "none", projectType: null, timeToFirstValue: null, communityStrength: null, exposureBand: "unknown" });
  });
});

describe("internal discover-score gating", () => {
  // Anonymized ids only.
  const env = (flag: string | undefined, ids: string | undefined) => ({
    GHFIND_DISCOVER_SCORE_V1: flag,
    GHFIND_DISCOVER_INTERNAL_GITHUB_IDS: ids,
  });

  it("requires both the flag and an allowlisted id", () => {
    expect(isDiscoverScoreViewer(1001, env("1", "1001,1002"))).toBe(true);
    expect(isDiscoverScoreViewer(1002, env("1", " 1001 , 1002 "))).toBe(true);
    expect(isDiscoverScoreViewer(1003, env("1", "1001,1002"))).toBe(false);
    expect(isDiscoverScoreViewer(1001, env(undefined, "1001"))).toBe(false);
    expect(isDiscoverScoreViewer(1001, env("0", "1001"))).toBe(false);
  });

  it("flag alone enables nobody", () => {
    expect(isDiscoverScoreViewer(1001, env("1", undefined))).toBe(false);
    expect(isDiscoverScoreViewer(1001, env("1", ""))).toBe(false);
    expect(isDiscoverScoreViewer(null, env("1", "1001"))).toBe(false);
    expect(isDiscoverScoreViewer(undefined, env("1", "1001"))).toBe(false);
  });

  it("fails closed on a malformed allowlist", () => {
    expect(discoverInternalGithubIds(env("1", "1001,octocat"))).toEqual(new Set());
    expect(discoverInternalGithubIds(env("1", "1001,,1002"))).toEqual(new Set());
    expect(discoverInternalGithubIds(env("1", "-5"))).toEqual(new Set());
    expect(isDiscoverScoreViewer(1001, env("1", "1001,octocat"))).toBe(false);
  });

  it("breaks score ties by stranger tryability, then product score, then repo key", () => {
    const card = (repoKey: string, score: number, tryability: number, productScore = 80) => ({
      repoKey,
      productScore,
      discoverScore: { score, tryGate: { strangerTryability: tryability } } as NonNullable<ReturnType<typeof discoverScoreFromAssessment>>,
    });
    const ranked = sortByDiscoverScore([
      card("acme/c", 84, 40),
      card("acme/a", 84, 70),
      card("acme/z", 90, 10),
      card("acme/b", 84, 70, 85),
      card("acme/d", 84, 70, 85),
      { repoKey: "acme/none", productScore: 99, discoverScore: null },
    ]);
    expect(ranked.map((c) => c.repoKey)).toEqual(["acme/z", "acme/b", "acme/d", "acme/a", "acme/c", "acme/none"]);
  });
});

describe("discover-score golden (shared with the Go Feed projector)", () => {
  it("matches internal/backend/testdata/discover-score-golden.json", async () => {
    const { readFileSync } = await import("node:fs");
    const golden = JSON.parse(readFileSync("internal/backend/testdata/discover-score-golden.json", "utf8")) as {
      version: string;
      cases: { input: DiscoverScoreInput; expected: { score: number; band: string; eligible: boolean; strangerTryability: number } }[];
    };
    expect(golden.version).toBe(DISCOVER_SCORE_VERSION);
    expect(golden.cases.length).toBeGreaterThanOrEqual(100);
    for (const c of golden.cases) {
      const r = computeDiscoverScore(c.input);
      expect({ score: r.score, band: r.band, eligible: r.eligible, strangerTryability: r.tryGate.strangerTryability }).toEqual(c.expected);
    }
  });
});
