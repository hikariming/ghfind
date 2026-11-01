import { WINDOW_MS, type State } from "./engine";
import { discardInternalMail, userFacing } from "./mail-policy";

export const COLLECTION_KEY = "Monitor:collection:health";

export interface CollectionHealthState {
  since: number;
  lastFailureWindow: number;
  lastSuccessWindow: number;
  failures: number;
  good: number;
  lastCompleteAt: number;
  reason: string;
  // Legacy delivery fields are read only for migration and immediately removed.
  lastNotifiedAt?: number;
  notified?: boolean;
  acceptedRecipients?: string[];
}

export function internalDiagnostics(state: State, now: number): {
  active: number;
  items: {key: string; severity: number; lastSeen: number}[];
} {
  const active = Object.entries(state.metrics)
    .filter(([key, metric]) => !userFacing({key}) && metric.severity > 0 && metric.expiresAt > now)
    .sort(([a, x], [b, y]) => y.severity - x.severity || y.lastSeen - x.lastSeen || a.localeCompare(b));
  return {
    active: active.length,
    // Keys are bounded collector-owned identifiers (SQL fingerprints, never SQL
    // text). Do not serialize notice text, recipient receipts or whole states.
    items: active.slice(0, 16).map(([key, metric]) => ({key: key.slice(0, 160), severity: metric.severity, lastSeen: metric.lastSeen})),
  };
}

// Only caller-owned, sanitized collection classifications belong here. Raw
// provider responses, SQL, credentials and request URLs must never be passed in.
// This state is for /health and operator logs; it never creates customer mail.
export function observeCollection(state: State, errors: string[], now: number, observedWindow: number): void {
  discardInternalMail(state);
  state.collection ??= {
    since: 0, lastFailureWindow: 0, lastSuccessWindow: 0, failures: 0,
    good: 0, lastCompleteAt: state.lastSuccess, reason: "",
  };
  const health = state.collection;
  if (!errors.length) {
    if (observedWindow <= health.lastSuccessWindow) return;
    health.lastSuccessWindow = observedWindow;
    health.lastCompleteAt = now;
    health.good++;
    // Keep an interrupted incident until two distinct complete windows confirm
    // recovery. Missing coverage never becomes a zero-cost observation.
    if (health.good >= 2) {
      health.since = 0;
      health.failures = 0;
      health.reason = "";
    }
    return;
  }

  const failureWindow = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  if (!health.since) health.since = now;
  if (failureWindow !== health.lastFailureWindow) {
    health.failures++;
    health.lastFailureWindow = failureWindow;
  }
  health.good = 0;
  health.reason = [...new Set(errors)].slice(0, 6).join("；").slice(0, 500);
}

export function billingDue(state: State, now: number): boolean {
  if (state.lastBilling && now - state.lastBilling < 6 * 3600_000) return false;
  // A failed billing read must not turn a six-hour reconciliation into twelve
  // requests per hour. Retry independently of the healthy fast telemetry.
  return !state.lastBillingAttempt || now - state.lastBillingAttempt >= 3600_000;
}
