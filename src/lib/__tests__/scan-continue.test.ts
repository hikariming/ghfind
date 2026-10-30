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
  discardIncrementalCursor: vi.fn(),
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

  it("deepens a truncated quick scan within the existing pending owner before publication", async () => {
    const partial = { metrics: { username: "fiction-highfork" }, collection: {
      mode: "quick", coverage: "partial_public", truncation_reasons: ["public_repos_quick_limit"],
    } };
    const complete = { ...partial, collection: { mode: "full", coverage: "complete_public", truncation_reasons: [] } };
    mocks.buildScanResult.mockResolvedValueOnce(partial).mockResolvedValueOnce(complete);
    await expect(completeBackgroundScan("fiction-highfork", "owner-a")).resolves.toMatchObject({ ok: true });
    expect(mocks.buildScanResult).toHaveBeenNthCalledWith(2, "fiction-highfork", {
      full: true, deadlineMs: expect.any(Number),
    });
    expect(mocks.publishCompleteQuickScan).toHaveBeenCalledExactlyOnceWith(complete, expect.any(Number));
    expect(JSON.parse(mocks.publish.mock.calls[0][1]).collection.coverage).toBe("complete_public");
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

  it("does not mistake the warm baseline for a completed full refresh", async () => {
    mocks.pending.mockResolvedValue({ owner: "owner-a", username: "fiction-highfork", startedAt: 1, full: true, refresh: true });
    mocks.payload.mockResolvedValue(JSON.stringify({ metrics: { username: "fiction-highfork" }, collection: { mode: "quick", coverage: "partial_public" } }));
    await expect(completeBackgroundScan("fiction-highfork", "owner-a")).resolves.toMatchObject({ status: "published" });
    expect(mocks.buildScanResult).toHaveBeenCalledExactlyOnceWith("fiction-highfork", { full: true, deadlineMs: 300_000 });
  });
});
