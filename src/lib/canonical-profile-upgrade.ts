const MIN_POLL_MS = 5_000;
const MAX_POLL_MS = 30_000;

/** The bounded profile-side watcher accepts only the status API's terminal shape. */
export function isCanonicalProfileUpgradeComplete(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "complete_public"
  );
}

/** Keep status polling inside the endpoint's advertised retry window. */
export function canonicalProfileUpgradePollMs(retryAfter: unknown): number {
  const seconds = typeof retryAfter === "number" ? retryAfter : Number(retryAfter);
  if (!Number.isFinite(seconds)) return MIN_POLL_MS;
  return Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, Math.round(seconds * 1_000)));
}
