import { describe, expect, it } from "vitest";
import { TIER_LABEL_EN } from "../badge";
import {
  clipText,
  MINI_CARD_SIZES,
  parseMiniCardLang,
  parseMiniCardTheme,
  parseMiniCardVariant,
  renderMiniCardSvg,
  renderMiniCardUnratedSvg,
  type MiniCardOptions,
  type MiniCardVariant,
} from "../mini-card";
import type { SubScores } from "../types";

const scores: SubScores = {
  account_maturity: 9,
  original_project_quality: 14,
  contribution_quality: 21,
  ecosystem_impact: 12,
  community_influence: 5,
  activity_authenticity: 14,
};

const base: MiniCardOptions = {
  username: "codex-showcase",
  displayName: "Codex Showcase",
  avatar: null,
  score: 92.41,
  tier: "夯",
  tierLabel: TIER_LABEL_EN["夯"],
  scores,
  languages: ["Python", "Go", "TypeScript"],
  rank: 128,
  total: 21384,
  beat: 99.2,
  delta: 2.3,
  sponsorLogo: "data:image/png;base64,sponsor",
  variant: "bars",
  theme: "dark",
  lang: "en",
};

const VARIANTS: MiniCardVariant[] = ["bars", "radar", "strip"];

describe("mini card", () => {
  it("parses query params, falling back to README-safe defaults", () => {
    expect(parseMiniCardVariant("radar")).toBe("radar");
    expect(parseMiniCardVariant("strip")).toBe("strip");
    expect(parseMiniCardVariant("bars")).toBe("bars");
    expect(parseMiniCardVariant(null)).toBe("bars");
    expect(parseMiniCardVariant("BARS")).toBe("bars");
    expect(parseMiniCardVariant("../etc/passwd")).toBe("bars");

    expect(parseMiniCardTheme("dark")).toBe("dark");
    expect(parseMiniCardTheme("light")).toBe("light");
    expect(parseMiniCardTheme(null)).toBe("auto");
    expect(parseMiniCardTheme("solarized")).toBe("auto");

    expect(parseMiniCardLang("zh")).toBe("zh");
    expect(parseMiniCardLang(null)).toBe("en");
    expect(parseMiniCardLang("ja")).toBe("en");
  });

  it("renders each variant at its exact intrinsic size", () => {
    for (const variant of VARIANTS) {
      const { w, h } = MINI_CARD_SIZES[variant];
      const svg = renderMiniCardSvg({ ...base, variant });
      expect(svg).toContain(`width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"`);
      expect(svg).toContain(`data-variant="${variant}"`);
      // Markdown can't resize an image, so the declared size IS the embed size.
      expect(svg).not.toContain("width=\"100%\"");
    }
  });

  it("emits a prefers-color-scheme block only for theme=auto", () => {
    const auto = renderMiniCardSvg({ ...base, theme: "auto" });
    expect(auto).toContain("@media (prefers-color-scheme:light)");
    // var() carries the dark value as its literal fallback.
    expect(auto).toContain("var(--f,#f4f4f5)");

    for (const theme of ["dark", "light"] as const) {
      const fixed = renderMiniCardSvg({ ...base, theme });
      expect(fixed).not.toContain("prefers-color-scheme");
      expect(fixed).not.toContain("var(--");
    }
    // Pinned themes must be literal so the <picture> snippet stays exact.
    expect(renderMiniCardSvg({ ...base, theme: "dark" })).toContain("#0a0a0b");
    expect(renderMiniCardSvg({ ...base, theme: "light" })).toContain("#ffffff");
  });

  it("uses the -600 tier hue for light so small type stays readable", () => {
    expect(renderMiniCardSvg({ ...base, theme: "dark" })).toContain("#F59E0B");
    expect(renderMiniCardSvg({ ...base, theme: "light" })).toContain("#D97706");
  });

  it("escapes display names and handles rather than injecting markup", () => {
    const svg = renderMiniCardSvg({
      ...base,
      displayName: '<script>alert("x")</script>',
      languages: ["C<>&"],
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp;");
  });

  it("keeps CJK display names and tier words when lang=zh", () => {
    // The PNG card drops non-ASCII outright (Latin-only embedded font); the whole
    // point of the SVG card is that it doesn't.
    const zh = { ...base, lang: "zh" as const, displayName: "光明" };
    const svg = renderMiniCardSvg(zh);
    expect(svg).toContain("光明");
    expect(svg).toContain("夯");
    expect(svg).toContain("前 0.8%");
    expect(svg).toContain("第 128 / 21,384");
    expect(svg).toContain("↑2.3 周");
    expect(svg).not.toContain("GOD");
    // Only radar has room for the tier blurb; bars carries the tier chip instead.
    expect(
      renderMiniCardSvg({ ...zh, variant: "radar", tierLabel: "封神 · 殿堂级标杆" }),
    ).toContain("封神 · 殿堂级标杆");
  });

  it("renders the English meta line with a thousands separator", () => {
    const svg = renderMiniCardSvg(base);
    expect(svg).toContain("Top 0.8%");
    expect(svg).toContain("#128 / 21,384");
    expect(svg).toContain("↑2.3 wk");
    expect(svg).toContain("GOD");
  });

  it("hides week-over-week drops — the card is a brag surface", () => {
    for (const variant of VARIANTS) {
      expect(renderMiniCardSvg({ ...base, variant, delta: -3.1 })).not.toContain("↑");
      expect(renderMiniCardSvg({ ...base, variant, delta: 0.04 })).not.toContain("↑");
      expect(renderMiniCardSvg({ ...base, variant, delta: 0.05 })).toContain("↑0.1");
    }
  });

  it("stays a valid fixed-size card when every optional field is missing", () => {
    for (const variant of VARIANTS) {
      const { w, h } = MINI_CARD_SIZES[variant];
      const svg = renderMiniCardSvg({
        ...base,
        variant,
        displayName: null,
        avatar: null,
        languages: [],
        rank: null,
        total: null,
        beat: null,
        delta: null,
        // Older/degraded rows can arrive without a sub-score object at all.
        scores: {} as SubScores,
      });
      expect(svg).toContain(`width="${w}" height="${h}"`);
      expect(svg).not.toContain("NaN");
      expect(svg).not.toContain("undefined");
      expect(svg).toContain("ghfind.com");
    }
  });

  it("credits the sponsor on bars and radar, but not on the strip", () => {
    for (const variant of ["bars", "radar"] as const) {
      const svg = renderMiniCardSvg({ ...base, variant });
      expect(svg).toContain('<image href="data:image/png;base64,sponsor"');
      expect(svg).toContain("Powered by");
      expect(svg).toContain("LobeHub");
    }
    // 420×88 has no room for a third footer run — see renderStrip.
    const strip = renderMiniCardSvg({ ...base, variant: "strip" });
    expect(strip).not.toContain("base64,sponsor");
    expect(strip).not.toContain("Powered by");
  });

  it("keeps the language slot alongside the sponsor credit", () => {
    // Both live in the footer, so the sponsor must not squeeze the languages out.
    const svg = renderMiniCardSvg({ ...base, variant: "bars" });
    expect(svg).toContain("Python · Go · TypeScript");
    expect(svg).toContain("LobeHub");
  });

  it("falls back to a text-only credit when the sponsor logo is missing", () => {
    // sponsorLogoDataUrl resolves null on a missing asset. The mark goes, the
    // credit stays — that's the part that's owed.
    const svg = renderMiniCardSvg({ ...base, sponsorLogo: null });
    expect(svg).not.toContain("base64,sponsor");
    expect(svg).toContain("Powered by");
    expect(svg).toContain("LobeHub");
    expect(svg).toContain("Python · Go · TypeScript");
  });

  it("clips overlong handles and names instead of overflowing the frame", () => {
    const svg = renderMiniCardSvg({
      ...base,
      username: "a-very-long-github-handle-that-runs-on",
      displayName: "An extremely long display name that would never fit the slot",
    });
    expect(svg).toContain("…");
    expect(svg).not.toContain("An extremely long display name that would never fit the slot");
  });

  it("clipText keeps text inside the slot and is a no-op when it fits", () => {
    expect(clipText("short", 500, 11)).toBe("short");
    const clipped = clipText("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 40, 11);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipped.length).toBeLessThan(30);
    // CJK is billed at ~1em, so far fewer glyphs survive the same slot.
    expect(clipText("中文中文中文中文中文", 40, 11)).toBe("中文中…");
  });

  it("renders six labelled meters on the bars variant", () => {
    const svg = renderMiniCardSvg({ ...base, variant: "bars" });
    expect(svg.match(/data-dimension="/g)).toHaveLength(6);
    expect(svg).toContain("Maturity");
    expect(svg).toContain("Ecosystem");
    // 6 cells per dimension, all rects, so no glyph-width guesswork.
    expect(svg.match(/rx="1.5"/g)).toHaveLength(36);
    expect(renderMiniCardSvg({ ...base, variant: "bars", lang: "zh" })).toContain("生态");
  });

  it("renders six A-E graded axes on the radar variant", () => {
    const svg = renderMiniCardSvg({ ...base, variant: "radar" });
    expect(svg.match(/data-dimension="/g)).toHaveLength(6);
    expect(svg).toContain("<polygon");
    // account_maturity 9/10 -> A, community_influence 5/8 -> C.
    expect(svg).toMatch(/data-dimension="account_maturity">.*>A</);
    expect(svg).toMatch(/data-dimension="community_influence">.*>C</);
  });

  it("gives the tier word room to breathe next to inline text", () => {
    // A bold "GOD" measures wider than 0.6em/char; the label after it must not
    // start inside it.
    const svg = renderMiniCardSvg({ ...base, variant: "radar" });
    expect(svg).not.toContain(">GODLegendary");
    const label = /<text x="(\d+)" y="116"[^>]*>Legendary/.exec(svg);
    expect(label).not.toBeNull();
    expect(Number(label?.[1])).toBeGreaterThanOrEqual(48);
  });

  it("renders a same-size placeholder for unrated accounts", () => {
    for (const variant of VARIANTS) {
      const { w, h } = MINI_CARD_SIZES[variant];
      const svg = renderMiniCardUnratedSvg({
        username: "nobody",
        variant,
        theme: "auto",
        lang: "en",
      });
      // Same intrinsic size as the rated card: an embedded README image must not
      // change layout (or break) just because the account isn't scored yet.
      expect(svg).toContain(`width="${w}" height="${h}"`);
      expect(svg).toContain("Not yet rated");
      expect(svg).toContain("@nobody");
      expect(svg).toContain("ghfind.com");
      expect(svg).not.toContain("NaN");
    }
    expect(
      renderMiniCardUnratedSvg({
        username: "nobody",
        variant: "bars",
        theme: "dark",
        lang: "zh",
      }),
    ).toContain("尚未评分");
  });

  it("never references an external resource", () => {
    // An SVG inside an <img> cannot load anything over the network, so a remote
    // avatar URL would render as a hole.
    const svg = renderMiniCardSvg({
      ...base,
      avatar: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(svg).toContain('href="data:image/png;base64,iVBORw0KGgo="');
    expect(svg).not.toMatch(/href="https?:/);
    expect(svg).not.toContain("<script");
  });
});
