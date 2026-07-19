import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCampaignLeaderboardRevision: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  getCampaignLeaderboardRevision: mocks.getCampaignLeaderboardRevision,
}));

import { GET } from "./route";

const context = { params: Promise.resolve({ campaign: "advx" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCampaignLeaderboardRevision.mockResolvedValue(3);
});

describe("campaign leaderboard events", () => {
  it("opens an SSE stream for a valid campaign", async () => {
    const response = await GET(
      new NextRequest("https://example.test/api/campaigns/advx/leaderboard/events"),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("retry: 2000\n\n");
    await reader.cancel();
  });

  it("falls back cleanly when the cross-instance signal store is unavailable", async () => {
    mocks.getCampaignLeaderboardRevision.mockResolvedValue(null);

    const response = await GET(
      new NextRequest("https://example.test/api/campaigns/advx/leaderboard/events"),
      context,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("15");
  });

  it("emits an event as soon as the persisted revision changes", async () => {
    vi.useFakeTimers();
    mocks.getCampaignLeaderboardRevision.mockResolvedValueOnce(3).mockResolvedValue(4);
    try {
      const response = await GET(
        new NextRequest("https://example.test/api/campaigns/advx/leaderboard/events"),
        context,
      );
      const reader = response.body!.getReader();
      await reader.read(); // retry directive
      const event = reader.read();
      await vi.advanceTimersByTimeAsync(2_000);

      const frame = await event;
      expect(new TextDecoder().decode(frame.value)).toBe("data: 4\n\n");
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
