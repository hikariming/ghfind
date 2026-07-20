import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../CampaignLeaderboardClient.tsx", import.meta.url), "utf8");

describe("CampaignLeaderboard", () => {
  it("keeps the campaign context when opening a profile", () => {
    expect(source).toContain('href={`/u/${entry.username}?campaign=${campaign}`}');
  });

  it("refreshes on persisted score events with a two-minute fallback", () => {
    expect(source).toContain("const REFRESH_INTERVAL_MS = 2 * 60 * 1000");
    expect(source).toContain("new EventSource");
    expect(source).toContain("events.onmessage");
    expect(source).toContain("leaderboard?limit=500&live=1");
    expect(source).toContain("window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS)");
    expect(source).toContain('document.visibilityState === "hidden"');
  });
});
