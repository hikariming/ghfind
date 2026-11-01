import { describe, expect, it } from "vitest";
import {
  findBannedRoastSnark,
  scrubBannedRoastSnark,
  V13_SNARK_BANNED_ZH,
} from "../roast-v13/voice";

describe("shared roast snark guards", () => {
  it("flags owner-banned low-score labels", () => {
    const before =
      "这位开发者特征平庸存疑，像个 NPC，作品感觉拉完了，还带点嘴臭火力。";
    expect(findBannedRoastSnark(before, "zh")).toEqual(
      expect.arrayContaining(["平庸存疑", "平庸", "存疑", "NPC", "拉完了", "嘴臭"]),
    );
    for (const banned of ["拉完了", "NPC", "平庸", "存疑"] as const) {
      expect(V13_SNARK_BANNED_ZH).toContain(banned);
    }
  });

  it("scrubs banned labels while keeping witty anonymized observation", () => {
    // Anonymized fixture — no real usernames.
    const before =
      "demo-dev 的主页更像作品展板，名气跑在仓库前面，整体平庸存疑，活脱脱 NPC，感觉拉完了。";
    const after = scrubBannedRoastSnark(before, "zh");
    expect(after).toContain("作品展板");
    expect(after).toContain("名气跑在仓库前面");
    expect(after).not.toMatch(/平庸|存疑|NPC|拉完了/);
  });

  it("scrubs english insult lexicon case-insensitively", () => {
    const before =
      "demo-dev still reads like trash tier energy with a mediocre signal — nobody cares about you.";
    const after = scrubBannedRoastSnark(before, "en");
    expect(after.toLowerCase()).not.toContain("trash tier energy");
    expect(after.toLowerCase()).not.toContain("mediocre");
    expect(after.toLowerCase()).not.toContain("nobody cares about you");
  });
});
