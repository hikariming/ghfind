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
export interface Dispatch {
  fetch(target: Target, request: Request): Promise<Response>;
  stop(target: Target): Promise<void>;
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
>;

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
  const response = await dispatch.fetch(
    target,
    new Request("http://feed-container/readyz", {
      signal: AbortSignal.timeout(10000),
    }),
  );
  if (!response.ok) throw new HTTPError(503, "container_not_ready");
  const data: Record<string, unknown> = JSON.parse(
    new TextDecoder().decode(await readBounded(response, 4096)),
  );
  if (
    data.ready !== true ||
    data.version !== env.FEED_RELEASE_SHA ||
    data.contractVersion !== "1" ||
    data.service !== (target === "executor-0" ? "feed-worker" : "feed-api") ||
    data.storeProfile !== "cf_d1_r2" ||
    String(data.writerEpoch) !== env.FEED_WRITER_EPOCH
  )
    throw new HTTPError(503, "container_version_or_contract_mismatch");
  return { target, ...data };
}

export async function handleRequest(
  request: Request,
  env: RuntimeSettings,
  dispatch: Dispatch,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
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
        const containers = await Promise.all(
          TARGETS.map((target) => probe(target, env, dispatch)),
        );
        return json({
          ready: true,
          service: "feed-runtime",
          version: env.FEED_RELEASE_SHA,
          contractVersion: "1",
          workerVersionId: env.WORKER_VERSION.id,
          configuredImage: env.FEED_IMAGE_REFERENCE,
          containers,
        });
      }
      const match =
        /^\/internal\/runtime\/(api-[01]|executor-0)\/(ready|stop)$/.exec(
          url.pathname,
        );
      if (!match?.[1] || !match[2] || url.search)
        throw new HTTPError(404, "not_found");
      const target = targetFrom(match[1]);
      if (target === "executor-0" && env.FEED_EXECUTOR_ENABLED !== "true")
        throw new HTTPError(503, "executor_not_enabled");
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
