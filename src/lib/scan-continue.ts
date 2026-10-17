/**
 * Background GitHub collect for a ScanSlot owner. Invoked from ghfind-api's
 * ScanContinueEntrypoint, which ScanSlot's alarm calls over a service binding.
 * The original HTTP isolate never uses after()/waitUntil for this work.
 */
import { publishCompleteQuickScan } from "./db";
import { scanKey } from "./redis";
import { buildScanResult, logFreshScanFailure } from "./scan-core";
import {
  BACKGROUND_COLLECT_DEADLINE_MS,
  SCAN_BACKGROUND_LEASE_MS,
  SCAN_PRODUCER_CAPACITY_KEY,
  SCAN_STALE_TTL_SECONDS,
  scanTtl,
} from "./scan-protection";
import { parsePayload, scanSlot, scanSlots } from "./scan-slots";
import type { ScanResult } from "./types";

export type ScanContinueStatus =
  | "published"
  | "already_published"
  | "owner_mismatch"
  | "lease_lost"
  | "publish_rejected"
  | "no_slots"
  | "failed";

export async function completeBackgroundScan(
  username: string,
  owner: string,
): Promise<{ ok: boolean; status: ScanContinueStatus }> {
  const slots = scanSlots();
  if (!slots) return { ok: false, status: "no_slots" };
  const slot = scanSlot(slots, scanKey(username));
  const pending = await slot.pending();
  if (!pending || pending.owner !== owner) return { ok: false, status: "owner_mismatch" };

  const existing = parsePayload<ScanResult>(await slot.payload());
  if (existing) {
    await slot.release(owner, false, SCAN_PRODUCER_CAPACITY_KEY).catch(() => {});
    return { ok: true, status: "already_published" };
  }

  const renewed = await slot.renew(owner, SCAN_BACKGROUND_LEASE_MS, SCAN_PRODUCER_CAPACITY_KEY);
  if (renewed !== 1) return { ok: false, status: "lease_lost" };

  let failed = true;
  try {
    const scannedAt = Date.now();
    const quickScan = await buildScanResult(username, { deadlineMs: BACKGROUND_COLLECT_DEADLINE_MS });
    if (!(await publishCompleteQuickScan(quickScan, scannedAt))) {
      logFreshScanFailure(new Error("score persistence"), {
        route: "scan",
        username,
        persistenceFailure: true,
      });
      return { ok: false, status: "failed" };
    }
    const result = Object.assign(quickScan, { scanned_at: scannedAt });
    const published = await slot.publish(
      owner,
      JSON.stringify(result),
      scanTtl(),
      true,
      SCAN_STALE_TTL_SECONDS,
    );
    if (published !== 1) return { ok: false, status: "publish_rejected" };
    failed = false;
    return { ok: true, status: "published" };
  } catch (error) {
    logFreshScanFailure(error, {
      route: "scan",
      username,
      persistenceFailure: false,
    });
    return { ok: false, status: "failed" };
  } finally {
    await slot.release(owner, failed, SCAN_PRODUCER_CAPACITY_KEY).catch(() => {});
  }
}
