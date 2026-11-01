/**
 * Talent Match report quota (pure; the D1 counts are passed in). The ledger is
 * talent_reports itself: only `done`, non-BYO-key candidate reports created in
 * the current UTC month count, so failures never consume quota. A user's own
 * API key bypasses the monthly limit and the global token budget, but never
 * the one-report-in-flight rule.
 */

export const MONTHLY_REPORT_LIMIT = 2;
export const MAX_IN_FLIGHT_REPORTS = 1;

export interface Quota {
  used: number;
  limit: number;
  /** ISO timestamp of the next UTC month start. */
  resetsAt: string;
}

/** [start, end) of the UTC calendar month containing `now`, in Unix ms. */
export function monthWindow(now: number): { start: number; end: number } {
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return { start, end };
}

export function quotaFor(doneThisMonth: number, now: number): Quota {
  return {
    used: Math.min(MONTHLY_REPORT_LIMIT, Math.max(0, doneThisMonth)),
    limit: MONTHLY_REPORT_LIMIT,
    resetsAt: new Date(monthWindow(now).end).toISOString(),
  };
}

export type AdmissionInput = {
  /** Done, non-BYO candidate reports this UTC month. */
  doneThisMonth: number;
  /** The user's queued + running reports. */
  inFlight: number;
  byoKey: boolean;
  /** Tokens spent by free-channel reports this month, across all users. */
  monthTokens: number;
  /** From {@link parseTokenBudget}: null = no global budget, 0 = free channel paused. */
  monthTokenBudget: number | null;
};

export type Admission =
  | { ok: true }
  | { ok: false; reason: "in_flight" | "quota_exhausted" | "budget_exhausted" };

export function admitReport(input: AdmissionInput): Admission {
  if (input.inFlight >= MAX_IN_FLIGHT_REPORTS) return { ok: false, reason: "in_flight" };
  if (input.byoKey) return { ok: true };
  if (input.doneThisMonth >= MONTHLY_REPORT_LIMIT) return { ok: false, reason: "quota_exhausted" };
  const budget = input.monthTokenBudget;
  if (budget !== null && input.monthTokens >= budget) {
    return { ok: false, reason: "budget_exhausted" };
  }
  return { ok: true };
}

/**
 * Parse TALENT_MONTHLY_TOKEN_BUDGET. Unset means no global budget; a set but
 * invalid value fails closed (0 pauses the free channel) so a typo can never
 * remove the cost ceiling.
 */
export function parseTokenBudget(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const budget = Number(value.trim());
  return Number.isSafeInteger(budget) && budget >= 0 ? budget : 0;
}
