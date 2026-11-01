/**
 * Runtime parity with the legacy OpenNext Worker, which src/lib was written
 * against. workerd rejects most RequestInit `cache` modes ("Unsupported cache
 * mode: default") and OpenNext strips the option globally; without the same
 * shim, e.g. every Upstash call in src/lib/redis.ts (`cache: "default"`)
 * throws, which silently disables caching and fails rate limits closed.
 * Import this before anything that might issue a fetch.
 */
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (init) delete init.cache;
  return originalFetch(input, init);
}) as typeof fetch;

const OriginalRequest = globalThis.Request;
globalThis.Request = class extends OriginalRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (init) delete init.cache;
    super(input, init);
  }
  // Native requests (the incoming one, fetch results) must still pass
  // `instanceof Request`: NextRequest branches on it and otherwise rebuilds
  // the request from its URL alone, silently dropping headers and cookies.
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof OriginalRequest;
  }
} as typeof Request;
