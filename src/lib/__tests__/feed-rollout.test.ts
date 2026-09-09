import { describe, expect, it } from "vitest";
import { feedRolloutBucket, feedRoutingDecision } from "../feed-rollout";

const configuration = {
  FEED_BACKEND: "go", FEED_ROLLOUT_MODE: "internal", FEED_ROLLOUT_GITHUB_IDS: "42, 71",
  FEED_ROLLOUT_SEED: "fixture-stable-seed-v1", FEED_ROLLOUT_BASIS_POINTS: "0",
};

describe("Feed runtime admission", () => {
  it("preserves unconfigured legacy and previously explicit Go deployments", () => {
    expect(feedRoutingDecision(123, {})).toEqual({ backend: "legacy" });
    expect(feedRoutingDecision(123, { FEED_BACKEND: "legacy" })).toEqual({ backend: "legacy" });
    expect(feedRoutingDecision(123, { FEED_BACKEND: "go" })).toEqual({ backend: "go", mode: "all", internal: false });
    expect(feedRoutingDecision(123, { FEED_BACKEND: "unknown" })).toEqual({ backend: "unavailable" });
  });

  it("admits only configured authenticated IDs during internal validation", () => {
    expect(feedRoutingDecision(42, configuration)).toEqual({ backend: "go", mode: "internal", internal: true });
    expect(feedRoutingDecision(71, configuration).backend).toBe("go");
    expect(feedRoutingDecision(123, configuration)).toEqual({ backend: "unavailable" });
    for (const id of [0, -1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(feedRoutingDecision(id, configuration)).toEqual({ backend: "unavailable" });
    }
  });

  it("keeps cohorts deterministic and nested as the percentage increases", () => {
    const one = { ...configuration, FEED_ROLLOUT_MODE: "percentage", FEED_ROLLOUT_BASIS_POINTS: "100" };
    const ten = { ...one, FEED_ROLLOUT_BASIS_POINTS: "1000" };
    let admitted = 0;
    for (let id = 1; id <= 2000; id++) {
      const selected = feedRoutingDecision(id, one).backend === "go";
      expect(feedRoutingDecision(id, { ...one })).toEqual(feedRoutingDecision(id, one));
      if (selected) {
        admitted++;
        expect(feedRoutingDecision(id, ten).backend).toBe("go");
      }
    }
    expect(admitted).toBeGreaterThan(2);
    expect(admitted).toBeLessThan(100);
    expect(feedRoutingDecision(42, one)).toEqual({ backend: "go", mode: "percentage", internal: true });
    expect(feedRoutingDecision(123, { ...configuration, FEED_ROLLOUT_MODE: "all", FEED_ROLLOUT_BASIS_POINTS: "10000" })).toEqual({ backend: "go", mode: "all", internal: false });
  });

  it("pauses all users and never changes excluded users to the legacy writer", () => {
    for (const id of [42, 123]) {
      expect(feedRoutingDecision(id, { ...configuration, FEED_ROLLOUT_MODE: "paused" })).toEqual({ backend: "unavailable" });
      expect(feedRoutingDecision(id, { ...configuration, FEED_BACKEND: "legacy" })).toEqual({ backend: "unavailable" });
    }
  });

  it("rejects partial, ambiguous and invalid operator configuration", () => {
    for (const key of ["FEED_ROLLOUT_MODE", "FEED_ROLLOUT_GITHUB_IDS", "FEED_ROLLOUT_SEED", "FEED_ROLLOUT_BASIS_POINTS"]) {
      const partial: Record<string, string | undefined> = { ...configuration, [key]: undefined };
      expect(feedRoutingDecision(42, partial)).toEqual({ backend: "unavailable" });
    }
    for (const change of [
      { FEED_ROLLOUT_MODE: "typo" }, { FEED_ROLLOUT_MODE: "" }, { FEED_ROLLOUT_SEED: "" },
      { FEED_ROLLOUT_SEED: "unsafe\nseed-with-newline" }, { FEED_ROLLOUT_GITHUB_IDS: "" },
      { FEED_ROLLOUT_GITHUB_IDS: "42,42" }, { FEED_ROLLOUT_GITHUB_IDS: "0" },
      { FEED_ROLLOUT_GITHUB_IDS: "42, 01" }, { FEED_ROLLOUT_GITHUB_IDS: "9007199254740992" },
      { FEED_ROLLOUT_GITHUB_IDS: Array.from({ length: 21 }, (_, i) => i + 1).join(",") },
      { FEED_ROLLOUT_BASIS_POINTS: "01" }, { FEED_ROLLOUT_BASIS_POINTS: "1.0" },
      { FEED_ROLLOUT_BASIS_POINTS: "1e2" }, { FEED_ROLLOUT_BASIS_POINTS: "10001" },
      { FEED_ROLLOUT_MODE: "percentage", FEED_ROLLOUT_BASIS_POINTS: "0" },
      { FEED_ROLLOUT_MODE: "percentage", FEED_ROLLOUT_BASIS_POINTS: "10000" },
      { FEED_ROLLOUT_MODE: "all", FEED_ROLLOUT_BASIS_POINTS: "1000" },
      { FEED_ROLLOUT_MODE: "paused", FEED_ROLLOUT_BASIS_POINTS: "100" },
    ]) expect(feedRoutingDecision(42, { ...configuration, ...change })).toEqual({ backend: "unavailable" });
  });

  it("freezes the versioned bucket encoding independently of process state", () => {
    expect([1, 42, 123, Number.MAX_SAFE_INTEGER].map(id => feedRolloutBucket(id, configuration.FEED_ROLLOUT_SEED)))
      .toEqual([4604, 5878, 2867, 8073]);
  });
});
