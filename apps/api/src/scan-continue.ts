import { WorkerEntrypoint } from "cloudflare:workers";
import { completeBackgroundScan } from "@/lib/scan-continue";

/**
 * RPC target for ghfind-coord ScanSlot alarms. Collect runs here so the
 * coordination worker never sees a GitHub token, and so the work is not bound
 * to the interactive request's waitUntil budget.
 */
export class ScanContinueEntrypoint extends WorkerEntrypoint {
  async run(username: string, owner: string): Promise<{ ok: boolean; status: string }> {
    return completeBackgroundScan(username, owner);
  }
}
