import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../Roaster.tsx", import.meta.url), "utf8");

describe("Roaster scan progression", () => {
  it("keeps observing a pending durable run until completion or a terminal state", () => {
    expect(source).toContain('setPendingMessage(t("errScanPending"))');
    expect(source).toContain("while (!controller.signal.aborted)");
    expect(source).toContain('status?.status === "failed" || statusRes.status === 404');
    expect(source).not.toContain("2 * 60 * 1_000");
  });

  it("streams a provisional quick result on the current page and upgrades only an active page", () => {
    expect(source).toContain("if (result.provisional)");
    expect(source).toContain("void runRoast(result)");
    expect(source).toContain("followCanonicalUpgrade(result.metrics.username, refreshRunId)");
    expect(source).toContain("const upgradeAbortRef = useRef<AbortController | null>(null)");
    expect(source).toContain('status?.status === "complete_public" && status.scan');
  });
});
