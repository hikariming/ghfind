import { DurableObject } from "cloudflare:workers";

/**
 * Global lease pool for cold producers — the Redis sorted set behind
 * `scan:active-producers:v1` / `score-detail:active-readers:v1`. One instance
 * per pool (idFromName(capacityKey)). Leases expire on their own, so a killed
 * producer's slot comes back after the lease, like ZREMRANGEBYSCORE did.
 */
export class ScanCapacity extends DurableObject {
  private prune(now: number): number {
    const kv = this.ctx.storage.kv;
    let live = 0;
    for (const [key, expiresAt] of kv.list<number>({ prefix: "l:" })) {
      if (expiresAt <= now) kv.delete(key);
      else live++;
    }
    return live;
  }

  /** Take a lease for `owner` unless `limit` live leases already exist. */
  acquire(owner: string, leaseMs: number, limit: number): boolean {
    const now = Date.now();
    if (this.prune(now) >= limit) return false;
    this.ctx.storage.kv.put(`l:${owner}`, now + leaseMs);
    void this.ctx.storage.setAlarm(now + leaseMs);
    return true;
  }

  release(owner: string): void {
    this.ctx.storage.kv.delete(`l:${owner}`);
  }

  async alarm(): Promise<void> {
    if (this.prune(Date.now()) === 0) await this.ctx.storage.deleteAll();
  }
}
