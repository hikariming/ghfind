import { describe, expect, it } from "vitest";
import {
  canonicalProfileUpgradePollMs,
  isCanonicalProfileUpgradeComplete,
} from "../canonical-profile-upgrade";

describe("canonical profile upgrade handoff", () => {
  it("accepts only a completed durable public scan", () => {
    expect(isCanonicalProfileUpgradeComplete({ status: "complete_public" })).toBe(true);
    expect(isCanonicalProfileUpgradeComplete({ status: "pending" })).toBe(false);
    expect(isCanonicalProfileUpgradeComplete(null)).toBe(false);
  });

  it("keeps polling within the bounded status interval", () => {
    expect(canonicalProfileUpgradePollMs(undefined)).toBe(5_000);
    expect(canonicalProfileUpgradePollMs(1)).toBe(5_000);
    expect(canonicalProfileUpgradePollMs("12")).toBe(12_000);
    expect(canonicalProfileUpgradePollMs(90)).toBe(30_000);
  });
});
