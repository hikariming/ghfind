import { timingSafeEqual } from "node:crypto";

export const BODY_LIMIT = 128 * 1024;
const encoder = new TextEncoder();

export class HTTPError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function readBounded(
  input: Request | Response,
  limit = BODY_LIMIT,
  timeoutMs = 5000,
): Promise<Uint8Array> {
  const declared = input.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > limit)
  ) {
    throw new HTTPError(413, "body_too_large");
  }
  if (!input.body) return new Uint8Array();
  const reader = input.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new HTTPError(408, "body_timeout")),
      timeoutMs,
    );
  });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        throw new HTTPError(413, "body_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    // Cleanup must not extend the deadline when a peer stalls cancellation.
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
    offset += chunk.length;
  }
  return bytes;
}

export function bearerAuthorized(request: Request, secret: string): boolean {
  if (encoder.encode(secret).length < 32) return false;
  const supplied = request.headers.get("authorization") ?? "";
  const left = encoder.encode(supplied);
  const right = encoder.encode(`Bearer ${secret}`);
  return left.length === right.length && timingSafeEqual(left, right);
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
}

interface Claims {
  version: number;
  audience: string;
  githubId: number;
  login: string;
  issuedAt: number;
  expiresAt: number;
  method: string;
  target: string;
  bodySha256: string;
}

export async function verifyGateway(
  request: Request,
  body: Uint8Array,
  secret: string,
  now = Date.now(),
): Promise<number> {
  try {
    if (encoder.encode(secret).length < 32)
      throw new Error("secret unavailable");
    const token = request.headers.get("x-feed-gateway");
    if (!token || token.length > 4096) throw new Error("invalid token");
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1])
      throw new Error("invalid token");
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      decode(parts[1]),
      encoder.encode(`feed-gateway-v1\n${parts[0]}`),
    );
    if (!valid) throw new Error("invalid signature");
    const claims: Claims = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        decode(parts[0]),
      ),
    );
    const url = new URL(request.url);
    if (
      claims.version !== 1 ||
      claims.audience !== "feed-api" ||
      !Number.isSafeInteger(claims.githubId) ||
      claims.githubId <= 0 ||
      typeof claims.login !== "string" ||
      !/^[A-Za-z0-9-]{1,39}$/.test(claims.login) ||
      !Number.isSafeInteger(claims.issuedAt) ||
      !Number.isSafeInteger(claims.expiresAt) ||
      claims.issuedAt > now + 5000 ||
      claims.expiresAt < now - 5000 ||
      claims.expiresAt <= claims.issuedAt ||
      claims.expiresAt - claims.issuedAt > 60000 ||
      claims.method !== request.method ||
      claims.target !== url.pathname + url.search
    ) {
      throw new Error("invalid claims");
    }
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new Uint8Array(body)),
      ),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    if (claims.bodySha256 !== hash) throw new Error("invalid body");
    return claims.githubId;
  } catch {
    throw new HTTPError(401, "unauthorized");
  }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function publicResponse(response: Response): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of ["content-type", "retry-after"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers });
}
