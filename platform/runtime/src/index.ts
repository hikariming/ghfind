import { Container, getContainer } from "@cloudflare/containers";
import {
  checkConfiguration,
  handleRequest,
  type Dispatch,
  type Target,
} from "./router";
import { runScheduled } from "./scheduled";
import { bindingBridge, assessmentSource, deletionCleanup } from "./outbound";
// Required by the Containers SDK for outboundByHost interception.
export { ContainerProxy } from "@cloudflare/containers";
import { deliver } from "./queue";

function containerEnvironment(env: RuntimeEnv): Record<string, string> {
  checkConfiguration(env);
  return {
    PORT: "8080",
    FEED_STORE_PROFILE: "cf_d1_r2",
    FEED_MODE: env.FEED_MODE,
    FEED_WRITER_EPOCH: env.FEED_WRITER_EPOCH,
    FEED_GATEWAY_SECRET: env.FEED_GATEWAY_SECRET,
    FEED_SIGNING_SECRET: env.FEED_SIGNING_SECRET,
    FEED_BRIDGE_SECRET: env.FEED_BRIDGE_SECRET,
    FEED_BRIDGE_ENDPOINT: "http://feed-bindings.internal",
    FEED_EXECUTOR_SECRET: env.FEED_EXECUTOR_SECRET,
    FEED_EXECUTOR_ENABLED: env.FEED_EXECUTOR_ENABLED,
    FEED_SOURCE_ENDPOINT: "http://feed-source.internal",
    FEED_SOURCE_SECRET: env.FEED_SOURCE_SECRET,
    FEED_CLEANUP_ENDPOINT: "http://feed-cleanup.internal",
  };
}

export class FeedAPI extends Container<RuntimeEnv> {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = false;
  entrypoint = ["/usr/local/bin/feed-api"];
  constructor(
    ctx: ConstructorParameters<typeof Container>[0],
    env: RuntimeEnv,
  ) {
    super(ctx, env);
    this.envVars = containerEnvironment(env);
  }
}

export class FeedExecutor extends Container<RuntimeEnv> {
  defaultPort = 8080;
  sleepAfter = "10s";
  enableInternet = false;
  entrypoint = ["/usr/local/bin/feed-worker"];
  constructor(
    ctx: ConstructorParameters<typeof Container>[0],
    env: RuntimeEnv,
  ) {
    super(ctx, env);
    this.envVars = containerEnvironment(env);
  }
}

FeedAPI.outboundByHost = { "feed-bindings.internal": bindingBridge };
FeedExecutor.outboundByHost = {
  "feed-bindings.internal": bindingBridge,
  "feed-source.internal": assessmentSource,
  "feed-cleanup.internal": deletionCleanup,
};

function dispatcher(env: RuntimeEnv): Dispatch {
  function instance(target: Target) {
    // These three literal IDs bound the instance population independently of input.
    return target === "executor-0"
      ? getContainer(env.FEED_EXECUTOR, target)
      : getContainer(env.FEED_API, target);
  }
  return {
    fetch: (target, request) => instance(target).fetch(request),
    stop: (target) => instance(target).stop("SIGTERM"),
  };
}

export default {
  fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    return handleRequest(request, env, dispatcher(env));
  },
  async scheduled(
    _controller: ScheduledController,
    env: RuntimeEnv,
  ): Promise<void> {
    await runScheduled(
      env,
      {
        source: (request) => env.FEED_ADAPTER.fetch(request),
        send: async (events) => {
          await env.FEED_JOBS_QUEUE.sendBatch(
            events.map((body) => ({ body, contentType: "json" })),
          );
        },
      },
      dispatcher(env),
      (entry, failed) => {
        if (failed) console.error(JSON.stringify(entry));
        else console.log(JSON.stringify(entry));
      },
    );
  },
  async queue(batch: MessageBatch<unknown>, env: RuntimeEnv): Promise<void> {
    // Configuration fixes max_batch_size=1 and max_concurrency=1. Sequential
    // dispatch here preserves the bound even if an unexpected batch arrives.
    for (const message of batch.messages) {
      try {
        await deliver(message.body, env, dispatcher(env));
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "feed_job_delivery_failed",
            queue: batch.queue,
            attempts: message.attempts,
            errorType: error instanceof Error ? error.name : "unknown",
          }),
        );
        message.retry({
          delaySeconds: Math.min(300, 5 * 2 ** Math.min(message.attempts, 6)),
        });
      }
    }
  },
} satisfies ExportedHandler<RuntimeEnv>;
