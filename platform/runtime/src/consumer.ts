import { deliver, deliveryEnvelope } from "./queue";
import { persistTerminal } from "./delivery";
import {
  checkConfiguration,
  type Dispatch,
  type RuntimeSettings,
} from "./router";
import type { RelayBindings } from "./relay";

export interface QueueMessage {
  body: unknown;
  id: string;
  attempts: number;
  ack(): void;
  retry(options: { delaySeconds: number }): void;
}
export async function consumeBatch(
  batch: { queue: string; messages: readonly QueueMessage[] },
  env: RuntimeSettings,
  dispatch: Dispatch,
  adapter: RelayBindings["source"],
  log: (entry: Record<string, unknown>, failed: boolean) => void,
): Promise<void> {
  checkConfiguration(env);
  if (![env.FEED_QUEUE_NAME, env.FEED_DLQ_NAME].includes(batch.queue))
    throw new Error("unexpected_queue");
  // Config fixes one message. Reject a surprising batch before dispatch so an
  // accidental config edit cannot turn one invocation into unbounded Go work.
  if (batch.messages.length > 1) throw new Error("unexpected_queue_batch");
  for (const message of batch.messages) {
    try {
      const envelope = deliveryEnvelope(message.body);
      if (batch.queue === env.FEED_DLQ_NAME) {
        const result = await persistTerminal(
          envelope,
          {
            messageId: message.id,
            queue: batch.queue,
            attempts: message.attempts,
          },
          env,
          adapter,
        );
        message.ack();
        log(
          {
            event: "feed_dlq_terminal_persisted",
            queue: batch.queue,
            attempts: message.attempts,
            current: result.current,
          },
          false,
        );
      } else {
        await deliver(envelope, env, dispatch);
        message.ack();
      }
    } catch (error) {
      log(
        {
          event:
            batch.queue === env.FEED_DLQ_NAME
              ? "feed_dlq_terminal_failed"
              : "feed_job_delivery_failed",
          queue: batch.queue,
          attempts: message.attempts,
          errorType: error instanceof Error ? error.name : "unknown",
        },
        true,
      );
      message.retry({
        delaySeconds: Math.min(300, 5 * 2 ** Math.min(message.attempts, 6)),
      });
    }
  }
}
