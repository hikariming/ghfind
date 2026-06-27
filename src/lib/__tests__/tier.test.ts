import { describe, expect, it } from "vitest";
import { TIER_AVATAR_FRAMES, tierAvatarFrame } from "../tier";
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
});
