import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { GET } from "@/app/openapi.json/route";
import { apiSummaryMd, WHEN_TO_USE } from "@/lib/agent-docs";

describe("OpenAPI Worker contract", () => {
  it("documents the synchronous quick score source instead of the removed live source", async () => {
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

  it("keeps machine-facing prose aligned with the synchronous score path", () => {
    const prose = [apiSummaryMd(), ...WHEN_TO_USE].join("\n");

    expect(prose).toContain("bounded synchronous quick scan");
    expect(prose).not.toContain("live on demand");
  });

  it("keeps SDK README examples aligned with the quick score source", () => {
    for (const rel of ["packages/ghfind-js/README.md", "packages/ghfind-py/README.md"]) {
      const readme = readFileSync(join(process.cwd(), rel), "utf8");
      expect(readme).not.toContain("indexed\" | \"live");
      expect(readme).not.toContain("scored live");
      expect(readme).toContain("legacy_v5_v5_v3");
    }
  });
});
