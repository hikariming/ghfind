import { describe, expect, it } from "vitest";
import { emptyState, WINDOW_MS, type MetricState } from "../engine";
import { billingDue, COLLECTION_KEY, internalDiagnostics, observeCollection } from "../collection-health";

const base = 1_800_000_000_000;
function failure(state: ReturnType<typeof emptyState>, minutes: number, reason = "D1: rate limited") {
  observeCollection(state, [reason], base + minutes * 60_000, base + minutes * 60_000 - 3 * WINDOW_MS);
}
function success(state: ReturnType<typeof emptyState>, minutes: number) {
  observeCollection(state, [], base + minutes * 60_000, base + minutes * 60_000 - 3 * WINDOW_MS);
}

describe("internal collection health", () => {
  it("retains persistent missing telemetry without sending customer mail or inventing success", () => {
    let state = emptyState();
    state.lastSuccess = base - WINDOW_MS;
    state.lastError = "D1: rate limited";
    for (let minute = 0; minute <= 3 * 24 * 60; minute += 5) {
      failure(state, minute);
      state = JSON.parse(JSON.stringify(state));
    }
    expect(state.outbox).toHaveLength(0);
    expect(state.collection).toMatchObject({ since: base, failures: 865, lastCompleteAt: base - WINDOW_MS, good: 0, reason: "D1: rate limited" });
    expect(state.lastError).toBe("D1: rate limited");
    expect(state.lastSuccess).toBe(base - WINDOW_MS);
    expect(state.mailReceipts).toHaveLength(0);
  });

  it("does not count repeated runs in one five-minute interval as distinct failures", () => {
    const state = emptyState();
    failure(state, 0); failure(state, 0); failure(state, 1); failure(state, 2);
    expect(state.collection!.failures).toBe(1);
  });

  it("confirms recovery on two distinct complete windows without an email", () => {
    const state = emptyState();
    failure(state, 0); failure(state, 15); failure(state, 30);
    success(state, 35); success(state, 35);
    expect(state.collection).toMatchObject({ since: base, good: 1 });
    success(state, 40);
    expect(state.collection).toMatchObject({ since: 0, failures: 0, reason: "" });
    expect(state.outbox).toHaveLength(0);
    failure(state, 45);
    expect(state.collection!.since).toBe(base + 45 * 60_000);
  });

  it("keeps one incident across a good window and changing failure reasons", () => {
    const state = emptyState();
    failure(state, 0); failure(state, 30);
    success(state, 35); failure(state, 40, "Workers: permission denied");
    expect(state.collection).toMatchObject({ since: base, good: 0, failures: 3, reason: "Workers: permission denied" });
    expect(state.outbox).toHaveLength(0);
  });

  it("retires legacy collection and optimization notices, including partial delivery receipts", () => {
    const state = emptyState();
    failure(state, 0);
    Object.assign(state.collection!, { notified: true, lastNotifiedAt: base, acceptedRecipients: ["one@example.org"] });
    const notice = { id: "legacy", kind: "open" as const, severity: 2, text: "legacy", delivered: ["one@example.org"], attempts: 1, expiresAt: base + 86400_000 };
    state.outbox.push({ ...notice, key: COLLECTION_KEY }, { ...notice, key: "D1:db:sql-hash-read" }, { ...notice, id: "business", key: "Service:roast:errors" });
    failure(state, 30);
    expect(state.outbox.map(n => n.key)).toEqual(["Service:roast:errors"]);
    expect(state.outbox[0].delivered).toEqual(["one@example.org"]);
    expect(state.collection!.acceptedRecipients).toBeUndefined();
    expect(state.collection!.notified).toBeUndefined();
    expect(state.collection!.lastNotifiedAt).toBeUndefined();
  });

  it("sanitizes the retained diagnostic size without manufacturing a spend incident", () => {
    const state = emptyState();
    observeCollection(state, Array.from({ length: 20 }, (_, i) => `source-${i}: ${"x".repeat(100)}`), base, base - WINDOW_MS);
    expect(state.collection!.reason.length).toBeLessThanOrEqual(500);
    expect(state.outbox).toHaveLength(0);
  });

  it("reconciles billing every six hours and retries failures at most hourly", () => {
    const state = emptyState();
    expect(billingDue(state, base)).toBe(true);
    state.lastBillingAttempt = base;
    expect(billingDue(state, base + WINDOW_MS)).toBe(false);
    expect(billingDue(state, base + 3600_000)).toBe(true);
    state.lastBilling = base + 3600_000;
    expect(billingDue(state, base + 6 * 3600_000)).toBe(false);
    expect(billingDue(state, base + 7 * 3600_000)).toBe(true);
  });
});


describe("bounded operator diagnostics", () => {
  const metric: MetricState = { baseline: 1, samples: 12, bad: 2, good: 0, severity: 1, notifiedSeverity: 0, lastNotified: 0, lastSeen: base, expiresAt: base + WINDOW_MS, incident: 1 };

  it("reports internal active count and at most sixteen highest priority identifiers", () => {
    const state = emptyState();
    for (let i = 0; i < 30; i++) state.metrics[`D1:database-${i}:sql-fingerprint-read`] = { ...metric, severity: i < 10 ? 2 : 1, lastSeen: base + i };
    for (const key of ["Service:roast:errors", "Service:roast:slow", "Workers:api:errors", "account:burn", "Billing:account:daily"]) state.metrics[key] = { ...metric, severity: 2 };
    state.metrics["Workers:api:cpu"] = { ...metric, severity: 0 };
    state.metrics["D1:expired:read"] = { ...metric, expiresAt: base };
    const summary = internalDiagnostics(state, base);
    expect(summary.active).toBe(30);
    expect(summary.items).toHaveLength(16);
    expect(summary.items[0]).toEqual({key: "D1:database-9:sql-fingerprint-read", severity: 2, lastSeen: base + 9});
    expect(summary.items.every(item => Object.keys(item).sort().join(",") === "key,lastSeen,severity")).toBe(true);
    expect(JSON.stringify(summary).length).toBeLessThan(5 * 1024);
    expect(internalDiagnostics(state, base + WINDOW_MS)).toEqual({active: 0, items: []});
  });

  it("bounds identifiers without exposing legacy notice content or recipient state", () => {
    const state = emptyState();
    state.metrics[`D1:${"x".repeat(400)}:read`] = { ...metric };
    state.outbox = [{ id: "legacy", key: "Monitor:collection:health", severity: 2, kind: "open", text: "private diagnostic body", delivered: ["one@example.org"], attempts: 1, expiresAt: base + WINDOW_MS }];
    const summary = internalDiagnostics(state, base);
    expect(summary.items[0].key.length).toBe(160);
    expect(JSON.stringify(summary)).not.toMatch(/private|example|baseline|delivered/);
    expect(state.outbox[0].delivered).toEqual(["one@example.org"]);
  });
});
