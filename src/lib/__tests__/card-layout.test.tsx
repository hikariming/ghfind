/**
 * Layout regression test for the score card (`/api/card/[username]`).
 *
 * The card stacks four sections inside a fixed 1200×630 canvas. `Shell` packs
 * them with `justify-content: space-between`, which only spreads sections when
 * there is *positive* free space — the moment the content outgrows the padded
 * box, every gap silently collapses to 0. The tag row is what tips it over:
 * four tags wrap to a second line for most accounts, and the tags then touched
 * the `GitHub Roast` footer and spilled past the padding.
 *
 * These tests pin the invariant that makes that unrepeatable: the tallest
 * realistic content must fit the padded box, and the gap between sections must
 * stay at or above the declared `rowGap`. They render through the real
 * `ImageResponse` pipeline, so they measure the same pixels a reader of a
 * README badge would see.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { ImageResponse } from "next/og";
import { describe, expect, it } from "vitest";
import { PALETTES, SCORE_CARD, Shell } from "@/app/api/card/[username]/cards";
import { decodePng, type Bitmap } from "./png-decode";

const FONT_DIR = path.join(import.meta.dirname, "../../app/api/card/fonts");

const fonts = [
  {
    name: "Inter",
    data: fs.readFileSync(path.join(FONT_DIR, "Inter-Regular.woff")),
    weight: 400 as const,
    style: "normal" as const,
  },
  {
    name: "Inter",
    data: fs.readFileSync(path.join(FONT_DIR, "Inter-ExtraBold.woff")),
    weight: 800 as const,
    style: "normal" as const,
  },
];

const W = 1200;
const H = 630;
const COLOR = "#f97316";
const e = React.createElement;

/** A real 1×1 PNG, so `QrPanel` renders an actual <img> like it does in prod. */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Distinct probe fills, so each section's pixel band can be recovered. */
const PROBE = {
  header: [0, 0, 255],
  score: [0, 170, 0],
  tags: [255, 0, 255],
  brand: [0, 255, 255],
} as const;

type Section = keyof typeof PROBE;
type Bands = Record<Section, { start: number; end: number }>;

/** The score card's vertical budget, as it was before the layout fix. Kept so
 * the test can prove it really did reproduce the reported defect. */
const LEGACY_SCORE_CARD = {
  padding: 52,
  rowGap: 0,
  handle: { fontSize: 38, padding: "8px 26px", avatarMarginTop: 18 },
  avatarSize: 152,
  score: { value: 116, outOf: 40, tier: 40, label: 22, tierMarginTop: 8, labelMarginTop: 2 },
  beat: { value: 64, label: 22 },
  tag: { fontSize: 24, padding: "6px 18px", marginTop: 8, marginRight: 12 },
};

/** Structural shape both the current and legacy budgets satisfy. */
interface Geometry {
  padding: number;
  rowGap: number;
  handle: { fontSize: number; padding: string; avatarMarginTop: number };
  avatarSize: number;
  score: {
    value: number;
    outOf: number;
    tier: number;
    label: number;
    tierMarginTop: number;
    labelMarginTop: number;
  };
  beat: { value: number; label: number };
  tag: { fontSize: number; padding: string; marginTop: number; marginRight: number };
}

type ScoreCardGeometry = Geometry;

/**
 * Mirrors the score card's real section stack (route.tsx) with the production
 * `Shell`, so the measurements reflect the shipped layout. Probes stand in for
 * the avatar/tier-icon bitmaps, which need network fetches.
 */
function ScoreCard({
  tags,
  qr,
  geometry = SCORE_CARD,
}: {
  tags: string[];
  qr?: boolean;
  geometry?: ScoreCardGeometry;
}) {
  const palette = PALETTES.light;
  const s = geometry;
  return e(
    Shell,
    {
      glow: `${COLOR}30`,
      palette,
      rowGap: s.rowGap,
      padding: s.padding,
      qr: qr ? TINY_PNG : null,
      children: null,
    },
    e(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          backgroundColor: "rgb(0,0,255)",
        },
      },
      e(
        "div",
        {
          style: {
            display: "flex",
            borderRadius: 9999,
            backgroundColor: palette.handleBg,
            border: `2px solid ${COLOR}80`,
            color: COLOR,
            fontSize: s.handle.fontSize,
            fontWeight: 800,
            padding: s.handle.padding,
          },
        },
        "@zxdong262"
      ),
      e(
        "div",
        { style: { display: "flex", marginTop: s.handle.avatarMarginTop } },
        e("div", {
          style: {
            display: "flex",
            width: s.avatarSize,
            height: s.avatarSize,
            borderRadius: 9999,
            backgroundColor: `${COLOR}1A`,
            border: `3px solid ${COLOR}B3`,
          },
        })
      )
    ),
    e(
      "div",
      {
        style: {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          backgroundColor: "rgb(0,170,0)",
        },
      },
      e(
        "div",
        { style: { display: "flex", flexDirection: "column" } },
        e(
          "div",
          { style: { display: "flex", alignItems: "flex-end" } },
          e(
            "span",
            { style: { fontSize: s.score.value, fontWeight: 800, color: COLOR, lineHeight: 1 } },
            "93.20"
          ),
          e(
            "span",
            {
              style: {
                fontSize: s.score.outOf,
                color: palette.weak,
                marginLeft: 8,
                marginBottom: 10,
              },
            },
            "/100"
          )
        ),
        e(
          "div",
          {
            style: {
              display: "flex",
              fontSize: s.score.tier,
              fontWeight: 800,
              color: COLOR,
              marginTop: s.score.tierMarginTop,
            },
          },
          "GOD"
        ),
        e(
          "div",
          {
            style: {
              display: "flex",
              fontSize: s.score.label,
              color: palette.muted,
              marginTop: s.score.labelMarginTop,
            },
          },
          "Legendary · Hall of Fame"
        )
      ),
      e(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            backgroundColor: "rgb(0,170,0)",
          },
        },
        e("span", { style: { fontSize: s.beat.value, fontWeight: 800, color: COLOR } }, "94.3%"),
        e("span", { style: { fontSize: s.beat.label, color: palette.muted } }, "ahead of devs")
      )
    ),
    e(
      "div",
      { style: { display: "flex", flexWrap: "wrap", backgroundColor: "rgb(255,0,255)" } },
      ...tags.map((t) =>
        e(
          "div",
          {
            key: t,
            style: {
              display: "flex",
              marginRight: s.tag.marginRight,
              marginTop: s.tag.marginTop,
              padding: s.tag.padding,
              borderRadius: 9999,
              backgroundColor: palette.tagBg,
              color: palette.tagText,
              fontSize: s.tag.fontSize,
              fontWeight: 800,
            },
          },
          `#${t}`
        )
      )
    ),
    e(
      "div",
      {
        style: {
          display: "flex",
          justifyContent: "space-between",
          fontSize: 22,
          backgroundColor: "rgb(0,255,255)",
        },
      },
      e(
        "div",
        { style: { display: "flex", color: palette.subtle } },
        "GitHub Roast · ",
        e("span", { style: { color: "#fb923c", fontWeight: 800, marginLeft: 6 } }, "ghfind.com")
      ),
      e("div", { style: { display: "flex", color: palette.subtle } }, "Powered by LobeHub")
    )
  );
}

async function render(node: React.ReactElement): Promise<Bitmap> {
  // `ImageResponse` wants the exact satori element type; our probes build a
  // plain React tree, which is the same shape at runtime.
  const res = new ImageResponse(node as never, {
    width: W,
    height: H,
    fonts,
  });
  return decodePng(Buffer.from(await res.arrayBuffer()));
}

/** Rasterize the card and recover each probe section's pixel band. */
async function measure(
  tags: string[],
  qr = false,
  geometry: ScoreCardGeometry = SCORE_CARD
): Promise<Bands> {
  const shot = await render(e(ScoreCard, { tags, qr, geometry }));
  const bands = {} as Bands;
  for (const key of Object.keys(PROBE) as Section[]) bands[key] = { start: -1, end: -1 };

  for (let y = 0; y < shot.height; y++) {
    const seen = new Set<Section>();
    for (let x = 40; x < shot.width - 40; x += 2) {
      const i = (y * shot.width + x) * 4;
      for (const key of Object.keys(PROBE) as Section[]) {
        if (seen.has(key)) continue;
        const [r, g, b] = PROBE[key];
        const d =
          Math.abs(shot.data[i] - r) +
          Math.abs(shot.data[i + 1] - g) +
          Math.abs(shot.data[i + 2] - b);
        if (d < 30) {
          if (bands[key].start === -1) bands[key].start = y;
          bands[key].end = y;
          seen.add(key);
        }
      }
    }
  }
  return bands;
}

function gapsOf(b: Bands): number[] {
  return [
    b.score.start - b.header.end - 1,
    b.tags.start - b.score.end - 1,
    b.brand.start - b.tags.end - 1,
  ];
}

/** Tag sets covering the layouts real accounts actually produce. */
const TAG_CASES = [
  { name: "two tags on one row", tags: ["Electerm Lead", "OSS Workhorse"] },
  {
    name: "four tags wrapping to two rows",
    tags: ["Electerm Lead", "Winget Version Maintainer", "OSS Workhorse", "Terminal Godfather"],
  },
  {
    name: "four unusually long tags",
    tags: [
      "Extremely Long Tag Name Here",
      "Another Very Long Tag",
      "Most Extreme Tag Name That Exists",
      "Yet Another Long One",
    ],
  },
];

describe("score card vertical rhythm", () => {
  for (const { name, tags } of TAG_CASES) {
    for (const qr of [false, true]) {
      const label = `${name}${qr ? " with QR panel" : ""}`;

      it(`keeps every section gap at or above rowGap — ${label}`, async () => {
        const b = await measure(tags, qr);
        expect(b.brand.start, "the footer must be rendered").toBeGreaterThan(-1);
        for (const gap of gapsOf(b)) {
          expect(gap).toBeGreaterThanOrEqual(SCORE_CARD.rowGap);
        }
      });

      it(`fits inside the padded canvas — ${label}`, async () => {
        const b = await measure(tags, qr);
        expect(gapsOf(b).every((g) => g >= 0)).toBe(true);
        expect(b.brand.end).toBeLessThanOrEqual(H - 1 - SCORE_CARD.padding);
      });
    }
  }

  it("reproduces the reported defect on the old geometry, and the fix resolves it", async () => {
    // The regression this file exists for. On the previous geometry the tag
    // row outgrew the padded box, `space-between` ran out of free space, every
    // gap collapsed to 0 and the tags touched the `GitHub Roast` footer. The
    // current geometry must clear both bars on the same inputs.
    const tags = TAG_CASES[1].tags;

    const before = await measure(tags, false, LEGACY_SCORE_CARD);
    const beforeGaps = gapsOf(before);
    // The defect: no breathing room at all, and the footer pushed past the
    // 52px bottom inset it is supposed to respect.
    expect(Math.min(...beforeGaps)).toBe(0);
    expect(before.brand.end).toBeGreaterThan(H - 1 - LEGACY_SCORE_CARD.padding);

    const after = await measure(tags, false);
    expect(Math.min(...gapsOf(after))).toBeGreaterThanOrEqual(SCORE_CARD.rowGap);
    expect(after.brand.end).toBeLessThanOrEqual(H - 1 - SCORE_CARD.padding);
  });
});
