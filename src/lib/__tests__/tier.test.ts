import { describe, expect, it } from "vitest";
import {
  TIER_AVATAR_FRAMES,
  TIER_AVATAR_FRAME_VECTORS,
  TIER_STYLES,
  tierAvatarFrame,
} from "../tier";
import type { Tier } from "../types";

describe("tier avatar frames", () => {
  it("uses the requested emoji per score tier", () => {
    const expected: Record<Tier, string> = {
      夯: "👑",
      顶级: "🥇",
      人上人: "👍",
      NPC: "🙂",
      拉完了: "💩",
    };

    expect(Object.keys(TIER_AVATAR_FRAMES)).toHaveLength(5);
    for (const [tier, emoji] of Object.entries(expected) as [Tier, string][]) {
      expect(tierAvatarFrame(tier).emoji).toBe(emoji);
    }
  });

  it("uses the requested emoji frame placement per tier", () => {
    expect(tierAvatarFrame("夯")).toMatchObject({
      placements: ["top"],
      emojiSize: "large",
    });
    expect(tierAvatarFrame("顶级")).toMatchObject({
      placements: ["bottom"],
      emojiSize: "large",
    });
    expect(tierAvatarFrame("人上人").placements).toEqual([
      "top-left",
      "top-right",
      "bottom-right",
      "bottom-left",
    ]);
    expect(tierAvatarFrame("NPC").placements).toEqual(["bottom"]);
  });

  it("keeps solid green and NPC blue across shared tier styles", () => {
    expect(TIER_STYLES["人上人"]).toMatchObject({
      text: "text-emerald-300",
      ring: "ring-emerald-400/50",
    });
    expect(TIER_STYLES.NPC).toMatchObject({
      text: "text-sky-300",
      ring: "ring-sky-400/50",
    });
  });

  it("places opposite decorations symmetrically on a unit circle", () => {
    expect(TIER_AVATAR_FRAME_VECTORS.top).toEqual({ x: 0, y: -1 });
    expect(TIER_AVATAR_FRAME_VECTORS.bottom).toEqual({ x: 0, y: 1 });
    expect(TIER_AVATAR_FRAME_VECTORS.left).toEqual({ x: -1, y: 0 });
    expect(TIER_AVATAR_FRAME_VECTORS.right).toEqual({ x: 1, y: 0 });
    for (const vector of Object.values(TIER_AVATAR_FRAME_VECTORS)) {
      expect(Math.hypot(vector.x, vector.y)).toBeCloseTo(1);
    }
  });
});
