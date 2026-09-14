import { validateTransition, type TransitionRequest } from "./transition";
import {
  bearerAuthorized,
  HTTPError,
  json,
  publicResponse,
  readBounded,
  verifyGateway,
} from "./security";

export type Target = "api-0" | "api-1" | "executor-0";
export const TARGETS: readonly Target[] = ["api-0", "api-1", "executor-0"];
export type NativeProbe = { actorId: string; running: boolean } & (
  | { phase: "response"; status: number; body: Uint8Array }
  | { phase: "starting"; running: false }
);
export interface Dispatch {
  fetch(target: Target, request: Request): Promise<Response>;
  stop(target: Target): Promise<void>;
  restart?(target: Target, input: TransitionRequest): Promise<unknown>;
  // These are binding-only capabilities, never client-provided identities.
  probe?(target: Target): Promise<NativeProbe>;
  actorId?(target: Target): string;
}
export type RuntimeSettings = Pick<
  RuntimeEnv,
  | "FEED_ENVIRONMENT"
  | "FEED_RELEASE_SHA"
  | "FEED_IMAGE_REFERENCE"
  | "FEED_MODE"
  | "FEED_WRITER_EPOCH"
  | "FEED_EXECUTOR_ENABLED"
  | "FEED_SOURCE_RELAY_ENABLED"
  | "FEED_SOURCE_SECRET"
  | "FEED_DELIVERY_SECRET"
  | "FEED_QUEUE_NAME"
  | "FEED_DLQ_NAME"
  | "FEED_GATEWAY_SECRET"
  | "FEED_SIGNING_SECRET"
  | "FEED_BRIDGE_SECRET"
  | "FEED_RUNTIME_ADMIN_SECRET"
  | "FEED_EXECUTOR_SECRET"
  | "WORKER_VERSION"
> & { FEED_IMAGE_BUILD_ID?: string };

export function checkConfiguration(env: RuntimeSettings): void {
  const secrets = [
    env.FEED_GATEWAY_SECRET,
    env.FEED_SIGNING_SECRET,
    env.FEED_BRIDGE_SECRET,
    env.FEED_RUNTIME_ADMIN_SECRET,
    env.FEED_EXECUTOR_SECRET,
    env.FEED_SOURCE_SECRET,
    env.FEED_DELIVERY_SECRET,
  ];
  if (
    !["staging", "production"].includes(env.FEED_ENVIRONMENT) ||
    env.FEED_QUEUE_NAME !== `ghfind-feed-${env.FEED_ENVIRONMENT}-jobs` ||
    env.FEED_DLQ_NAME !== `ghfind-feed-${env.FEED_ENVIRONMENT}-dlq` ||
    !/^[a-f0-9]{40}$/.test(env.FEED_RELEASE_SHA) ||
    !/^registry\.cloudflare\.com\/8f19bebe359e4ec1a24c68c5f49c1584\/ghfind-feed@sha256:[a-f0-9]{64}$/.test(
      env.FEED_IMAGE_REFERENCE,
    ) ||
    /@sha256:0{64}$/.test(env.FEED_IMAGE_REFERENCE) ||
    (env.FEED_ENVIRONMENT === "production" &&
      !/^[a-f0-9]{64}$/.test(env.FEED_IMAGE_BUILD_ID ?? "")) ||
    !["off", "baseline"].includes(env.FEED_MODE) ||
    !/^[1-9][0-9]*$/.test(env.FEED_WRITER_EPOCH) ||
    !Number.isSafeInteger(Number(env.FEED_WRITER_EPOCH)) ||
    !["true", "false"].includes(env.FEED_EXECUTOR_ENABLED) ||
    !["true", "false"].includes(env.FEED_SOURCE_RELAY_ENABLED) ||
    secrets.some(
      (value) =>
        typeof value !== "string" ||
        new TextEncoder().encode(value).length < 32,
    ) ||
    new Set(secrets).size !== secrets.length
  ) {
    throw new HTTPError(503, "runtime_unconfigured");
  }
}

// This SDK 0.3.7 startup predicate is evaluated only on startAndWaitForPorts
// exceptions, never on HTTP response text. Its private predicate uses the same
// substring (dist/lib/container.js); unknown errors remain failures on upgrades.
const NO_INSTANCE_ERROR = "there is no container instance that can be provided to this durable object";

// The binding-only same-DO operation has one deadline for preparation, HTTP and
// body consumption. Native observations do not claim readiness without real Go.
export async function captureNativeProbe(
  fetchReady: (request: Request) => Promise<Response>,
  nativeState: () => { actorId: string; running: boolean },
  prepare?: (signal: AbortSignal) => Promise<void>,
): Promise<NativeProbe> {
  const controller = new AbortController();
  // Leave 1s within the outer 10s RPC budget for the typed result to return.
  const deadline = Date.now() + 9000;
  let preparing = !!prepare;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startupObservation = (): NativeProbe | undefined => {
    const state = nativeState();
    return state.running === false ? { actorId: state.actorId, running: false, phase: "starting" } : undefined;
  };
  const timeout = new Promise<NativeProbe>((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new HTTPError(503, "container_not_ready");
      // Only a pre-HTTP startup deadline and native not-running observation may
      // be retried as startup. A hung/malformed actual Go response never may.
      try {
        const startup = preparing ? startupObservation() : undefined;
        controller.abort(error);
        if (startup) resolve(startup);
        else reject(error);
      } catch (error) {
        controller.abort(error);
        reject(error);
      }
    }, 9000);
  });
  try {
    return await Promise.race([
      (async (): Promise<NativeProbe> => {
        if (prepare) {
          try {
            await prepare(controller.signal);
          } catch (error) {
            if (!controller.signal.aborted && error instanceof Error &&
              error.message.toLowerCase().includes(NO_INSTANCE_ERROR)) {
              const startup = startupObservation();
              if (startup) return startup;
            }
            throw error;
          }
        }
        controller.signal.throwIfAborted();
        preparing = false;
        const response = await fetchReady(new Request("http://feed-container/readyz", {
          signal: controller.signal,
        }));
        controller.signal.throwIfAborted();
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new HTTPError(503, "container_not_ready");
        const body = await readBounded(response, 4096, Math.min(5000, remaining));
        controller.signal.throwIfAborted();
        // No await between native fields: both belong to this exact actor. If
        // the process exited while the body was read, running=false fails closed.
        const { actorId, running } = nativeState();
        return { phase: "response", status: response.status, body, actorId, running };
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function targetFrom(value: string): Target {
  if (value === "api-0" || value === "api-1" || value === "executor-0")
    return value;
  throw new HTTPError(404, "not_found");
}

export async function probe(
  target: Target,
  env: RuntimeSettings,
  dispatch: Dispatch,
) {
  const production = env.FEED_ENVIRONMENT === "production";
  let status: number, body: Uint8Array, native: NativeProbe | undefined;
  if (production) {
    if (!dispatch.probe || !dispatch.actorId)
      throw new HTTPError(503, "container_version_or_contract_mismatch");
    const expectedActorId = dispatch.actorId(target);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bound RPC transport as well as the method's own same-DO operation.
      native = await Promise.race([dispatch.probe(target), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new HTTPError(503, "container_not_ready")), 10000);
      })]);
    } finally {
      clearTimeout(timer);
    }
    if (!native || !/^[a-f0-9]{64}$/.test(expectedActorId) ||
      native.actorId !== expectedActorId || typeof native.running !== "boolean")
      throw new HTTPError(503, "container_version_or_contract_mismatch");
    if (native.phase === "starting") {
      if (native.running !== false || "body" in native || "status" in native)
        throw new HTTPError(503, "container_version_or_contract_mismatch");
      throw new HTTPError(503, "container_starting");
    }
    if (native.phase !== "response" || !(native.body instanceof Uint8Array) ||
      native.body.byteLength > 4096 || !Number.isInteger(native.status))
      throw new HTTPError(503, "container_version_or_contract_mismatch");
    ({ status, body } = native);
  } else {
    const response = await dispatch.fetch(target, new Request("http://feed-container/readyz", {
      signal: AbortSignal.timeout(10000),
    }));
    status = response.status;
    body = await readBounded(response, 4096);
  }
  const data: Record<string, unknown> = JSON.parse(
    new TextDecoder().decode(body),
  );
  if (
    !data || typeof data !== "object" || Array.isArray(data) ||
    data.version !== env.FEED_RELEASE_SHA ||
    data.contractVersion !== "1" ||
    data.storageWriterVersion !== 2 ||
    data.mode !== env.FEED_MODE ||
    data.service !== (target === "executor-0" ? "feed-worker" : "feed-api") ||
    data.storeProfile !== "cf_d1_r2" ||
    data.writerEpoch !== Number(env.FEED_WRITER_EPOCH) ||
    (production && data.imageBuildId !== env.FEED_IMAGE_BUILD_ID)
  )
    throw new HTTPError(503, "container_version_or_contract_mismatch");
  if (production && native?.running !== true)
    throw new HTTPError(503, "container_not_ready");
  // Only the actual expected Go process may report a retryable dependency.
  // SDK exceptions and malformed responses never acquire this classification.
  if (status === 503 && data.ready === false)
    throw new HTTPError(503, "container_dependency_not_ready");
  if (status !== 200 || data.ready !== true)
    throw new HTTPError(503, "container_not_ready");
  // The authenticated probe is still a whitelist: dependency responses cannot
  // smuggle environment values, credentials or user information into evidence.
  return { target, ready: true, version: data.version, contractVersion: data.contractVersion,
    storageWriterVersion: data.storageWriterVersion, service: data.service,
    storeProfile: data.storeProfile, writerEpoch: data.writerEpoch,
    ...(production ? { mode: data.mode, imageBuildId: data.imageBuildId,
      actorId: native!.actorId, running: true as const } : {}) };
}

export async function handleRequest(
  request: Request,
  env: RuntimeSettings,
  dispatch: Dispatch,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      if (env.FEED_ENVIRONMENT === "production")
        return json({ healthy: true, service: "feed-runtime" });
      return json({
        healthy: true,
        service: "feed-runtime",
        version: env.FEED_RELEASE_SHA,
        contractVersion: "1",
        workerVersionId: env.WORKER_VERSION.id,
      });
    }
    if (
      url.pathname === "/readyz" ||
      url.pathname.startsWith("/internal/runtime/")
    ) {
      if (!bearerAuthorized(request, env.FEED_RUNTIME_ADMIN_SECRET))
        throw new HTTPError(401, "unauthorized");
      checkConfiguration(env);
      if (url.pathname === "/readyz" && request.method === "GET") {
        if (env.FEED_EXECUTOR_ENABLED !== "true")
          throw new HTTPError(503, "executor_not_enabled");
        const outcomes = await Promise.allSettled(
          TARGETS.map((target) => probe(target, env, dispatch)),
        );
        // A fast dependency error cannot hide a later identity/transport error.
        const failures = outcomes.filter((outcome) => outcome.status === "rejected");
        const failure = failures.find(({ reason }) =>
          !(reason instanceof HTTPError && reason.status === 503 && ["container_dependency_not_ready", "container_starting"].includes(reason.code)),
        ) ?? failures[0];
        if (failure) throw failure.reason;
        const containers = outcomes.map((outcome) => {
          if (outcome.status === "rejected") throw outcome.reason;
          return outcome.value;
        });
        if (env.FEED_ENVIRONMENT === "production" &&
          new Set(containers.map((container) => container.actorId)).size !== TARGETS.length)
          throw new HTTPError(503, "container_version_or_contract_mismatch");
        return json({
          ready: true,
          service: "feed-runtime",
          version: env.FEED_RELEASE_SHA,
          contractVersion: "1",
          workerVersionId: env.WORKER_VERSION.id,
          configuredImage: env.FEED_IMAGE_REFERENCE,
          ...(env.FEED_ENVIRONMENT === "production" ? { mode: env.FEED_MODE } : {}),
          containers,
        });
      }
      const match =
        /^\/internal\/runtime\/(api-[01]|executor-0)\/(ready|stop|restart)$/.exec(
          url.pathname,
        );
      if (!match?.[1] || !match[2] || url.search)
        throw new HTTPError(404, "not_found");
      const target = targetFrom(match[1]);
      if (target === "executor-0" && env.FEED_EXECUTOR_ENABLED !== "true")
        throw new HTTPError(503, "executor_not_enabled");
      if (match[2] === "restart" && request.method === "POST" && env.FEED_ENVIRONMENT === "production") {
        const body = await readBounded(request, 512);
        let input: unknown;
        try { input = JSON.parse(new TextDecoder().decode(body)); }
        catch { throw new HTTPError(400, "invalid_transition"); }
        validateTransition(input, env);
        if (!dispatch.restart) throw new HTTPError(503, "transition_unavailable");
        return json(await dispatch.restart(target, input));
      }
      if (match[2] === "ready" && request.method === "GET")
        return json(await probe(target, env, dispatch));
      if (
        match[2] === "stop" &&
        request.method === "POST" &&
        env.FEED_ENVIRONMENT === "staging"
      ) {
        const body = await readBounded(request, 64);
        if (body.byteLength !== 0) throw new HTTPError(400, "invalid_body");
        await dispatch.stop(target);
        return json({ stopped: true, target, signal: "SIGTERM" });
      }
      throw new HTTPError(405, "method_not_allowed");
    }
    if (!url.pathname.startsWith("/api/feed/"))
      throw new HTTPError(404, "not_found");
    if (!request.headers.get("x-feed-gateway"))
      throw new HTTPError(401, "unauthorized");
    checkConfiguration(env);
    const body = await readBounded(request);
    const githubId = await verifyGateway(
      request,
      body,
      env.FEED_GATEWAY_SECRET,
    );
    // Keep the edge closed even if an old Container is still running baseline
    // during the non-transactional Worker/Container rollout.
    if (env.FEED_ENVIRONMENT === "production" && env.FEED_MODE === "off")
      throw new HTTPError(503, "feed_disabled");
    const headers = new Headers({
      "x-feed-gateway": request.headers.get("x-feed-gateway")!,
      "content-type": "application/json",
    });
    const upstream = new Request(request.url, {
      method: request.method,
      headers,
      ...(body.byteLength ? { body } : {}),
      signal: AbortSignal.timeout(10000),
      redirect: "manual",
    });
    return publicResponse(
      await dispatch.fetch(githubId % 2 === 0 ? "api-0" : "api-1", upstream),
    );
  } catch (error) {
    if (error instanceof HTTPError)
      return json({ error: error.code }, error.status);
    // Do not log requests, bodies, credentials, IP or User-Agent.
    console.error(
      JSON.stringify({
        event: "feed_runtime_failure",
        errorType: error instanceof Error ? error.name : "unknown",
      }),
    );
    return json({ error: "feed_unavailable" }, 503);
  }
}
