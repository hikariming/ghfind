/**
 * limit/offset pagination over an already-cached array. Defaults must preserve
 * each route's historical full-payload behavior (existing SDK/frontend callers
 * read `entries` and nothing else).
 */
export function parsePagination(
  req: Request,
  opts: { defaultLimit: number; maxLimit: number },
): { limit: number; offset: number } {
  // Absent params must fall back to the defaults — Number(null) is 0, so parse
  // the raw strings and treat null/empty/non-integer as "not provided".
  const params = new URL(req.url).searchParams;
  const parse = (name: string): number | null => {
    const raw = params.get(name);
    if (raw === null || raw === "") return null;
    const value = Number(raw);
    return Number.isInteger(value) ? value : null;
  };
  const rawLimit = parse("limit");
  const rawOffset = parse("offset");
  const limit =
    rawLimit === null
      ? opts.defaultLimit
      : Math.max(1, Math.min(rawLimit, opts.maxLimit));
  const offset = rawOffset === null ? 0 : Math.max(0, rawOffset);
  return { limit, offset };
}

/** Slice one page and describe it (total/nextOffset let agents walk the list). */
export function paginate<T>(
  items: readonly T[],
  { limit, offset }: { limit: number; offset: number },
): {
  entries: T[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
} {
  return {
    entries: items.slice(offset, offset + limit),
    total: items.length,
    limit,
    offset,
    nextOffset: offset + limit < items.length ? offset + limit : null,
  };
}
