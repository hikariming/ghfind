import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../Roaster.tsx", import.meta.url), "utf8");

describe("Roaster immediate quick flow", () => {
  it("does not poll durable scan status and starts the roast from the quick result", () => {
    expect(source).not.toContain("scan-status");
    expect(source).not.toContain("scan_enrichment_pending");
    expect(source).not.toContain("followCanonicalUpgrade");
    expect(source).toContain("void runRoast(result)");
  });
});
