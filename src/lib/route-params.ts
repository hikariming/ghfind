/**
 * Safe decoding for dynamic route segments.
 *
 * Next.js already percent-decodes `params`, so a segment can legitimately
 * contain a literal `%` (`/api/badge/%25` arrives as `"%"`), and
 * `decodeURIComponent` throws `URIError` on that. This degrades to the raw
 * segment instead.
 */
export function decodeRouteParam(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
