import { bearerAuthorized, json, HTTPError, readBounded } from "./security";

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
  /^\/internal\/feed\/v1\/(health|taxonomy\.(list|propose)|users\.(ensure|get)|preferences\.replace|candidates\.load|projects\.available|requests\.save|state\.set|events\.append|profile\.(delete|deletion\.get)|sessions\.(put|get|delete))$/,
  (env) => env.FEED_BRIDGE_SECRET,
  8000,
);
export const executorBindingBridge = bridge(
  "feed-bindings.internal",
  /^\/internal\/feed\/v1\/(health|jobs\.(claim|complete|fail)|projection\.apply)$/,
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

const ARCHIVE_WIRE_LIMIT = 6 * 1024 * 1024;
function validateArchiveBytes(value: unknown): void {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new HTTPError(400, "invalid_archive_encoding");
  const bytes =
    (value.length / 4) * 3 -
    (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
  if (bytes > 4 * 1024 * 1024)
    throw new HTTPError(413, "archive_object_too_large");
}
// Registered only on FeedExecutor. This dedicated transport limit does not
// change the public, storage bridge, source or cleanup request contracts.
export async function archiveObjects(
  request: Request,
  env: OutboundEnv,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const match = /^\/internal\/feed\/archive\/v1\/(health|put|get)$/.exec(
      url.pathname,
    );
    if (
      url.hostname !== "feed-archive.internal" ||
      request.method !== "POST" ||
      !match ||
      url.search ||
      request.headers.get("x-feed-contract") !== "1" ||
      !bearerAuthorized(request, env.FEED_EXECUTOR_SECRET)
    )
      return json({ error: "unauthorized" }, 401);
    const input = await readBounded(request, ARCHIVE_WIRE_LIMIT, 20000);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(input));
    } catch {
      throw new HTTPError(400, "invalid_archive_json");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new HTTPError(400, "invalid_archive_json");
    if (match[1] === "put")
      validateArchiveBytes((body as Record<string, unknown>).bodyBase64);
    const response = await env.FEED_ADAPTER.fetch(
      new Request(request.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.FEED_EXECUTOR_SECRET}`,
          "x-feed-contract": "1",
          "content-type": "application/json",
        },
        body: input,
        signal: AbortSignal.timeout(20000),
        redirect: "manual",
      }),
    );
    const output = await readBounded(response, ARCHIVE_WIRE_LIMIT, 20000);
    if (response.ok && match[1] === "get") {
      const result = JSON.parse(new TextDecoder().decode(output)) as Record<
        string,
        unknown
      >;
      validateArchiveBytes(result.bodyBase64);
    }
    return new Response(output, {
      status: response.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-feed-contract": "1",
      },
    });
  } catch (error) {
    if (error instanceof HTTPError)
      return json({ error: error.code }, error.status);
    return json({ error: "archive_unavailable" }, 503);
  }
}
