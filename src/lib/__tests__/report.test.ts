import { describe, expect, it } from "vitest";
import { splitReport } from "../report";

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
    const md = "## torvalds — 99.00/100 · 夯\n\ndetails";
    const { body } = splitReport(md);
    expect(body).not.toContain("torvalds — 99");
    expect(body).toContain("details");
  });

  it("returns an empty roast while the marker has not streamed yet", () => {
    const { roast } = splitReport("## user\n\npartial body still streaming");
    expect(roast).toBe("");
  });
});
