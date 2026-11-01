/**
 * Browser-side deadline for interactive /api/roast streams.
 *
 * Server attach + v12 fallback is designed to finish inside the ~220s Worker
 * LLM ceiling. The client aborts slightly under that so a hung upstream cannot
 * spin the UI until the browser's own network timeout.
 */
export const ROAST_CLIENT_TIMEOUT_MS = 200_000;

/** True when a fetch/stream failed because the client deadline fired. */
export function isRoastClientTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

/** AbortSignal for one interactive roast attempt. */
export function roastClientSignal(timeoutMs = ROAST_CLIENT_TIMEOUT_MS): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}
