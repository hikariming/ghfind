import { checkConfiguration, type RuntimeSettings } from "./router";
import { bearerAuthorized, HTTPError, json, readBounded } from "./security";

interface GovernanceEnv extends RuntimeSettings {
  FEED_ADAPTER: { fetch(request: Request): Promise<Response> };
}

// The operator token is supplied only at the protected operations entrypoint.
// It is never retained in a Container environment or accepted by the gateway.
export async function handleGovernanceRequest(
  request: Request,
  env: GovernanceEnv,
): Promise<Response> {
  try {
    if (!bearerAuthorized(request, env.FEED_RUNTIME_ADMIN_SECRET))
      throw new HTTPError(401, "unauthorized");
    checkConfiguration(env);
    const url = new URL(request.url);
    const match =
      /^\/internal\/runtime\/feed-governance\/v1\/(proposal|command|review|deprecate)$/.exec(
        url.pathname,
      );
    if (!match || url.search) throw new HTTPError(404, "not_found");
    if (request.method !== "POST")
      throw new HTTPError(405, "method_not_allowed");
    // Production bootstrap permits only the existing bounded read capabilities.
    // Review/replay require the readiness-gated baseline configuration as well
    // as both independent credentials and the exact release/epoch below.
    if (env.FEED_ENVIRONMENT === "production" && env.FEED_MODE !== "baseline" &&
      !/^(?:proposal|command)$/.test(match[1]!))
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
    if (
      request.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    )
      throw new HTTPError(415, "unsupported_media_type");
    const bytes = await readBounded(request, 32 * 1024);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      );
    } catch {
      throw new HTTPError(400, "invalid_body");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new HTTPError(400, "invalid_body");
    if (
      (match[1] === "review" || match[1] === "deprecate") &&
      body.writerEpoch !== Number(env.FEED_WRITER_EPOCH)
    )
      throw new HTTPError(409, "feed_operator_context_changed");
    // Strict DTO validation, proposal evidence and taxonomy CAS remain a single
    // authoritative adapter command; the router cannot promote a proposal itself.
    const response = await env.FEED_ADAPTER.fetch(
      new Request(
        `http://feed-adapter/internal/feed/governance/v1/${match[1]}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-feed-contract": "1",
          },
          body: bytes,
          signal: AbortSignal.timeout(10000),
          redirect: "manual",
        },
      ),
    );
    const output = await readBounded(response, 64 * 1024);
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
