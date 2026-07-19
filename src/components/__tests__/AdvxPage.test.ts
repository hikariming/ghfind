import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../app/[locale]/advx/page.tsx", import.meta.url),
  "utf8",
);

describe("ADVX group QR", () => {
  it("uses text instead of the copyrighted AdventureX logo asset", () => {
    expect(source).toContain("AdventureX\n              </span>");
    expect(source).not.toContain("adventure-x.svg");
    expect(source).not.toContain("advx-wordmark");
  });

  it("keeps the dark-theme tag on event-page refreshes", () => {
    expect(source).toContain('href="/advx?theme=dark"');
  });

  it("places the cropped QR after the campaign leaderboard", () => {
    const leaderboard = source.indexOf("<CampaignLeaderboard");
    const qr = source.indexOf('src="/advx-wechat-group-qr-source.jpg"');

    expect(leaderboard).toBeGreaterThan(-1);
    expect(qr).toBeGreaterThan(leaderboard);
    expect(source).toContain('groupQrLabel: "Ghfind x ADVX 现场交流群"');
    expect(source).toContain('max-w-[11rem]');
    expect(source).toContain('whitespace-nowrap text-sm');
    expect(source).toContain('style={{ width: "149.42%", left: "-25.8%", top: "-71.74%" }}');
  });
});
