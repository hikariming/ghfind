import { describe, expect, it, vi } from "vitest";
import type { Redis } from "@upstash/redis";
import {
  protectedScan,
  ScanBusyError,
  ScanPendingError,
  scanTtl,
  SCAN_LEASE_MS,
  SCAN_WAIT_MS,
  SCAN_BACKGROUND_LEASE_MS,
  SCAN_CONTINUE_WAIT_MS,
  BACKGROUND_COLLECT_DEADLINE_MS,
  SCAN_STALE_TTL_SECONDS,
  PUBLISH_SCAN,
} from "../scan-protection";
import { COLLECT_DEADLINE_MS } from "../github";

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
  it("uses a producer lease shorter than Cloudflare's ~100s 524", async () => {
    const { redis, evalMock } = client(1);
    await protectedScan({
      redis,
      key: "scan:test",
      read: async () => null,
      produce: async () => ({ score: 82 }),
    });
    expect(evalMock.mock.calls[0]?.[2]?.[2]).toBe(SCAN_LEASE_MS);
    expect(SCAN_LEASE_MS).toBeLessThan(100_000);
    expect(SCAN_WAIT_MS).toBeLessThan(SCAN_LEASE_MS);
    expect(SCAN_WAIT_MS).toBeGreaterThan(45_000);
  });
  it("spreads expiration over 22–24h", () => {
    const values = Array.from({ length: 100 }, scanTtl);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(79200);
    expect(Math.max(...values)).toBeLessThanOrEqual(86400);
    expect(new Set(values).size).toBeGreaterThan(20);
  });
  it("keeps the interactive wait aligned with the GitHub collect deadline", () => {
    expect(SCAN_CONTINUE_WAIT_MS).toBe(COLLECT_DEADLINE_MS);
    expect(SCAN_BACKGROUND_LEASE_MS).toBeGreaterThan(BACKGROUND_COLLECT_DEADLINE_MS);
    expect(BACKGROUND_COLLECT_DEADLINE_MS).toBeGreaterThan(SCAN_CONTINUE_WAIT_MS);
  });

  it("defers produce on continueProduce and does not release the owner", async () => {
    const release = vi.fn();
    const produce = vi.fn();
    const coordinator = {
      admit: async () => 1,
      publish: vi.fn(),
      release,
      pending: async () => null,
    };
    await expect(
      protectedScan({
        coordinator,
        key: "scan:test",
        read: async () => null,
        produce,
        continueProduce: async () => "deferred",
        continueWaitMs: 0,
        wait: async () => {},
      }),
    ).rejects.toBeInstanceOf(ScanPendingError);
    expect(produce).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("produces inline when continueProduce cannot defer", async () => {
    const release = vi.fn(async () => {});
    const produce = vi.fn(async () => ({ score: 82 }));
    const coordinator = {
      admit: async () => 1,
      publish: vi.fn(async () => 1),
      release,
      pending: async () => null,
    };
    await expect(
      protectedScan({
        coordinator,
        key: "scan:test",
        read: async () => null,
        produce,
        continueProduce: async () => "inline",
      }),
    ).resolves.toEqual({ score: 82 });
    expect(produce).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(expect.any(String), false);
  });

  it("returns 202-style pending for waiters while an owner is still collecting", async () => {
    const produce = vi.fn();
    const admit = vi.fn(async () => 0);
    const coordinator = {
      admit,
      publish: vi.fn(),
      release: vi.fn(),
      pending: async () => ({ owner: "a", username: "tj", startedAt: 1 }),
    };
    await expect(
      protectedScan({
        coordinator,
        key: "scan:test",
        read: async () => null,
        produce,
        continueProduce: async () => "deferred",
        wait: async () => {},
        attempts: 3,
      }),
    ).rejects.toBeInstanceOf(ScanPendingError);
    expect(produce).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it("writes the 7-day stale shadow only while the owner still holds the lock", async () => {
    const { redis, evalMock } = client(1);
    await protectedScan({
      redis,
      key: "scan:v5:demo",
      read: async () => null,
      produce: async () => ({ score: 82 }),
      staleTtl: SCAN_STALE_TTL_SECONDS,
    });
    const publish = evalMock.mock.calls.find((call) => call[0] === PUBLISH_SCAN);
    expect(publish?.[1]).toEqual(["lock:scan:v5:demo", "scan:v5:demo", "", "scan:v5:demo:stale"]);
    expect(publish?.[2]?.[3]).toBe(SCAN_STALE_TTL_SECONDS);
    expect(SCAN_STALE_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});
