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

type Field = "payload" | "lock" | "cooldown" | "revision" | "stale" | "pending";

interface Entry {
  value: string;
  expiresAt: number;
}

export interface ScanPending {
  owner: string;
  username: string;
  startedAt: number;
}

interface ScanContinueApi {
  run(username: string, owner: string): Promise<{ ok: boolean; status: string }>;
}

interface Env {
  SCAN_CAPACITY: DurableObjectNamespace<import("./scan-capacity").ScanCapacity>;
  /** ghfind-api ScanContinueEntrypoint — runs collect with GitHub tokens. */
  GHFIND_API?: ScanContinueApi;
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

  /** GET the 7-day stale shadow written only by a successful owner publish. */
  stalePayload(): string | null {
    return this.read("stale");
  }

  /** SET payload EX ttl (plain cache write, outside admission). */
  setPayload(value: string, ttlSeconds: number): void {
    this.write("payload", value, ttlSeconds * 1000);
  }

  /** DEL payload and its stale shadow. */
  clearPayload(): void {
    this.ctx.storage.kv.delete("payload");
    this.ctx.storage.kv.delete("stale");
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
  publish(
    owner: string,
    payload: string,
    ttlSeconds: number,
    withRevision: boolean,
    staleTtlSeconds = 0,
  ): number {
    if (this.read("lock") !== owner) return 0;
    this.ctx.storage.kv.delete("pending");
    this.write("payload", payload, ttlSeconds * 1000);
    if (withRevision) this.write("revision", owner, ttlSeconds * 1000);
    if (staleTtlSeconds > 0) this.write("stale", payload, staleTtlSeconds * 1000);
    return 1;
  }

  /**
   * Arm background collect for this owner. 1 = alarm scheduled, 0 = not the
   * owner, -1 = this deployment cannot continue (no API binding) so the
   * caller must produce inline.
   */
  markPending(owner: string, username: string, ttlMs: number): number {
    if (this.read("lock") !== owner) return 0;
    if (!this.env.GHFIND_API) return -1;
    const pending: ScanPending = { owner, username, startedAt: Date.now() };
    this.write("pending", JSON.stringify(pending), ttlMs);
    void this.ctx.storage.setAlarm(Date.now());
    return 1;
  }

  pending(): ScanPending | null {
    const raw = this.read("pending");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as ScanPending;
      if (
        typeof parsed.owner !== "string" ||
        typeof parsed.username !== "string" ||
        typeof parsed.startedAt !== "number"
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /** Stretch the producer lock and capacity lease. 1 while `owner` still holds both. */
  async renew(owner: string, leaseMs: number, capacityKey: string): Promise<number> {
    if (this.read("lock") !== owner) return 0;
    const pool = this.env.SCAN_CAPACITY.get(this.env.SCAN_CAPACITY.idFromName(capacityKey));
    const leased = await pool.renew(owner, leaseMs);
    if (!leased) {
      this.ctx.storage.kv.delete("lock");
      this.ctx.storage.kv.delete("pending");
      return 0;
    }
    this.write("lock", owner, leaseMs);
    const pending = this.pending();
    if (pending && pending.owner === owner) this.write("pending", JSON.stringify(pending), leaseMs);
    return 1;
  }

  /** RELEASE_SCAN: drop our lock (+15s cooldown on failure) and our capacity lease. */
  async release(owner: string, failed: boolean, capacityKey: string): Promise<void> {
    if (this.read("lock") === owner) {
      this.ctx.storage.kv.delete("lock");
      this.ctx.storage.kv.delete("pending");
      if (failed) this.write("cooldown", "1", 15_000);
    }
    const pool = this.env.SCAN_CAPACITY.get(this.env.SCAN_CAPACITY.idFromName(capacityKey));
    await pool.release(owner);
  }

  async alarm(): Promise<void> {
    const pending = this.pending();
    const lock = this.read("lock");
    if (pending && lock === pending.owner && this.env.GHFIND_API) {
      try {
        await this.env.GHFIND_API.run(pending.username, pending.owner);
      } catch {
        // Keep the lease; try again shortly. run() itself never re-collects
        // when the owner is gone or a payload is already published.
        void this.ctx.storage.setAlarm(Date.now() + 15_000);
        return;
      }
    }
    const now = Date.now();
    for (const field of ["payload", "lock", "cooldown", "revision", "stale", "pending"] as const) {
      this.read(field, now);
    }
    const remaining = [...this.ctx.storage.kv.list<Entry>()];
    if (remaining.length === 0) await this.ctx.storage.deleteAll();
    else this.scheduleReclaim();
  }
}
