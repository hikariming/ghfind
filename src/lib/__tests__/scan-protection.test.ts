import { describe, expect, it, vi } from "vitest";
import type { Redis } from "@upstash/redis";
import { protectedScan, ScanBusyError, scanTtl } from "../scan-protection";

function client(admission: number) {
  const evalMock = vi.fn<Redis["eval"]>().mockResolvedValue(admission);
  const redis = { eval: evalMock };
  return { redis, evalMock };
}
describe("cold scan admission", () => {
  it("never produces after a follower times out", async () => {
    const { redis } = client(0),
      produce = vi.fn();
    await expect(
      protectedScan({
        redis,
        key: "scan:test",
        read: async () => null,
        produce,
        wait: async () => {},
        attempts: 3,
      }),
    ).rejects.toBeInstanceOf(ScanBusyError);
    expect(produce).not.toHaveBeenCalled();
  });
  it("does not bypass distributed protection on an outage or global capacity limit", async () => {
    for (const outage of [false, true]) {
      const { redis, evalMock } = client(-1),
        produce = vi.fn();
      if (outage) evalMock.mockRejectedValue(new Error("offline"));
      await expect(
        protectedScan({
          redis,
          key: "scan:test",
          read: async () => null,
          produce,
        }),
      ).rejects.toBeInstanceOf(ScanBusyError);
      expect(produce).not.toHaveBeenCalled();
    }
  });
  it("rechecks after acquiring the lock, avoiding a race with a completed owner", async () => {
    const { redis } = client(1),
      produce = vi.fn(),
      read = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ score: 82 });
    expect(
      await protectedScan({ redis, key: "scan:test", read, produce }),
    ).toEqual({ score: 82 });
    expect(produce).not.toHaveBeenCalled();
  });
  it("retries admission rather than producing without a lock after an owner finishes", async () => {
    const { redis, evalMock } = client(1),
      produce = vi.fn().mockResolvedValue({ score: 82 });
    evalMock.mockResolvedValueOnce(0);
    await expect(
      protectedScan({
        redis,
        key: "scan:test",
        read: async () => null,
        produce,
        wait: async () => {},
      }),
    ).resolves.toEqual({ score: 82 });
    expect(produce).toHaveBeenCalledTimes(1);
    expect(evalMock.mock.calls[2][0]).toContain("GET");
  });
  it("rejects a producer that has lost ownership before publishing", async () => {
    const { redis, evalMock } = client(1);
    evalMock.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await expect(
      protectedScan({
        redis,
        key: "scan:test",
        read: async () => null,
        produce: async () => ({ score: 82 }),
      }),
    ).rejects.toBeInstanceOf(ScanBusyError);
    expect(evalMock.mock.calls.at(-1)?.[2]).toEqual([
      expect.any(String),
      "failed",
    ]);
  });
  it("adds a failure cooldown without swallowing the producer error", async () => {
    const { redis, evalMock } = client(1),
      error = new Error("GitHub down");
    await expect(
      protectedScan({
        redis,
        key: "scan:test",
        read: async () => null,
        produce: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(evalMock.mock.calls.at(-1)?.[2]).toEqual([
      expect.any(String),
      "failed",
    ]);
  });
  it("spreads expiration over 22–24h", () => {
    const values = Array.from({ length: 100 }, scanTtl);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(79200);
    expect(Math.max(...values)).toBeLessThanOrEqual(86400);
    expect(new Set(values).size).toBeGreaterThan(20);
  });
});
