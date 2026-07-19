import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPublicScanStatus: vi.fn(),
  checkPublicScanStatusRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(),
}));

vi.mock("@/lib/public-scan", () => ({
  getPublicScanStatus: mocks.getPublicScanStatus,
}));

vi.mock("@/lib/redis", () => ({
  checkPublicScanStatusRateLimit: mocks.checkPublicScanStatusRateLimit,
  rateLimitHeaders: mocks.rateLimitHeaders,
}));

import { GET } from "./route";

function request(username: string, runId = "run-id") {
  return GET(new NextRequest(`https://example.test/api/scan-status/${username}?run_id=${runId}`), {
    params: Promise.resolve({ username }),
  });
}

describe("durable scan status API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkPublicScanStatusRateLimit.mockResolvedValue({ success: true });
    mocks.rateLimitHeaders.mockReturnValue({});
  });

  it("never creates work when no durable scan was requested", async () => {
    mocks.getPublicScanStatus.mockResolvedValue(null);

    const response = await request("durable-status-case");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "scan_not_found" });
  });

  it("requires the opaque run id before it reads a durable scan", async () => {
    const response = await GET(new NextRequest("https://example.test/api/scan-status/durable-status-case"), {
      params: Promise.resolve({ username: "durable-status-case" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.getPublicScanStatus).not.toHaveBeenCalled();
  });

  it("rate-limits repeated status reads before they reach Turso", async () => {
    mocks.checkPublicScanStatusRateLimit.mockResolvedValue({ success: false });
    mocks.rateLimitHeaders.mockReturnValue({ "Retry-After": "60" });

    const response = await request("durable-status-case");

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(mocks.getPublicScanStatus).not.toHaveBeenCalled();
  });

  it("returns a retryable 503 before Turso when request protection is unavailable", async () => {
    mocks.checkPublicScanStatusRateLimit.mockResolvedValue({ success: false, unavailable: true, retryAfter: 15 });
    mocks.rateLimitHeaders.mockReturnValue({ "Retry-After": "15" });

    const response = await request("durable-status-case");

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("15");
    await expect(response.json()).resolves.toEqual({ error: "rate_limit_unavailable", retry_after: 15 });
    expect(mocks.getPublicScanStatus).not.toHaveBeenCalled();
  });

  it("returns a complete snapshot only after public collection finishes", async () => {
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "complete",
      run: { id: "run-id", username: "durable-status-case" },
      scan: { metrics: { username: "durable-status-case" } },
    });

    const response = await request("durable-status-case");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=60");
    await expect(response.json()).resolves.toEqual({
      status: "complete_public",
      username: "durable-status-case",
      run_id: "run-id",
      scan: { metrics: { username: "durable-status-case" } },
    });
  });

  it("uses retryable pending and failed states without publishing a partial scan", async () => {
    mocks.getPublicScanStatus.mockResolvedValueOnce({
      status: "pending",
      run: { id: "run-id", username: "durable-status-case" },
      retryAfterSeconds: 7,
    });
    const pending = await request("durable-status-case");
    expect(pending.status).toBe(202);
    expect(pending.headers.get("Retry-After")).toBe("7");
    expect(pending.headers.get("Cache-Control")).toContain("s-maxage=5");
    await expect(pending.json()).resolves.toMatchObject({ status: "pending", run_id: "run-id" });

    mocks.getPublicScanStatus.mockResolvedValueOnce({
      status: "failed",
      run: { id: "run-id", username: "durable-status-case" },
      retryAfterSeconds: 30,
    });
    const failed = await request("durable-status-case");
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toMatchObject({ error: "durable_scan_failed" });
  });
});
