import { describe, expect, it } from "vitest";
import { reportMatchesLang, splitReport } from "../report";

describe("splitReport", () => {
  it("splits a Chinese report at the 🔥 毒舌点评 marker", () => {
    const md = "## user — 80/100\n\nbody text\n\n🔥 **毒舌点评**: savage one-liner";
    const { body, roast } = splitReport(md);
    expect(roast).toBe("savage one-liner");
    expect(body).toContain("body text");
    expect(body).not.toContain("毒舌点评");
  });

  it("splits an English report at the 🔥 Roast marker", () => {
    const md = "## user — 80/100\n\nbody text\n\n🔥 **Roast**: savage one-liner";
    const { body, roast } = splitReport(md);
    expect(roast).toBe("savage one-liner");
    expect(body).toContain("body text");
    expect(body).not.toContain("Roast");
  });

  it("strips the leading heading from the body", () => {
    const md = "## sample-user — 99.00/100 · 夯\n\ndetails";
    const { body } = splitReport(md);
    expect(body).not.toContain("sample-user — 99");
    expect(body).toContain("details");
  });

  it("returns an empty roast while the marker has not streamed yet", () => {
    const { roast } = splitReport("## user\n\npartial body still streaming");
    expect(roast).toBe("");
  });
});

describe("reportMatchesLang", () => {
  it("accepts an English report with English structure", () => {
    const md = "## sample-user — 95.20/100 · GOD\n\n**TL;DR**: strong account.\n\n🔥 **Roast**: too good to roast.";
    expect(reportMatchesLang(md, "en")).toBe(true);
  });

  it("rejects a Chinese report stored under the English cache key", () => {
    const md = "## sample-user — 95.20/100 · 夯\n\n**一句话结论**: 很强。\n\n🔥 **毒舌点评**: 强到没法吐槽。";
    expect(reportMatchesLang(md, "en")).toBe(false);
  });

  it("allows a few CJK characters in English reports for names or repo titles", () => {
    const md = "## dev — 90.00/100 · GOD\n\n**TL;DR**: shipped 数据工具 and earned it.";
    expect(reportMatchesLang(md, "en")).toBe(true);
  });
});
