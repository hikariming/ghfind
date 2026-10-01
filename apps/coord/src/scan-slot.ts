import { DurableObject } from "cloudflare:workers";

/**
 * Everything the Redis Lua scripts in src/lib/scan-protection.ts touched for
 * ONE protected key — payload, producer lock, failure cooldown, publication
 * revision — held in one Durable Object (idFromName(key)), so each script
 * becomes a single atomic method. Only the global capacity pool lives
 * elsewhere (ScanCapacity).
 *
 * Every field carries its own expiry, enforced on read; an alarm reclaims
 * storage once everything has expired.
 */

type Field = "payload" | "lock" | "cooldown" | "revision";

interface Entry {
  value: string;
  expiresAt: number;
}

interface Env {
  SCAN_CAPACITY: DurableObjectNamespace<import("./scan-capacity").ScanCapacity>;
}

export class ScanSlot extends DurableObject<Env> {
  private read(field: Field, now = Date.now()): string | null {
    const entry = this.ctx.storage.kv.get<Entry>(field);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.ctx.storage.kv.delete(field);
      return null;
    }
    return entry.value;
  }

  private write(field: Field, value: string, ttlMs: number): void {
    this.ctx.storage.kv.put(field, { value, expiresAt: Date.now() + ttlMs } satisfies Entry);
    this.scheduleReclaim();
  }

  private scheduleReclaim(): void {
    let latest = 0;
    for (const [, entry] of this.ctx.storage.kv.list<Entry>()) latest = Math.max(latest, entry.expiresAt);
    if (latest) void this.ctx.storage.setAlarm(latest);
  }

  /** GET payload. */
  payload(): string | null {
    return this.read("payload");
  }

  /** SET payload EX ttl (plain cache write, outside admission). */
  setPayload(value: string, ttlSeconds: number): void {
    this.write("payload", value, ttlSeconds * 1000);
  }

  /** DEL payload. */
  clearPayload(): void {
    this.ctx.storage.kv.delete("payload");
  }

  /** GET revision (publication marker). */
  revision(): string | null {
    return this.read("revision");
  }

  /** READ_REFRESHED_SCAN: the payload only once a publication newer than `baseline` exists. */
  payloadAfter(baseline: string): string | null {
    const revision = this.read("revision");
    if (!revision || revision === baseline) return null;
    return this.read("payload");
  }

  /**
   * ADMIT_SCAN: 0 while another producer holds the lock, -1 during a failure
   * cooldown or when the global pool is full, 1 when `owner` now holds the lock
   * and a capacity lease.
   */
  async admit(owner: string, leaseMs: number, capacityKey: string, capacity: number): Promise<number> {
    if (this.read("lock")) return 0;
    if (this.read("cooldown")) return -1;
    // Claim the lock BEFORE the outbound capacity call: other events may run
    // while it is in flight, and they must see this key as taken.
    this.write("lock", owner, leaseMs);
    let leased = false;
    try {
      const pool = this.env.SCAN_CAPACITY.get(this.env.SCAN_CAPACITY.idFromName(capacityKey));
      leased = await pool.acquire(owner, leaseMs, capacity);
    } finally {
      if (!leased && this.read("lock") === owner) this.ctx.storage.kv.delete("lock");
    }
    return leased ? 1 : -1;
  }

  /** PUBLISH_SCAN: store the result only if `owner` still holds the lock. */
  publish(owner: string, payload: string, ttlSeconds: number, withRevision: boolean): number {
    if (this.read("lock") !== owner) return 0;
    this.write("payload", payload, ttlSeconds * 1000);
    if (withRevision) this.write("revision", owner, ttlSeconds * 1000);
    return 1;
  }

  /** RELEASE_SCAN: drop our lock (+15s cooldown on failure) and our capacity lease. */
  async release(owner: string, failed: boolean, capacityKey: string): Promise<void> {
    if (this.read("lock") === owner) {
      this.ctx.storage.kv.delete("lock");
      if (failed) this.write("cooldown", "1", 15_000);
    }
    const pool = this.env.SCAN_CAPACITY.get(this.env.SCAN_CAPACITY.idFromName(capacityKey));
    await pool.release(owner);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const field of ["payload", "lock", "cooldown", "revision"] as const) this.read(field, now);
    const remaining = [...this.ctx.storage.kv.list<Entry>()];
    if (remaining.length === 0) await this.ctx.storage.deleteAll();
    else this.scheduleReclaim();
  }
}
