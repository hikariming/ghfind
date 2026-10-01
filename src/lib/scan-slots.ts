/**
 * Durable Object backend for scan admission and scan/score-detail caches
 * (the ScanSlot object in ghfind-coord, one per protected key). Selected with
 * the rest of the coordination state: `GHFIND_COORD_BACKEND=do` plus a
 * `SCAN_SLOT` binding; otherwise src/lib/redis.ts keeps its Redis/Lua path.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { ScanCoordinator } from "./scan-protection";

/** RPC surface of apps/coord's ScanSlot Durable Object. */
interface ScanSlotStub {
  payload(): Promise<string | null>;
  setPayload(value: string, ttlSeconds: number): Promise<void>;
  clearPayload(): Promise<void>;
  revision(): Promise<string | null>;
  payloadAfter(baseline: string): Promise<string | null>;
  admit(owner: string, leaseMs: number, capacityKey: string, capacity: number): Promise<number>;
  publish(owner: string, payload: string, ttlSeconds: number, withRevision: boolean): Promise<number>;
  release(owner: string, failed: boolean, capacityKey: string): Promise<void>;
}

export interface ScanSlotNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): ScanSlotStub;
}

export type ScanSlot = ScanSlotStub;

/** The slot namespace when this deployment coordinates on Durable Objects. */
export function scanSlots(): ScanSlotNamespace | null {
  if (process.env.GHFIND_COORD_BACKEND !== "do") return null;
  try {
    const env = getCloudflareContext().env as { SCAN_SLOT?: ScanSlotNamespace };
    return env.SCAN_SLOT ?? null;
  } catch {
    return null;
  }
}

export function scanSlot(ns: ScanSlotNamespace, key: string): ScanSlot {
  return ns.get(ns.idFromName(key));
}

/** Payloads are stored as the JSON text protectedScan publishes. */
export function parsePayload<T>(value: string | null): T | null {
  return value === null ? null : (JSON.parse(value) as T);
}

export function slotCoordinator(slot: ScanSlot, capacityKey: string, withRevision: boolean): ScanCoordinator {
  return {
    admit: (owner, _now, leaseMs, capacity) => slot.admit(owner, leaseMs, capacityKey, capacity),
    publish: (owner, payload, ttlSeconds) => slot.publish(owner, payload, ttlSeconds, withRevision),
    release: (owner, failed) => slot.release(owner, failed, capacityKey),
  };
}
