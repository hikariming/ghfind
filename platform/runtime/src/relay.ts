import { sourceEvent, type SourceEvent } from "./queue";
import { checkConfiguration, type RuntimeSettings } from "./router";
import { readBounded } from "./security";

export interface RelayBindings {
  source(request: Request): Promise<Response>;
  send(events: SourceEvent[]): Promise<void>;
}
interface Lease {
  event: SourceEvent;
  attempts: number;
}
async function deadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("queue_timeout")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// At most 100 indexed outbox claims per invocation. This is not reconciliation
// and never enumerates the project catalog. Queue publication is at least once.
export async function relayOnce(env: RuntimeSettings, bindings: RelayBindings) {
  checkConfiguration(env);
  if (env.FEED_SOURCE_RELAY_ENABLED !== "true")
    return {
      claimed: 0,
      delivered: 0,
      retried: 0,
      leaseConflicts: 0,
      disabled: true,
    };
  const leaseToken = crypto.randomUUID();
  async function capability(operation: "claim" | "finish", body: unknown) {
    const response = await bindings.source(
      new Request(
        `http://feed-source.internal/internal/feed/source/v1/${operation}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.FEED_SOURCE_SECRET}`,
            "x-feed-contract": "1",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(4000),
          redirect: "manual",
        },
      ),
    );
    if (!response.ok) throw new Error(`source_${operation}_unavailable`);
    return JSON.parse(new TextDecoder().decode(await readBounded(response)));
  }
  const claimed: { events: Record<string, unknown>[] } = await capability(
    "claim",
    { limit: 100, leaseToken },
  );
  if (!Array.isArray(claimed.events) || claimed.events.length > 100)
    throw new Error("invalid_claim_response");
  const leases: Lease[] = [];
  for (const record of claimed.events) {
    const { leaseToken: returned, attempts, ...event } = record;
    if (
      returned !== leaseToken ||
      !Number.isSafeInteger(attempts) ||
      Number(attempts) < 1 ||
      Number(attempts) > 10
    )
      throw new Error("invalid_lease_response");
    leases.push({ event: sourceEvent(event), attempts: Number(attempts) });
  }
  const summary = {
    claimed: leases.length,
    delivered: 0,
    retried: 0,
    leaseConflicts: 0,
    disabled: false,
  };
  if (leases.length === 0) return summary;
  let delivered = false;
  try {
    // An uncertain timeout deliberately leaves retryable source work. A late
    // queue send can duplicate delivery; the executor's event ID deduplicates it.
    await deadline(bindings.send(leases.map((lease) => lease.event)), 5000);
    delivered = true;
  } catch {
    delivered = false;
  }
  // Twenty finite parallel requests keep 100 confirmations inside the 60s
  // source lease even at each request's four-second timeout.
  for (let start = 0; start < leases.length; start += 20) {
    const results = await Promise.allSettled(
      leases.slice(start, start + 20).map(async (lease) => {
        const result = await capability("finish", {
          sequence: lease.event.sourceVersion,
          leaseToken,
          delivered,
          ...(!delivered ? { errorCode: "queue_unavailable" } : {}),
        });
        if (result.updated !== true) throw new Error("source_lease_conflict");
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") summary.leaseConflicts++;
      else if (delivered) summary.delivered++;
      else summary.retried++;
    }
  }
  return summary;
}
