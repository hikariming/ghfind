import { captureNativeProbe, probe, type RuntimeSettings, type Target } from "./router";
import { HTTPError } from "./security";

export type TransitionRequest = { sourceSha: string; imageBuildId: string; mode: "baseline"; writerEpoch: 1 };
export function validateTransition(value: unknown, env: RuntimeSettings): asserts value is TransitionRequest {
  const data = value as TransitionRequest;
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).sort().join(",") !== "imageBuildId,mode,sourceSha,writerEpoch" ||
      env.FEED_ENVIRONMENT !== "production" || env.FEED_MODE !== "baseline" ||
      env.FEED_WRITER_EPOCH !== "1" || data.sourceSha !== env.FEED_RELEASE_SHA ||
      data.imageBuildId !== env.FEED_IMAGE_BUILD_ID || data.mode !== "baseline" || data.writerEpoch !== 1)
    throw new HTTPError(400, "invalid_transition");
}
export type TransitionHooks = {
  state(): { actorId: string; running: boolean };
  fetch(request: Request): Promise<Response>;
  stop(): Promise<void>;
  start(signal: AbortSignal): Promise<void>;
};

// A lock per DO also covers a timed-out underlying SDK operation until it settles.
// A caller deadline never authorizes concurrent lifecycle mutations on that actor.
export class ModeTransition {
  private busy = false;
  constructor(private readonly limits = { totalMs: 30000, stopMs: 15000, pollMs: 100 }) {
    if (!Number.isSafeInteger(limits.totalMs) || limits.totalMs < 1 || limits.totalMs > 30000 ||
        !Number.isSafeInteger(limits.stopMs) || limits.stopMs < 1 || limits.stopMs > 15000 ||
        !Number.isSafeInteger(limits.pollMs) || limits.pollMs < 1 || limits.pollMs > 100)
      throw new Error("transition limits can only be tightened");
  }
  async run(target: Target, env: RuntimeSettings, input: TransitionRequest, hooks: TransitionHooks) {
    validateTransition(input, env);
    if (this.busy) throw new HTTPError(409, "transition_in_progress");
    this.busy = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new HTTPError(503, "transition_timeout")), this.limits.totalMs);
    const abort = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    let pendingStop: Promise<void> | undefined;
    const work = (async () => {
      const initial = hooks.state();
      if (!/^[a-f0-9]{64}$/.test(initial.actorId)) throw new HTTPError(503, "container_version_or_contract_mismatch");
      const actualProbe = () => captureNativeProbe((request) => hooks.fetch(new Request(request, { signal: controller.signal })), hooks.state);
      const check = async (allowOff: boolean) => {
        const native = await actualProbe();
        controller.signal.throwIfAborted();
        let mode = env.FEED_MODE;
        if (allowOff && native.phase === "response") {
          try { mode = JSON.parse(new TextDecoder().decode(native.body)).mode; }
          catch { throw new HTTPError(503, "container_version_or_contract_mismatch"); }
          if (mode !== "off" && mode !== "baseline") throw new HTTPError(503, "container_version_or_contract_mismatch");
        }
        await probe(target, { ...env, FEED_MODE: mode }, {
          fetch: (_target, request) => hooks.fetch(request), stop: hooks.stop,
          actorId: () => initial.actorId, probe: async () => native,
        });
        controller.signal.throwIfAborted();
      };
      if (initial.running) {
        await check(true);
        const stopAt = Date.now() + this.limits.stopMs;
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        pendingStop = hooks.stop();
        try {
          await Promise.race([pendingStop, new Promise<never>((_, reject) => {
            stopTimer = setTimeout(() => reject(new HTTPError(503, "transition_stop_timeout")), this.limits.stopMs);
          })]);
        } finally { clearTimeout(stopTimer); }
        // SIGTERM acknowledgement is not an exit observation.
        controller.signal.throwIfAborted();
        while (hooks.state().running) {
          if (Date.now() >= stopAt) throw new HTTPError(503, "transition_stop_timeout");
          await new Promise((resolve) => setTimeout(resolve, this.limits.pollMs));
          controller.signal.throwIfAborted();
        }
      }
      controller.signal.throwIfAborted();
      if (hooks.state().actorId !== initial.actorId) throw new HTTPError(503, "container_version_or_contract_mismatch");
      await hooks.start(controller.signal);
      controller.signal.throwIfAborted();
      await check(false);
      return { restarted: true as const, target, ...input };
    })();
    // Release the actor lock only when actual work settles, including on timeout.
    void work.finally(async () => {
      try { await pendingStop; } finally { this.busy = false; }
    }).catch(() => {});
    try { return await Promise.race([work, abort]); }
    finally { clearTimeout(timer); controller.abort(new HTTPError(503, "transition_timeout")); }
  }
}
