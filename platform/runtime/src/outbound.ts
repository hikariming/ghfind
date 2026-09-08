import { bearerAuthorized, json } from "./security";

interface OutboundEnv {
  FEED_BRIDGE_SECRET: string;
  FEED_SOURCE_SECRET: string;
  FEED_EXECUTOR_SECRET: string;
  FEED_ADAPTER: { fetch(request: Request): Promise<Response> };
}
function bridge(
  host: string,
  paths: RegExp,
  secret: (env: OutboundEnv) => string,
  timeoutMs: number,
) {
  return async (request: Request, env: OutboundEnv): Promise<Response> => {
    const url = new URL(request.url);
    if (
      url.hostname !== host ||
      request.method !== "POST" ||
      !paths.test(url.pathname) ||
      url.search ||
      request.headers.get("x-feed-contract") !== "1" ||
      !bearerAuthorized(request, secret(env))
    )
      return json({ error: "unauthorized" }, 401);
    return env.FEED_ADAPTER.fetch(
      new Request(request, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      }),
    );
  };
}
export const bindingBridge = bridge(
  "feed-bindings.internal",
  /^\/internal\/feed\/v1\/[a-z][a-z.-]*$/,
  (env) => env.FEED_BRIDGE_SECRET,
  8000,
);
export const assessmentSource = bridge(
  "feed-source.internal",
  /^\/internal\/feed\/source\/v1\/(health|assessment)$/,
  (env) => env.FEED_SOURCE_SECRET,
  8000,
);
// pending is a read-only dispatcher capability; Go gets only discrete cleanup
// commands. It cannot poll the source outbox or enumerate pending deletions.
export const deletionCleanup = bridge(
  "feed-cleanup.internal",
  /^\/internal\/feed\/cleanup\/v1\/(claim|step|fail|release)$/,
  (env) => env.FEED_EXECUTOR_SECRET,
  20000,
);
