import { checkConfiguration, type RuntimeSettings } from "./router";
import { bearerAuthorized, HTTPError, json, readBounded } from "./security";
interface AdminEnv extends RuntimeSettings {
  FEED_ADAPTER: { fetch(request: Request): Promise<Response> };
}

export async function handleAdminRequest(
  request: Request,
  env: AdminEnv,
): Promise<Response> {
  try {
    if (!bearerAuthorized(request, env.FEED_RUNTIME_ADMIN_SECRET))
      throw new HTTPError(401, "unauthorized");
    checkConfiguration(env);
    const url = new URL(request.url);
    const match = /^\/internal\/runtime\/feed-admin\/v1\/(status|replay)$/.exec(
      url.pathname,
    );
    if (!match?.[1] || url.search) throw new HTTPError(404, "not_found");
    if (request.method !== "POST")
      throw new HTTPError(405, "method_not_allowed");
    // Production bootstrap permits only the existing bounded read capabilities.
    // Review/replay require the readiness-gated baseline configuration as well
    // as both independent credentials and the exact release/epoch below.
    if (env.FEED_ENVIRONMENT === "production" && env.FEED_MODE !== "baseline" &&
      !/^(?:status)$/.test(match[1]!))
      throw new HTTPError(503, "feed_operator_target_disabled");
    if (
      request.headers.get("x-feed-contract") !== "1" ||
      request.headers.get("x-feed-target") !== env.FEED_ENVIRONMENT ||
      request.headers.get("x-feed-release") !== env.FEED_RELEASE_SHA ||
      request.headers.get("x-feed-writer-epoch") !== env.FEED_WRITER_EPOCH
    )
      throw new HTTPError(409, "feed_operator_context_changed");
    const token = request.headers.get("x-feed-operator") ?? "";
    if (
      new TextEncoder().encode(token).length < 32 ||
      token.length > 512 ||
      token === env.FEED_RUNTIME_ADMIN_SECRET
    )
      throw new HTTPError(401, "unauthorized");
    const bytes = await readBounded(request, 2048);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new HTTPError(400, "invalid_body");
    }
    const fields =
      match[1] === "status"
        ? ["kind", "id"]
        : [
            "kind",
            "id",
            ...(body?.kind === "coreSource" ? [] : ["writerEpoch"]),
            "commandId",
            "operator",
            "reason",
          ];
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== fields.length ||
      Object.keys(body).some((key) => !fields.includes(key)) ||
      !["sourceEvent", "deletion", "coreSource"].includes(String(body.kind)) ||
      typeof body.id !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,160}$/.test(body.id)
    )
      throw new HTTPError(400, "invalid_body");
    if (
      body.kind === "coreSource" &&
      (!/^[1-9][0-9]{0,15}$/.test(String(body.id)) ||
        !Number.isSafeInteger(Number(body.id)))
    )
      throw new HTTPError(400, "invalid_body");
    if (
      match[1] === "replay" &&
      ((body.kind !== "coreSource" &&
        body.writerEpoch !== Number(env.FEED_WRITER_EPOCH)) ||
        typeof body.commandId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
          body.commandId,
        ) ||
        typeof body.operator !== "string" ||
        body.operator.length < 1 ||
        body.operator.length > 100 ||
        typeof body.reason !== "string" ||
        body.reason.trim().length < 8 ||
        body.reason.length > 500)
    )
      throw new HTTPError(400, "invalid_body");
    const response = await env.FEED_ADAPTER.fetch(
      new Request(`http://feed-adapter/internal/feed/admin/v1/${match[1]}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-feed-contract": "1",
        },
        body: bytes,
        signal: AbortSignal.timeout(10000),
        redirect: "manual",
      }),
    );
    const output = await readBounded(response, 16 * 1024);
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
    return json({ error: "feed_operator_unavailable" }, 503);
  }
}
