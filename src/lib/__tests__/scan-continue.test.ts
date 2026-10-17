import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pending: vi.fn(),
  payload: vi.fn(),
  publish: vi.fn(),
  release: vi.fn(),
  renew: vi.fn(),
  buildScanResult: vi.fn(),
  publishCompleteQuickScan: vi.fn(),
  logFreshScanFailure: vi.fn(),
}));

vi.mock("../scan-slots", () => ({
  scanSlots: () => ({ idFromName: (n: string) => n, get: () => ({
    pending: mocks.pending,
    payload: mocks.payload,
    publish: mocks.publish,
    release: mocks.release,
    renew: mocks.renew,
  }) }),
  scanSlot: (_ns: unknown, _key: string) => ({
    pending: mocks.pending,
    payload: mocks.payload,
    publish: mocks.publish,
    release: mocks.release,
    renew: mocks.renew,
  }),
  parsePayload: (value: string | null) => (value === null ? null : JSON.parse(value)),
}));
vi.mock("../scan-core", () => ({
  buildScanResult: mocks.buildScanResult,
  logFreshScanFailure: mocks.logFreshScanFailure,
}));
vi.mock("../db", () => ({
  publishCompleteQuickScan: mocks.publishCompleteQuickScan,
}));
vi.mock("../redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../redis")>();
  return { ...actual, scanKey: (username: string) => `scan:v5:${username.toLowerCase()}` };
});

import { completeBackgroundScan } from "../scan-continue";

describe("completeBackgroundScan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pending.mockResolvedValue({ owner: "owner-a", username: "tj", startedAt: 1 });
    mocks.payload.mockResolvedValue(null);
    mocks.renew.mockResolvedValue(1);
    mocks.publish.mockResolvedValue(1);
    mocks.release.mockResolvedValue(undefined);
    mocks.publishCompleteQuickScan.mockResolvedValue(true);
    mocks.buildScanResult.mockResolvedValue({
      metrics: { username: "tj" },
      scoring: { final_score: 1 },
    });
  });

  it("skips GitHub when the caller is no longer the owner", async () => {
    mocks.pending.mockResolvedValue({ owner: "other", username: "tj", startedAt: 1 });
    await expect(completeBackgroundScan("tj", "owner-a")).resolves.toEqual({
      ok: false,
      status: "owner_mismatch",
    });
    expect(mocks.buildScanResult).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("publishes only while the owner still holds the lease", async () => {
    await expect(completeBackgroundScan("tj", "owner-a")).resolves.toEqual({
      ok: true,
      status: "published",
    });
    expect(mocks.buildScanResult).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledWith(
      "owner-a",
      expect.any(String),
      expect.any(Number),
      true,
      expect.any(Number),
    );
    expect(mocks.release).toHaveBeenCalledWith("owner-a", false, "scan:active-producers:v1");
  });

  it("does not overwrite after the owner is gone", async () => {
    mocks.renew.mockResolvedValue(0);
    await expect(completeBackgroundScan("tj", "owner-a")).resolves.toEqual({
      ok: false,
      status: "lease_lost",
    });
    expect(mocks.buildScanResult).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("skips GitHub when a payload is already published", async () => {
    mocks.payload.mockResolvedValue(JSON.stringify({ metrics: { username: "tj" } }));
    await expect(completeBackgroundScan("tj", "owner-a")).resolves.toEqual({
      ok: true,
      status: "already_published",
    });
    expect(mocks.buildScanResult).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith("owner-a", false, "scan:active-producers:v1");
  });
});
