/**
 * Unknown slug on a dynamic route: an empty 404, which Astro replaces with
 * src/pages/404.astro (keeping this response's status and headers).
 */
export function notFound(): Response {
  return new Response(null, { status: 404 });
}

/**
 * A request only the legacy Worker can answer. The router (apps/router) sees
 * the marker and re-dispatches it there unchanged.
 */
export const NOT_FOUND_FALLBACK_HEADER = "X-Ghfind-Fallback";

export function notFoundToLegacy(): Response {
  return new Response(null, { status: 404, headers: { [NOT_FOUND_FALLBACK_HEADER]: "legacy" } });
}

/** Static content pages: edge-cache a day, serve stale for a week (as /about). */
export const STATIC_PAGE_CACHE = "public, s-maxage=86400, stale-while-revalidate=604800";
