/**
 * Safe decoding for dynamic route segments.
 *
 * Next.js already percent-decodes `params`, so a segment can legitimately still
 * contain a literal `%` (e.g. `/api/badge/%25` arrives as `"%"`). Calling
 * `decodeURIComponent` on that throws `URIError`, which surfaces as a 500 from
 * routes whose whole point is to answer with a 400/404/placeholder for input
 * they don't recognise. Decoding through this helper keeps the existing lenient
 * behaviour for well-formed input and degrades to the raw segment instead of
 * crashing on a malformed escape.
 */
export function decodeRouteParam(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
