import { deliveryEnvelope, type DeliveryEnvelope } from "./queue";
import { checkConfiguration, type RuntimeSettings } from "./router";
import type { RelayBindings } from "./relay";
import { readBounded } from "./security";

async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("delivery_deadline")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function deliveryCapability(
  env: RuntimeSettings,
  adapter: RelayBindings["source"],
  operation: "pending" | "claim" | "finish" | "terminal",
  body: unknown,
  milliseconds = 8000,
): Promise<Record<string, unknown>> {
  return bounded(
    (async () => {
      const response = await adapter(
        new Request(
          `http://feed-adapter/internal/feed/delivery/v1/${operation}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${env.FEED_DELIVERY_SECRET}`,
              "x-feed-contract": "1",
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(milliseconds),
            redirect: "manual",
          },
        ),
      );
      if (!response.ok) throw new Error(`delivery_${operation}_unavailable`);
      const result: unknown = JSON.parse(
        new TextDecoder().decode(await readBounded(response)),
      );
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error("invalid_delivery_response");
      return result as Record<string, unknown>;
    })(),
    milliseconds,
  );
}

// A fresh lease identity per invocation, <=20 messages and a 45s publication
// budget leave room inside the durable 60s lease. Late queue sends may duplicate
// a message after timeout; its stable delivery/event identity remains unchanged.
export async function replayDeliveriesOnce(
  env: RuntimeSettings,
  bindings: RelayBindings,
) {
  checkConfiguration(env);
  const summary = {
    claimed: 0,
    delivered: 0,
    retried: 0,
    leaseConflicts: 0,
    skipped: false,
  };
  if (env.FEED_EXECUTOR_ENABLED !== "true")
    return { ...summary, skipped: true };
  const deadline = Date.now() + 45000;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("delivery_deadline");
    return Math.min(ms, 8000);
  };
  const call = (operation: "pending" | "claim" | "finish", body: unknown) =>
    deliveryCapability(env, bindings.source, operation, body, remaining());
  const pending = await call("pending", {});
  if (Object.keys(pending).length !== 1 || typeof pending.pending !== "boolean")
    throw new Error("invalid_delivery_pending");
  if (!pending.pending) return { ...summary, skipped: true };
  const leaseOwner = crypto.randomUUID();
  const result = await call("claim", {
    writerEpoch: Number(env.FEED_WRITER_EPOCH),
    leaseOwner,
    limit: 20,
    leaseSeconds: 60,
  });
  if (
    Object.keys(result).length !== 1 ||
    !Array.isArray(result.deliveries) ||
    result.deliveries.length > 20
  )
    throw new Error("invalid_delivery_claim");
  const leases = result.deliveries.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("invalid_delivery_lease");
    const v = item as Record<string, unknown>;
    if (
      Object.keys(v).length !== 4 ||
      Object.keys(v).some(
        (key) =>
          !["deliveryId", "event", "leaseOwner", "attempts"].includes(key),
      ) ||
      v.leaseOwner !== leaseOwner ||
      !Number.isSafeInteger(v.attempts) ||
      Number(v.attempts) < 1 ||
      Number(v.attempts) > 8
    )
      throw new Error("invalid_delivery_lease");
    return {
      body: deliveryEnvelope({
        contractVersion: 1,
        deliveryId: v.deliveryId,
        event: v.event,
      }),
      leaseOwner: v.leaseOwner,
    };
  });
  if (new Set(leases.map((v) => v.body.deliveryId)).size !== leases.length)
    throw new Error("duplicate_delivery_claim");
  summary.claimed = leases.length;
  if (!leases.length) return summary;
  let delivered = false;
  try {
    const timeout = Math.min(5000, remaining());
    await bounded(bindings.send(leases.map((v) => v.body)), timeout);
    delivered = true;
  } catch {
    delivered = false;
  }
  const confirmations = await Promise.allSettled(
    leases.map(async (lease) => {
      const result = await call("finish", {
        writerEpoch: Number(env.FEED_WRITER_EPOCH),
        deliveryId: lease.body.deliveryId,
        leaseOwner: lease.leaseOwner,
        delivered,
        ...(!delivered ? { errorCode: "queue_unavailable" } : {}),
      });
      if (Object.keys(result).length !== 1 || result.updated !== true)
        throw new Error("delivery_lease_conflict");
    }),
  );
  for (const result of confirmations) {
    if (result.status === "rejected") summary.leaseConflicts++;
    else if (delivered) summary.delivered++;
    else summary.retried++;
  }
  return summary;
}

export async function persistTerminal(
  envelope: DeliveryEnvelope,
  metadata: { messageId: string; queue: string; attempts: number },
  env: RuntimeSettings,
  adapter: RelayBindings["source"],
): Promise<{ current: boolean }> {
  checkConfiguration(env);
  if (
    metadata.queue !== env.FEED_DLQ_NAME ||
    !/^[A-Za-z0-9_.:-]{1,160}$/.test(metadata.messageId) ||
    !Number.isSafeInteger(metadata.attempts) ||
    metadata.attempts < 1 ||
    metadata.attempts > 1000
  )
    throw new Error("invalid_terminal_metadata");
  const body = deliveryEnvelope(envelope);
  const result = await deliveryCapability(env, adapter, "terminal", {
    writerEpoch: Number(env.FEED_WRITER_EPOCH),
    deliveryId: body.deliveryId,
    event: body.event,
    ...metadata,
  });
  if (
    Object.keys(result).length !== 2 ||
    result.ok !== true ||
    typeof result.current !== "boolean"
  )
    throw new Error("terminal_not_committed");
  return { current: result.current };
}
