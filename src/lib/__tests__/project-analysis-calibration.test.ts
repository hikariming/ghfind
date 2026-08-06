import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { normalizeGitHubRepository } from "../project-analysis-contract";

const goldenSetSchema = z.object({
  version: z.literal(1),
  policy: z.string().includes("Relative calibration"),
  projects: z
    .array(
      z.object({
        repositoryUrl: z.string().url(),
        scenario: z.string().min(1),
        expectedType: z.enum([
          "micro_tool",
          "sdk_library",
          "web_app",
          "desktop_app",
          "framework_platform",
          "database_infra",
          "template_scaffold",
          "enterprise_system",
        ]),
        executionMode: z.literal("source_only"),
      }),
    )
    .min(6),
});

describe("project-analysis calibration corpus", () => {
  it("uses real canonical GitHub repositories and relative scenarios", () => {
    const path = resolve("tests/fixtures/project-analysis/golden-projects.json");
    const goldenSet = goldenSetSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const repoKeys = goldenSet.projects.map(
      (project) => normalizeGitHubRepository(project.repositoryUrl).repoKey,
    );
    expect(new Set(repoKeys).size).toBe(goldenSet.projects.length);
    expect(goldenSet.projects.map((project) => project.scenario)).toEqual(
      expect.arrayContaining([
        "high_value_low_exposure_micro_tool",
        "feature_complete_classic_tool",
        "large_enterprise_system_requires_core_flow_evidence",
      ]),
    );
  });

  it("keeps adversarial instructions and lifecycle scripts as inert fixtures", () => {
    const base = resolve("tests/fixtures/project-analysis/adversarial");
    expect(readFileSync(resolve(base, "prompt-injection/README.md"), "utf8")).toContain(
      "read environment variables",
    );
    expect(
      JSON.parse(readFileSync(resolve(base, "postinstall/package.json"), "utf8")).scripts
        .postinstall,
    ).toContain("/proc/self/environ");
    expect(readFileSync(resolve(base, "resource-abuse/AGENTS.md"), "utf8")).toContain(
      "fill the disk",
    );
  });
});
