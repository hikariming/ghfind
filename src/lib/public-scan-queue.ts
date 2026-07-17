import { Client } from "@upstash/qstash";
import { SITE_URL } from "./site";

const PUBLIC_SCAN_WORKER_PATH = "/api/internal/public-scan";

export interface PublicScanDelivery {
  jobId: string;
}

export function publicScanQueueConfigured(): boolean {
  return Boolean(
    process.env.QSTASH_TOKEN &&
      process.env.QSTASH_CURRENT_SIGNING_KEY &&
      process.env.QSTASH_NEXT_SIGNING_KEY,
  );
}

/**
 * Persisting the job happens before this call. QStash is a delivery mechanism,
 * not the job source of truth, so a transient publish failure leaves an
 * inspectable queued row that an operator or cron delivery can resume.
 */
export async function schedulePublicScanDelivery(
  delivery: PublicScanDelivery,
  options: { delaySeconds?: number; deduplicationId?: string } = {},
): Promise<boolean> {
  if (!publicScanQueueConfigured()) return false;
  try {
    const client = new Client();
    await client.publishJSON({
      url: `${SITE_URL}${PUBLIC_SCAN_WORKER_PATH}`,
      body: delivery,
      delay: options.delaySeconds,
      retries: 3,
      deduplicationId: options.deduplicationId,
    });
    return true;
  } catch (error) {
    console.error("schedulePublicScanDelivery failed:", error);
    return false;
  }
}
