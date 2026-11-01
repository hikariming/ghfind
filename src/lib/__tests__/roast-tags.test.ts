import { describe, expect, it } from "vitest";
import { isTriviaTag, sanitizeRoastTags, sanitizeTagsPair, tagsForLocale } from "../roast-tags";

describe("roast-tags", () => {
  it("rejects follower-ratio and time-window trivia tags", () => {
    expect(isTriviaTag("关注倒挂")).toBe(true);
    expect(isTriviaTag("粉丝倒挂")).toBe(true);
    expect(isTriviaTag("Follows>Fans")).toBe(true);
    expect(isTriviaTag("Fans>Follows")).toBe(true);
    expect(isTriviaTag("近30天")).toBe(true);
    expect(isTriviaTag("Last 7 days")).toBe(true);
    expect(isTriviaTag("粉丝滤镜")).toBe(true);
    expect(isTriviaTag("厚度")).toBe(true);
  });

  it("keeps substance tags about projects, stack and maintenance", () => {
    for (const t of ["核心修理工", "PR劳模", "自营荒地", "Core Fixer", "PR Workhorse", "Own-Repo Famine", "DSH插件", "并发修复"]) {
      expect(isTriviaTag(t)).toBe(false);
    }
  });

  it("sanitizes, drops trivia and caps at 4", () => {
    expect(sanitizeRoastTags(["核心修理工", "关注倒挂", "PR劳模", "#自营荒地", "Follows>Fans", "并发修复", "多余第五"], 6)).toEqual([
      "核心修理工",
      "PR劳模",
      "自营荒地",
      "并发修复",
    ]);
    expect(sanitizeTagsPair({ zh: ["关注倒挂", "核心修理工"], en: ["Follows>Fans", "Core Fixer"] })).toEqual({
      zh: ["核心修理工"],
      en: ["Core Fixer"],
    });
  });

  it("picks one language per locale with fallback", () => {
    const tags = { zh: ["核心修理工", "PR劳模"], en: ["Core Fixer", "PR Workhorse"] };
    expect(tagsForLocale(tags, "zh")).toEqual(["核心修理工", "PR劳模"]);
    expect(tagsForLocale(tags, "en")).toEqual(["Core Fixer", "PR Workhorse"]);
    expect(tagsForLocale(tags, "ja")).toEqual(["Core Fixer", "PR Workhorse"]);
    expect(tagsForLocale({ zh: [], en: ["Core Fixer"] }, "zh")).toEqual(["Core Fixer"]);
    expect(tagsForLocale({ zh: ["关注倒挂"], en: ["Core Fixer"] }, "zh")).toEqual(["Core Fixer"]);
  });
});

describe("issue backlog tags", () => {
  it("rejects Issue堆肥 / Issue Composter", () => {
    expect(isTriviaTag("Issue堆肥")).toBe(true);
    expect(isTriviaTag("Issue Composter")).toBe(true);
  });
});
