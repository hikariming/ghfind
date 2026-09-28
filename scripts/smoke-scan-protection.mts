/** Real Redis concurrency test. Start: docker run --rm -p 127.0.0.1:16389:6379 redis:7-alpine */
import { createConnection } from "node:net";
import assert from "node:assert/strict";
import type { Redis } from "@upstash/redis";
import {
  protectedScan,
  ADMIT_SCAN,
  PUBLISH_SCAN,
  RELEASE_SCAN,
  ScanBusyError,
} from "../src/lib/scan-protection";

// Minimal RESP adapter: exercises the production Lua in a disposable local Redis.
async function command(
  ...args: (string | number)[]
): Promise<string | number | null> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: 16389 });
    let buffer = Buffer.alloc(0);
    socket.setTimeout(5000, () => socket.destroy(new Error("Redis timeout")));
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.write(
        `*${args.length}\r\n` +
          args
            .map((a) => {
              const v = String(a);
              return `$${Buffer.byteLength(v)}\r\n${v}\r\n`;
            })
            .join(""),
      ),
    );
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n");
      if (end < 0) return;
      const line = buffer.subarray(1, end).toString(),
        kind = buffer[0];
      if (kind === 36) {
        const n = Number(line);
        if (n === -1) {
          socket.end();
          resolve(null);
        } else if (buffer.length >= end + 2 + n + 2) {
          socket.end();
          resolve(buffer.subarray(end + 2, end + 2 + n).toString());
        }
      } else {
        socket.end();
        if (kind === 45) reject(new Error(line));
        else resolve(kind === 58 ? Number(line) : line);
      }
    });
  });
}
const redis: Pick<Redis, "eval"> = {
  eval: async <A extends unknown[], T>(
    script: string,
    keys: string[],
    args: A,
  ) =>
    (await command(
      "EVAL",
      script,
      keys.length,
      ...keys,
      ...args.map(String),
    )) as T,
};
const prefix = `ghfind-test:${crypto.randomUUID()}`;
const capacityKey = `${prefix}:capacity`;
const wait = () => new Promise<void>((r) => setTimeout(r, 10));
const read = (key: string) => async () => {
  const v = await command("GET", key);
  return v ? (JSON.parse(String(v)) as { score: number }) : null;
};
const created = new Set<string>([capacityKey]);
function opts(name: string, produce: () => Promise<{ score: number }>) {
  const key = `${prefix}:${name}`;
  [key, `lock:${key}`, `cooldown:${key}`].forEach((k) => created.add(k));
  return { redis, key, read: read(key), produce, wait, capacityKey };
}
try {
  let calls = 0;
  const results = await Promise.all(
    Array.from({ length: 50 }, () =>
      protectedScan(
        opts("same", async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 100));
          return { score: 82.7 };
        }),
      ),
    ),
  );
  assert.equal(calls, 1);
  assert.equal(results.length, 50);
  let active = 0,
    max = 0;
  const mixed = await Promise.allSettled(
    Array.from({ length: 30 }, (_, i) =>
      protectedScan(
        opts(`mixed-${i}`, async () => {
          active++;
          max = Math.max(max, active);
          await new Promise((r) => setTimeout(r, 100));
          active--;
          return { score: 82.7 };
        }),
      ),
    ),
  );
  assert.equal(max, 8);
  assert.equal(mixed.filter((x) => x.status === "fulfilled").length, 8);
  assert(
    mixed
      .filter((x) => x.status === "rejected")
      .every(
        (x) => x.status === "rejected" && x.reason instanceof ScanBusyError,
      ),
  );
  const lock = `${prefix}:lease`,
    cache = `${prefix}:cache`,
    cooldown = `${prefix}:cooldown`,
    keys = [lock, capacityKey, cooldown];
  keys.concat(cache).forEach((k) => created.add(k));
  assert.equal(
    await redis.eval(ADMIT_SCAN, keys, ["old", Date.now(), 30, 8]),
    1,
  );
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(
    await redis.eval(ADMIT_SCAN, keys, ["new", Date.now(), 1000, 8]),
    1,
  );
  assert.equal(
    await redis.eval(PUBLISH_SCAN, [lock, cache], ["old", '"stale"', 60]),
    0,
  );
  await redis.eval(RELEASE_SCAN, keys, ["old", "failed"]);
  assert.equal(await command("GET", lock), "new");
  assert.equal(await command("GET", cooldown), null);
  console.log(
    JSON.stringify({
      sameHandleRequests: 50,
      originCalls: calls,
      differentHandles: 30,
      maxConcurrentOrigins: max,
      admitted: 8,
      busy: 22,
      expiredOwnerCannotPublishOrUnlock: true,
    }),
  );
} finally {
  await command("DEL", ...created);
}
