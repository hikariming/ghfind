import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getGoPublicData: vi.fn() }));

vi.mock("@/lib/go-backend.server", () => ({
  getGoPublicData: mocks.getGoPublicData,
}));

import { GET } from "./route";

describe("GET /api/badge/{username}", () => {
  beforeEach(() => {
    mocks.getGoPublicData.mockReset();
  });

  it("keeps the SVG contract while reading its presentation model from Go", async () => {
    mocks.getGoPublicData.mockResolvedValue({
      final_score: 88.5,
      tier: "顶级",
      delta: 1.2,
    });
    const response = await GET(new NextRequest("https://example.test/api/badge/OctoCat"), {
      params: Promise.resolve({ username: "OctoCat" }),
    });

    expect(response.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=0, s-maxage=21600, stale-while-revalidate=86400",
    );
    await expect(response.text()).resolves.toContain("88.50 ELITE ↑1.2");
    expect(mocks.getGoPublicData).toHaveBeenCalledWith("/api/embed/badge/OctoCat");
  });

  it("keeps an unrated SVG instead of executing a Next data fallback", async () => {
    mocks.getGoPublicData.mockResolvedValue(null);
    const response = await GET(new NextRequest("https://example.test/api/badge/octocat"), {
      params: Promise.resolve({ username: "octocat" }),
    });

    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
    );
    await expect(response.text()).resolves.toContain("unrated");
  });

  it("does not call Go for an invalid path username", async () => {
    const response = await GET(new NextRequest("https://example.test/api/badge/@octocat"), {
      params: Promise.resolve({ username: "@octocat" }),
    });

    await expect(response.text()).resolves.toContain("unrated");
    expect(mocks.getGoPublicData).not.toHaveBeenCalled();
  });
});
