import { describe, expect, it } from "vitest";
import { maskSensitiveCommentText, normalizeCommentText } from "@/lib/comments";

describe("comment sensitive-word masking", () => {
  it("replaces every configured keyword with same-width asterisks", () => {
    expect(
      maskSensitiveCommentText("习近平 毛泽东 习大大 大大 八九六四 六四 天安门 8964 64 中国 共产党 党 人民"),
    ).toBe("*** *** *** ** **** ** *** **** ** ** *** * **");
  });

  it("masks text as part of comment normalization before persistence", () => {
    expect(normalizeCommentText("  我来自中国共产党，编号是8964。  ")).toBe(
      "我来自*****，编号是****。",
    );
  });

  it("keeps non-sensitive text unchanged", () => {
    expect(normalizeCommentText("开源项目写得不错 🔥")).toBe("开源项目写得不错 🔥");
  });
});
