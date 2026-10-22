import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HomeSnapStrip } from "@/components/HomeSnapStrip";

describe("HomeSnapStrip", () => {
  it("matches scroller padding with scroll padding and caps bleed below 900px", () => {
    const markup = renderToStaticMarkup(
      <HomeSnapStrip>
        <div>fictional-owner-lathe/lathe</div>
      </HomeSnapStrip>,
    );

    expect(markup).toContain("home-snap-strip");
    expect(markup).toContain("home-snap-scroller");
    expect(markup).toContain("items-stretch");
    expect(markup).toContain("scroll-px-5");
    expect(markup).toContain("px-5");
    expect(markup).toContain("min-[900px]:scroll-px-6");
    expect(markup).toContain("min-[900px]:px-6");
    expect(markup).toContain("-mx-5");
    expect(markup).toContain("min-[900px]:-mx-6");
    expect(markup).toContain("snap-x");
    expect(markup).toContain("snap-mandatory");
  });
});
