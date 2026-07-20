import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../Roaster.tsx", import.meta.url), "utf8");

describe("Roaster durable scan polling", () => {
  it("keeps observing a pending durable run until completion or a terminal state", () => {
    expect(source).toContain('setPendingMessage(t("errScanPending"))');
    expect(source).toContain("while (!controller.signal.aborted)");
    expect(source).toContain('status?.status === "failed" || statusRes.status === 404');
    expect(source).not.toContain("2 * 60 * 1_000");
  });
});
