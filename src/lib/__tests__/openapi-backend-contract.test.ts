import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { GET } from "@/app/openapi.json/route";
import { apiSummaryMd, WHEN_TO_USE } from "@/lib/agent-docs";

describe("OpenAPI backend extraction contract", () => {
  it("documents the Go quick-worker score source instead of the removed live source", async () => {
    const response = GET();
    const spec = await response.json();
    const score = spec.paths["/api/score/{username}"].get;
    const source = spec.components.schemas.ScorePayload.properties.source;

    expect(score.description).toContain('source: "quick"');
    expect(score.description).toContain("synchronous quick");
    expect(score.description).not.toContain('source: "live"');
    expect(source.enum).toEqual(["indexed", "quick", "legacy_v5_v5_v3"]);
    expect(spec.components.schemas.ScorePayload.properties.coverage.enum).toEqual(["quick", "legacy"]);
  });

  it("keeps machine-facing prose aligned with the worker-backed score path", () => {
    const prose = [apiSummaryMd(), ...WHEN_TO_USE].join("\n");

    expect(prose).toContain("durable quick-scan worker path");
    expect(prose).not.toContain("live on demand");
  });

  it("keeps SDK README examples aligned with the quick-worker score source", () => {
    for (const rel of ["packages/ghfind-js/README.md", "packages/ghfind-py/README.md"]) {
      const readme = readFileSync(join(process.cwd(), rel), "utf8");
      expect(readme).not.toContain("indexed\" | \"live");
      expect(readme).not.toContain("scored live");
      expect(readme).toContain("legacy_v5_v5_v3");
    }
  });
});
