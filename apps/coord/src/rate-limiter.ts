import { DurableObject } from "cloudflare:workers";
import { slidingWindowLimit, type SlidingWindowResult } from "./sliding-window";

/**
 * One instance per limited key (`<prefix>:<identifier>`, e.g. `rl:scan:1.2.3.4`),
 * addressed with idFromName by the callers in src/lib. A Durable Object runs one
 * event at a time, so read-check-increment is atomic like the Upstash Lua
 * script it replaces. Counters live in the object's SQLite-backed storage (so
 * eviction does not reset a budget) and an alarm deletes them once both the
 * current and previous windows have passed.
 */
export class RateLimiter extends DurableObject {
  limit(tokens: number, windowMs: number): SlidingWindowResult {
    if (!(tokens > 0) || !(windowMs > 0)) throw new Error("invalid rate limit");
    const kv = this.ctx.storage.kv;
    const now = Date.now();
    const result = slidingWindowLimit(
      {
        get: (index) => kv.get<number>(`w:${index}`) ?? 0,
        set: (index, count) => kv.put(`w:${index}`, count),
      },
      tokens,
      windowMs,
      now,
    );
    // Drop windows that can no longer be weighted (anything before previous).
    const current = Math.floor(now / windowMs);
    for (const [key] of kv.list<number>({ prefix: "w:" })) {
      if (Number(key.slice(2)) < current - 1) kv.delete(key);
    }
    // Same lifetime as Upstash's PEXPIRE(window * 2 + 1000) on the counter.
    void this.ctx.storage.setAlarm(now + windowMs * 2 + 1000);
    return result;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
