import { ModeTransition, type TransitionRequest } from "./transition";
import { containerEnvironment } from "./environment";
import { Container, getContainer } from "@cloudflare/containers";
import { captureNativeProbe, handleRequest, type Dispatch, type NativeProbe, type Target } from "./router";
import { runScheduled } from "./scheduled";
import { handleAdminRequest } from "./admin";
import { handleGovernanceRequest } from "./governance";
import {
  bindingBridge,
  executorBindingBridge,
  assessmentSource,
  deletionCleanup,
  archiveObjects,
} from "./outbound";
// Required by the Containers SDK for outboundByHost interception.
export { ContainerProxy } from "@cloudflare/containers";
import { consumeBatch } from "./consumer";

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
    this.envVars = containerEnvironment(env, "api");
  }
  // Accessible only through this namespace binding, not a public HTTP route.
  private readonly modeTransition = new ModeTransition();
  runtimeRestart(target: Target, input: TransitionRequest) {
    return this.modeTransition.run(target, this.env, input, {
      state: () => ({ actorId: this.ctx.id.toString(), running: this.ctx.container?.running === true }),
      fetch: (request) => super.fetch(request),
      stop: () => super.stop("SIGTERM"),
      start: (abort) => this.startAndWaitForPorts(this.defaultPort, { abort }),
    });
  }
  runtimeProbe(): Promise<NativeProbe> {
    return captureNativeProbe((request) => super.fetch(request), () => ({
      actorId: this.ctx.id.toString(), running: this.ctx.container?.running === true,
    }), (abort) => this.startAndWaitForPorts(this.defaultPort, { abort }));
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
    this.envVars = containerEnvironment(env, "executor");
  }
  private readonly modeTransition = new ModeTransition();
  runtimeRestart(target: Target, input: TransitionRequest) {
    return this.modeTransition.run(target, this.env, input, {
      state: () => ({ actorId: this.ctx.id.toString(), running: this.ctx.container?.running === true }),
      fetch: (request) => super.fetch(request),
      stop: () => super.stop("SIGTERM"),
      start: (abort) => this.startAndWaitForPorts(this.defaultPort, { abort }),
    });
  }
  runtimeProbe(): Promise<NativeProbe> {
    return captureNativeProbe((request) => super.fetch(request), () => ({
      actorId: this.ctx.id.toString(), running: this.ctx.container?.running === true,
    }), (abort) => this.startAndWaitForPorts(this.defaultPort, { abort }));
  }
}

FeedAPI.outboundByHost = { "feed-bindings.internal": bindingBridge };
FeedExecutor.outboundByHost = {
  "feed-bindings.internal": executorBindingBridge,
  "feed-source.internal": assessmentSource,
  "feed-cleanup.internal": deletionCleanup,
  "feed-archive.internal": archiveObjects,
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
    restart: (target, input) => instance(target).runtimeRestart(target, input),
    probe: (target) => instance(target).runtimeProbe(),
    actorId: (target) => (target === "executor-0" ? env.FEED_EXECUTOR : env.FEED_API)
      .idFromName(target).toString(),
  };
}

export default {
  fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/internal/runtime/feed-governance/"))
      return handleGovernanceRequest(request, env);
    if (
      new URL(request.url).pathname.startsWith("/internal/runtime/feed-admin/")
    )
      return handleAdminRequest(request, env);
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
    await consumeBatch(
      batch,
      env,
      dispatcher(env),
      (request) => env.FEED_ADAPTER.fetch(request),
      (entry, failed) => {
        if (failed) console.error(JSON.stringify(entry));
        else console.log(JSON.stringify(entry));
      },
    );
  },
} satisfies ExportedHandler<RuntimeEnv>;
