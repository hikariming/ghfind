import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMaterialCardSvg } from "../material-card";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { TierAvatarFrame } from "@/components/TierAvatarFrame";

/**
 * Owner rule: never place emoji / tier decoration stickers around the avatar.
 * Realm glyphs belong only next to the realm label. Avatar = ring/glow (+ orbit).
 */
describe("avatar has no emoji stickers", () => {
  it("TierAvatarFrame markup has no emoji or tier-icon image around the face", () => {
    const html = renderToStaticMarkup(
      React.createElement(TierAvatarFrame, {
        username: "demo",
        avatarUrl: null,
        score: 95,
        size: "lg",
      }),
    );
    for (const banned of ["🏆", "🥇", "🌱", "📜", "😐", "💩", "👑", "🎖️"]) {
      expect(html).not.toContain(banned);
    }
    expect(html).not.toContain("tier-icon");
    expect(html).not.toContain("tierIcon");
    expect(html).not.toContain("emoji");
    // Ring/glow shell is present via data-realm
    expect(html).toContain('data-realm="mahayana"');
  });

  it("material card SVG does not render sticker images around the avatar", () => {
    const svg = renderMaterialCardSvg({
      username: "demo",
      displayName: null,
      avatar: null,
      score: 95,
      tier: "夯",
      tierLabel: "大道将成 · 殿堂标杆",
      tags: ["示例"],
      scores: {
        account_maturity: 9,
        original_project_quality: 14,
        contribution_quality: 16,
        ecosystem_impact: 9,
        community_influence: 3,
        activity_authenticity: 3,
      },
      color: "#F6C744",
      theme: "dark",
      qr: null,
      tierIcon: "data:image/svg+xml;base64,SHOULD_NOT_RENDER",
      sponsorLogo: null,
    });
    expect(svg).not.toContain("SHOULD_NOT_RENDER");
    // Only brand/sponsor/qr images may appear — never a sticker keyed near avatar coords
    expect(svg).not.toMatch(/<image[^>]+x="91"[^>]+y="24"/);
  });

  it("OG card source no longer maps tier frame placements onto the avatar", () => {
    const src = readFileSync(
      join(__dirname, "../../app/api/card/[username]/cards.tsx"),
      "utf8",
    );
    expect(src).not.toContain("frame.placements");
    expect(src).not.toContain("TIER_AVATAR_FRAME_VECTORS");
    expect(src).not.toContain("avatarFrameIconPosition");
    expect(src).toContain("no emoji stickers");
  });

  it("ShareCard uses TierAvatarFrame (ring only) rather than emoji ornaments", () => {
    const share = readFileSync(join(__dirname, "../../components/ShareCard.tsx"), "utf8");
    expect(share).toContain("TierAvatarFrame");
    expect(share).not.toMatch(/tierIcon|frame\.placements|TIER_AVATAR_FRAME/);
  });
});
