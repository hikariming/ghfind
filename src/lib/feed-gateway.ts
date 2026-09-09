import { createHash, createHmac } from "node:crypto";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";

export const FEED_BODY_LIMIT = 128 * 1024;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };

type FeedViewer = { githubId: number; login: string; image: string | null };

export class FeedBodyTooLarge extends Error {}
export class FeedBodyTimeout extends Error {}

// Content-Length is advisory: chunked requests and dishonest clients must also
// be bounded before signing, parsing or forwarding their bodies.
export async function readBoundedBody(body: ReadableStream<Uint8Array> | null, limit: number, timeoutMs = 5_000): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FeedBodyTimeout("Feed body read timed out.")), timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        throw new FeedBodyTooLarge("Feed body exceeds its limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    // A peer's cancellation promise must not extend the bounded read deadline.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function signFeedGateway(input: {
  viewer: FeedViewer; method: string; target: string; body: Uint8Array; secret: string; now?: number;
}): string {
  if (Buffer.byteLength(input.secret) < 32 || !Number.isSafeInteger(input.viewer.githubId) || input.viewer.githubId <= 0 || !input.viewer.login) {
    throw new Error("Invalid Feed gateway configuration or identity.");
  }
  const now = input.now ?? Date.now();
  const claims = {
    version: 1,
    audience: "feed-api",
    githubId: input.viewer.githubId,
    login: input.viewer.login,
    avatarUrl: input.viewer.image ?? "",
    issuedAt: now,
    expiresAt: now + 30_000,
    method: input.method.toUpperCase(),
    target: input.target,
    bodySha256: createHash("sha256").update(input.body).digest("hex"),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", input.secret).update(`feed-gateway-v1\n${payload}`).digest("base64url");
  return `${payload}.${signature}`;
}

function unavailable(): NextResponse {
  return NextResponse.json({ error: "feed_unavailable", message: "Feed service is temporarily unavailable." }, {
    status: 503, headers: { ...NO_STORE, "Retry-After": "30" },
  });
}

// The binding changes transport only. Authentication still uses the same
// signed actor, request target and body as the portable HTTP deployment.
function feedTransport(): typeof fetch {
  let binding: unknown;
  try {
    binding = (getCloudflareContext().env as { FEED_RUNTIME?: unknown }).FEED_RUNTIME;
  } catch {
    // Ordinary Node/Docker has no Cloudflare request context.
    return fetch;
  }
  if (binding === undefined) return fetch;
  if (!binding || typeof (binding as { fetch?: unknown }).fetch !== "function") {
    throw new Error("Invalid Feed runtime service binding.");
  }
  const service = binding as { fetch: typeof fetch };
  return service.fetch.bind(service);
}

// Only authenticated route handlers may call this function. null deliberately
// leaves the existing implementation in control while the rollout is disabled.
export async function forwardFeedRequest(request: Request, viewer: FeedViewer): Promise<NextResponse | null> {
  const backend = process.env.FEED_BACKEND ?? "legacy";
  if (backend === "legacy") return null;
  if (backend !== "go") return unavailable();

  const secret = process.env.FEED_GATEWAY_SECRET ?? "";
  const configuredOrigin = process.env.FEED_API_ORIGIN;
  if (!configuredOrigin || Buffer.byteLength(secret) < 32 || [process.env.AUTH_SECRET, process.env.FEED_SIGNING_SECRET, process.env.FEED_BRIDGE_SECRET].includes(secret)) {
    return unavailable();
  }

  let requestBodyRead = false;
  try {
    const upstream = new URL(configuredOrigin);
    const localDevelopment = process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "[::1]"].includes(upstream.hostname);
    if ((upstream.protocol !== "https:" && !(upstream.protocol === "http:" && localDevelopment)) || upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash) {
      return unavailable();
    }
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/feed/")) return unavailable();
    const body = await readBoundedBody(request.body, FEED_BODY_LIMIT);
    requestBodyRead = true;
    const target = url.pathname + url.search;
    const headers = new Headers({
      Accept: "application/json",
      "Cache-Control": "no-store",
      "X-Feed-Gateway": signFeedGateway({ viewer, method: request.method, target, body, secret }),
    });
    if (body.byteLength > 0) headers.set("Content-Type", request.headers.get("content-type") ?? "application/octet-stream");
    // Construct the headers from scratch: no client identity, cookie,
    // Authorization, forwarding/IP header or administrative credential escapes.
    const response = await feedTransport()(`${upstream.origin}${target}`, {
      method: request.method,
      headers,
      body: body.byteLength ? Buffer.from(body) : undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      await response.body?.cancel();
      return unavailable();
    }
    const bytes = await readBoundedBody(response.body, RESPONSE_LIMIT);
    // Parsing ensures an ingress error page cannot masquerade as a Feed result.
    const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const responseHeaders = new Headers(NO_STORE);
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter && /^\d{1,4}$/.test(retryAfter)) responseHeaders.set("Retry-After", retryAfter);
    return NextResponse.json(result, { status: response.status, headers: responseHeaders });
  } catch (error) {
    if ((error instanceof FeedBodyTooLarge || error instanceof FeedBodyTimeout) && !requestBodyRead) {
      return NextResponse.json({ error: "invalid_body", message: error instanceof FeedBodyTimeout ? "Feed request body timed out." : "Feed request body is too large." }, { status: 400, headers: NO_STORE });
    }
    // Avoid logging headers, signed claims, response bodies or OAuth identifiers.
    console.error("feed.gateway_unavailable");
    return unavailable();
  }
}
