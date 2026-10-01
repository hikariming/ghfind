import { describe, expect, it } from "vitest";
import { gcNextCache, selectDoomed, type GcBucket, type GcObject } from "../next-cache-gc";

const DAY = 86_400_000;
const NOW = 1_000 * DAY;

/** Minimal R2 stand-in: sorted keys, prefix/delimiter listing, pagination. */
function fakeBucket(objects: GcObject[]) {
  const store = new Map(objects.map((o) => [o.key, o]));
  const calls = { list: 0, delete: 0 };
  const bucket: GcBucket = {
    async list({ prefix = "", delimiter, cursor, limit = 1000 }) {
      calls.list++;
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (delimiter) {
        const dirs = [...new Set(keys.map((k) => k.slice(prefix.length)).filter((r) => r.includes(delimiter)).map((r) => prefix + r.slice(0, r.indexOf(delimiter) + 1)))];
        return { objects: [], delimitedPrefixes: dirs, truncated: false };
      }
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit).map((k) => store.get(k)!);
      const truncated = start + limit < keys.length;
      return { objects: page, delimitedPrefixes: [], truncated, cursor: truncated ? String(start + limit) : undefined };
    },
    async delete(keys) {
      calls.delete++;
      keys.forEach((k) => store.delete(k));
    },
    async put() {},
  };
  return { bucket, store, calls };
}

function build(id: string, count: number, lastWriteDaysAgo: number): GcObject[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `incremental-cache/${id}/${String(i).padStart(5, "0")}.cache`,
    // Oldest object 30 days back; the newest one sets the build's last write.
    uploaded: new Date(NOW - (i === 0 ? lastWriteDaysAgo : 30) * DAY),
  }));
}

const opts = { root: "incremental-cache/", keepNewest: 2, minIdleMs: 3 * DAY, now: NOW, dryRun: false, maxOps: 1_000 };

describe("selectDoomed", () => {
  it("keeps the newest builds and anything written recently", () => {
    const builds = [
      { prefix: "a/", objects: 1, newestUpload: NOW - 20 * DAY },
      { prefix: "b/", objects: 1, newestUpload: NOW - 1 * DAY }, // newest
      { prefix: "c/", objects: 1, newestUpload: NOW - 2 * DAY }, // 2nd newest
      { prefix: "d/", objects: 1, newestUpload: NOW - 2.5 * DAY }, // outside top 2 but still active
      { prefix: "e/", objects: 1, newestUpload: NOW - 10 * DAY },
    ];
    expect(selectDoomed(builds, 2, 3 * DAY, NOW).sort()).toEqual(["a/", "e/"]);
  });
});

describe("gcNextCache", () => {
  it("deletes old idle builds across pages and keeps live ones", async () => {
    const { bucket, store } = fakeBucket([
      ...build("old1", 2_500, 20),
      ...build("old2", 10, 9),
      ...build("live", 1_200, 0.5),
      ...build("prev", 5, 2.5), // outside the newest 2 but written within minIdle
      ...build("preview", 3, 1), // a PR preview still in use
    ]);
    const report = await gcNextCache(bucket, opts);

    expect(report.complete).toBe(true);
    expect(report.doomed.sort()).toEqual(["incremental-cache/old1/", "incremental-cache/old2/"]);
    expect(report.deletedObjects).toBe(2_510);
    const left = new Set([...store.keys()].map((k) => k.split("/")[1]));
    expect([...left].sort()).toEqual(["live", "prev", "preview"]);
  });

  it("dry run reports without deleting", async () => {
    const { bucket, store, calls } = fakeBucket([...build("old", 5, 30), ...build("a", 1, 0), ...build("b", 1, 0)]);
    const report = await gcNextCache(bucket, { ...opts, dryRun: true });
    expect(report.doomed).toEqual(["incremental-cache/old/"]);
    expect(store.size).toBe(7);
    expect(calls.delete).toBe(0);
  });

  it("stops at the op budget and finishes on a later run", async () => {
    const { bucket, store } = fakeBucket([...build("old", 3_000, 30), ...build("a", 1, 0), ...build("b", 1, 0)]);
    // 1 prefix list + 3 + 1 + 1 scans = 6 ops, leaving 4 for delete: two list+delete rounds.
    const first = await gcNextCache(bucket, { ...opts, maxOps: 10 });
    expect(first.complete).toBe(false);
    expect(first.deletedObjects).toBe(2_000);
    const second = await gcNextCache(bucket, opts);
    expect(second.complete).toBe(true);
    expect([...store.keys()].every((k) => !k.includes("/old/"))).toBe(true);
  });

  it("never deletes on a partial scan", async () => {
    const { bucket, calls } = fakeBucket([...build("old", 5, 30), ...build("a", 5_000, 0), ...build("b", 1, 0)]);
    const report = await gcNextCache(bucket, { ...opts, maxOps: 3 });
    expect(report.complete).toBe(false);
    expect(report.doomed).toEqual([]);
    expect(calls.delete).toBe(0);
  });

  it("stops at the wall-clock deadline without deleting on a partial scan", async () => {
    const { bucket, calls } = fakeBucket([...build("old", 5, 30), ...build("a", 1, 0), ...build("b", 1, 0)]);
    const report = await gcNextCache(bucket, { ...opts, deadline: Date.now() - 1 });
    expect(report.complete).toBe(false);
    expect(report.ops).toBe(0);
    expect(calls.delete).toBe(0);
  });

  it("does nothing when there are no more builds than it keeps", async () => {
    const { bucket, calls } = fakeBucket([...build("a", 3, 40), ...build("b", 3, 50)]);
    const report = await gcNextCache(bucket, opts);
    expect(report.doomed).toEqual([]);
    expect(calls.delete).toBe(0);
  });
});
