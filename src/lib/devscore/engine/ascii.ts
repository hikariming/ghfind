/**
 * Byte-level string helpers matching Zig's `std.ascii` / `std.fmt.parseInt`:
 * only A-Z fold (JS `toLowerCase` also folds non-ASCII letters, e.g. the
 * Kelvin sign, which Zig does not).
 */

export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** `std.ascii.eqlIgnoreCase`. */
export function eqlIgnoreCase(a: string, b: string): boolean {
  return a.length === b.length && asciiLower(a) === asciiLower(b);
}

/**
 * The UTF-8 bytes of `s` as a string of one char per byte, so indices and
 * lengths match Zig's `[]const u8` (non-ASCII bytes never match ASCII tests).
 */
export function utf8Bytes(s: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) out += String.fromCharCode(b);
  return out;
}

/**
 * `std.fmt.parseInt(uN, s, 10)` with `max` = maxInt(uN): an optional `+`,
 * decimal digits, `_` separators not at either end; null where Zig errors.
 */
export function parseUint(s: string, max: number): number | null {
  if (!/^\+?[0-9](?:[0-9_]*[0-9])?$/.test(s)) return null;
  const n = Number(s.replace(/[+_]/g, ""));
  return n <= max ? n : null;
}
