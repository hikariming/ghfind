/**
 * Bounded in-isolate cache for read models that are not worth a Workers KV
 * write: empty discovery answers and crawler renders. A KV write costs more
 * than the database read it would save on that long tail.
 *
 * The Workers Cache API (`caches.default.match` / `caches.open`) generates an
 * internal 504 on miss or expiry. Cloudflare Logs record that as
 * `RequestSource: edgeWorkerCacheAPI`, and zone GraphQL
 * `httpRequestsAdaptiveGroups` counts it as a ghfind.com 5xx even when the
 * cache key uses a never-served host (`edge-cache.ghfind.internal`). Dashboard
 * HTTP/Cache Analytics filter `requestSource=eyeball`; GraphQL does not.
 * Named caches and a different key origin still log those 504s, so this
 * module stays isolate-local. #464 still holds: nothing here writes KV.
 */

/** Bounded TTL map (oldest-inserted evicted first) for one isolate. */
export function createLocalCache<T>(ttlMs: number, maxEntries: number) {
  const entries = new Map<string, { value: T; expires: number }>();
  return {
    get(key: string): T | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expires <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: T): void {
      entries.delete(key);
      entries.set(key, { value, expires: Date.now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}
