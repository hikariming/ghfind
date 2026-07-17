import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPublicScanStatus: vi.fn(),
}));

vi.mock("@/lib/public-scan", () => ({
  getPublicScanStatus: mocks.getPublicScanStatus,
}));

import { GET } from "./route";

function request(username: string) {
  return GET(new NextRequest(`https://example.test/api/scan-status/${username}`), {
    params: Promise.resolve({ username }),
  });
}

describe("durable scan status API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never creates work when no durable scan was requested", async () => {
    mocks.getPublicScanStatus.mockResolvedValue(null);

    const response = await request("durable-status-case");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "scan_not_found" });
  });

  it("returns a complete snapshot only after public collection finishes", async () => {
    mocks.getPublicScanStatus.mockResolvedValue({
      status: "complete",
      run: { id: "run-id", username: "durable-status-case" },
      scan: { metrics: { username: "durable-status-case" } },
    });

    const response = await request("durable-status-case");

    expect(response.status).toBe(200);
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
