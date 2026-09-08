import { replayDeliveriesOnce } from "./delivery";
import { relayOnce, type RelayBindings } from "./relay";
import {
  checkConfiguration,
  type RuntimeSettings,
  type Dispatch,
} from "./router";
import { readBounded } from "./security";

export interface CleanupSummary {
  status: "idle" | "queued" | "completed";
  steps: number;
  processed: number;
  skipped: boolean;
}
export async function cleanupOnce(
  env: RuntimeSettings,
  adapter: RelayBindings["source"],
  dispatch: Dispatch,
): Promise<CleanupSummary> {
  checkConfiguration(env);
  if (env.FEED_EXECUTOR_ENABLED !== "true")
    throw new Error("executor_not_enabled");
  const pending = await adapter(
    new Request(
      "http://feed-cleanup.internal/internal/feed/cleanup/v1/pending",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.FEED_EXECUTOR_SECRET}`,
          "x-feed-contract": "1",
          "content-type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(4000),
        redirect: "manual",
      },
    ),
  );
  if (!pending.ok) throw new Error("cleanup_pending_unavailable");
  const due: Record<string, unknown> = JSON.parse(
    new TextDecoder().decode(await readBounded(pending, 1024)),
  );
  if (Object.keys(due).length !== 1 || typeof due.pending !== "boolean")
    throw new Error("invalid_cleanup_pending");
  if (!due.pending)
    return { status: "idle", steps: 0, processed: 0, skipped: true };
  // Exactly one bounded Go call per cron invocation, only for due durable work.
  // Go owns its 60s task context, checkpoints, finite steps and lease release.
  const response = await dispatch.fetch(
    "executor-0",
    new Request("http://feed-container/internal/feed/jobs/cleanup", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.FEED_EXECUTOR_SECRET}`,
        "content-type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(75000),
      redirect: "manual",
    }),
  );
  if (!response.ok) throw new Error("cleanup_unavailable");
  const result: Record<string, unknown> = JSON.parse(
    new TextDecoder().decode(await readBounded(response, 4096)),
  );
  if (
    Object.keys(result).some(
      (key) => !["status", "steps", "processed", "deletionId"].includes(key),
    ) ||
    !["idle", "queued", "completed"].includes(String(result.status)) ||
    !Number.isSafeInteger(result.steps) ||
    Number(result.steps) < 0 ||
    Number(result.steps) > 8 ||
    !Number.isSafeInteger(result.processed) ||
    Number(result.processed) < 0 ||
    Number(result.processed) > Number(result.steps) * 100 ||
    (result.status === "idle"
      ? result.steps !== 0 ||
        result.processed !== 0 ||
        result.deletionId !== undefined
      : typeof result.deletionId !== "string" ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(result.deletionId))
  )
    throw new Error("invalid_cleanup_outcome");
  // Keep per-user deletion identifiers out of platform operational logs.
  return {
    status: result.status as CleanupSummary["status"],
    steps: Number(result.steps),
    processed: Number(result.processed),
    skipped: false,
  };
}

export async function runScheduled(
  env: RuntimeSettings,
  bindings: RelayBindings,
  dispatch: Dispatch,
  log: (entry: Record<string, unknown>, failed: boolean) => void,
): Promise<void> {
  const operations = [
    "feed_source_relay",
    "feed_cleanup",
    "feed_replay_delivery",
  ] as const;
  // All branches start and settle independently: outbox/queue failure cannot
  // starve deletion, and cleanup failure cannot prevent source publication.
  const results = await Promise.allSettled([
    (async () => {
      const summary = await relayOnce(env, bindings);
      if (summary.retried > 0 || summary.leaseConflicts > 0)
        throw new Error("feed_source_relay_incomplete");
      return summary;
    })(),
    cleanupOnce(env, bindings.source, dispatch),
    (async () => {
      const summary = await replayDeliveriesOnce(env, bindings);
      if (summary.retried > 0 || summary.leaseConflicts > 0)
        throw new Error("feed_replay_delivery_incomplete");
      return summary;
    })(),
  ]);
  const failed: string[] = [];
  results.forEach((result, index) => {
    const event = operations[index]!;
    if (result.status === "fulfilled") log({ event, ...result.value }, false);
    else {
      failed.push(event);
      log(
        {
          event: `${event}_failed`,
          errorType:
            result.reason instanceof Error ? result.reason.name : "unknown",
        },
        true,
      );
    }
  });
  if (failed.length)
    throw new Error(`feed_scheduled_failed:${failed.join(",")}`);
}
