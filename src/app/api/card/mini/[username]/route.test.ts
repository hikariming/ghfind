import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  presentation: vi.fn(),
}));

vi.mock("@/lib/go-profile.server", () => ({
  getGoProfileCardPresentation: mocks.presentation,
}));
vi.mock("@/lib/sponsor.server", () => ({
  getCurrentTitleSponsor: async () => null,
}));

import { SCORE_CARD_CACHE } from "../../assets";
import { GET } from "./route";

const scores = {
  account_maturity: 9,
  original_project_quality: 14.1,
  contribution_quality: 21,
  ecosystem_impact: 12,
  community_influence: 5,
  activity_authenticity: 14,
};

function presentation(finalScore: number, scannedAt: number) {
  return {
    detail: {
      username: "fixture-user",
      display_name: "Fixture User",
      avatar_url: null,
      final_score: finalScore,
      tier: "人上人",
      sub_scores: scores,
      scanned_at: scannedAt,
    },
    snapshot: null,
    rank: { rank: 2000, total: 20000, below: 18000 },
    percentile: null,
    delta: 3.3,
  };
}

const get = (query = "") =>
  GET(new Request(`https://ghfind.com/api/card/mini/fixture-user${query}`), {
    params: Promise.resolve({ username: "fixture-user" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mini card cache policy", () => {
  it("uses a short edge TTL so a rescan reaches embeds within minutes", async () => {
    mocks.presentation.mockResolvedValue(presentation(76.7, 1_700_000_000_000));
    const res = await get("?lang=zh");
    const cacheControl = res.headers.get("Cache-Control") ?? "";
    expect(cacheControl).toBe(SCORE_CARD_CACHE);
    expect(cacheControl).toMatch(/\bmax-age=0\b/);
    expect(cacheControl).not.toMatch(/immutable/);
    const sMaxAge = Number(/s-maxage=(\d+)/.exec(cacheControl)?.[1]);
    expect(sMaxAge).toBeGreaterThan(0);
    expect(sMaxAge).toBeLessThanOrEqual(600);
    expect(await res.text()).toContain("Lv.76");
  });

  it("renders the latest scan, ignoring the version param", async () => {
    mocks.presentation.mockResolvedValue(presentation(82.9, 1_700_000_600_000));
    const res = await get("?lang=zh&v=1700000000000");
    expect(await res.text()).toContain("Lv.82");
  });
});
