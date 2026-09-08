import {
  checkConfiguration,
  type Dispatch,
  type RuntimeSettings,
} from "./router";
import { readBounded } from "./security";

export interface SourceEvent {
  contractVersion: 1;
  eventId: string;
  aggregateKey: string;
  sourceVersion: number;
  kind: "assessment.completed";
  analysisId: string;
  receiptId: string;
  sourceHash: string;
  occurredAt: number;
}
export function sourceEvent(value: unknown): SourceEvent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_envelope");
  const v = value as Record<string, unknown>;
  const expected = [
    "contractVersion",
    "eventId",
    "aggregateKey",
    "sourceVersion",
    "kind",
    "analysisId",
    "receiptId",
    "sourceHash",
    "occurredAt",
  ];
  if (
    Object.keys(v).length !== expected.length ||
    Object.keys(v).some((k) => !expected.includes(k)) ||
    v.contractVersion !== 1 ||
    v.kind !== "assessment.completed" ||
    !Number.isSafeInteger(v.sourceVersion) ||
    Number(v.sourceVersion) <= 0 ||
    !Number.isSafeInteger(v.occurredAt) ||
    Number(v.occurredAt) <= 0 ||
    typeof v.aggregateKey !== "string" ||
    !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(v.aggregateKey) ||
    v.aggregateKey.length > 256 ||
    typeof v.sourceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.sourceHash) ||
    [v.eventId, v.analysisId, v.receiptId].some(
      (id) => typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id),
    )
  )
    throw new Error("invalid_envelope");
  return {
    contractVersion: 1,
    eventId: String(v.eventId),
    aggregateKey: String(v.aggregateKey),
    sourceVersion: Number(v.sourceVersion),
    kind: "assessment.completed",
    analysisId: String(v.analysisId),
    receiptId: String(v.receiptId),
    sourceHash: String(v.sourceHash),
    occurredAt: Number(v.occurredAt),
  };
}

export interface DeliveryEnvelope {
  contractVersion: 1;
  deliveryId: string;
  event: SourceEvent;
}
export function deliveryEnvelope(value: unknown): DeliveryEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_delivery");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== 3 ||
    Object.keys(v).some(
      (key) => !["contractVersion", "deliveryId", "event"].includes(key),
    ) ||
    v.contractVersion !== 1 ||
    typeof v.deliveryId !== "string"
  )
    throw new Error("invalid_delivery");
  const event = sourceEvent(v.event);
  if (
    v.deliveryId !== `source:${event.sourceVersion}` &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      v.deliveryId,
    )
  )
    throw new Error("invalid_delivery_id");
  return { contractVersion: 1, deliveryId: v.deliveryId, event };
}
export function initialDelivery(event: SourceEvent): DeliveryEnvelope {
  return deliveryEnvelope({
    contractVersion: 1,
    deliveryId: `source:${event.sourceVersion}`,
    event,
  });
}

// A transport acknowledgement follows the executor's durable commit. Retry
// deadlines and terminal failure records belong to its persistent job store.
export async function deliver(
  value: unknown,
  env: RuntimeSettings,
  dispatch: Dispatch,
): Promise<void> {
  checkConfiguration(env);
  if (env.FEED_EXECUTOR_ENABLED !== "true")
    throw new Error("executor_not_enabled");
  const { event } = deliveryEnvelope(value);
  const response = await dispatch.fetch(
    "executor-0",
    new Request("http://feed-container/internal/feed/jobs/execute", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.FEED_EXECUTOR_SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(75000),
      redirect: "manual",
    }),
  );
  if (!response.ok) throw new Error("executor_failed");
  const result: Record<string, unknown> = JSON.parse(
    new TextDecoder().decode(await readBounded(response, 4096)),
  );
  if (
    result.eventId !== event.eventId ||
    !["completed", "duplicate"].includes(String(result.status))
  )
    throw new Error("executor_not_committed");
}
