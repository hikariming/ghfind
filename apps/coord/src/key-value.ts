import { DurableObject } from "cloudflare:workers";

/**
 * One instance per key (addressed with idFromName(key) by src/lib), providing
 * the single-key Redis operations the app relies on — GET, SET EX, DEL,
 * SET NX EX, INCR + EXPIRE — with the same atomicity: a Durable Object handles
 * one event at a time. Values are structured-cloned over RPC, so callers pass
 * plain JSON-shaped data exactly as they did with the Upstash client.
 *
 * Expiry is enforced on read (an expired value is never returned) and storage
 * is reclaimed by an alarm at the expiry time, so abandoned keys do not
 * accumulate.
 */
export class KeyValue extends DurableObject {
  private live(): { value: unknown } | null {
    const kv = this.ctx.storage.kv;
    const expiresAt = kv.get<number>("exp");
    if (expiresAt !== undefined && Date.now() >= expiresAt) {
      kv.delete("v");
      kv.delete("exp");
      return null;
    }
    const value = kv.get<unknown>("v");
    return value === undefined ? null : { value };
  }

  private write(value: unknown, ttlSeconds?: number): void {
    const kv = this.ctx.storage.kv;
    kv.put("v", value);
    if (ttlSeconds === undefined) {
      kv.delete("exp");
      void this.ctx.storage.deleteAlarm();
    } else {
      const expiresAt = Date.now() + Math.max(1, ttlSeconds) * 1000;
      kv.put("exp", expiresAt);
      void this.ctx.storage.setAlarm(expiresAt);
    }
  }

  /** GET: the value, or null when missing or expired. */
  get(): unknown {
    return this.live()?.value ?? null;
  }

  /** SET [EX ttl]. Without a TTL the key never expires (like plain SET). */
  set(value: unknown, ttlSeconds?: number): void {
    this.write(value, ttlSeconds);
  }

  /** SET NX EX: true when this call created the key. */
  setIfAbsent(value: unknown, ttlSeconds: number): boolean {
    if (this.live()) return false;
    this.write(value, ttlSeconds);
    return true;
  }

  /** DEL: true when a live value was removed. */
  delete(): boolean {
    const existed = this.live() !== null;
    this.ctx.storage.kv.delete("v");
    this.ctx.storage.kv.delete("exp");
    void this.ctx.storage.deleteAlarm();
    return existed;
  }

  /** INCR followed by EXPIRE ttl (the TTL restarts on every increment). */
  incr(ttlSeconds: number): number {
    const current = this.live()?.value;
    const next = (typeof current === "number" ? current : 0) + 1;
    this.write(next, ttlSeconds);
    return next;
  }

  async alarm(): Promise<void> {
    const expiresAt = this.ctx.storage.kv.get<number>("exp");
    // A later write may have extended or cleared the expiry; only reap when due.
    if (expiresAt !== undefined && Date.now() >= expiresAt) await this.ctx.storage.deleteAll();
  }
}
