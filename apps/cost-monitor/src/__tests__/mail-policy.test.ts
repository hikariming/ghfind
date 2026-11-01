import { describe, it, expect } from "vitest";
import { discardInternalMail, selectMail, urgent, userFacing, DIGEST_MS, dailySlot } from "../mail-policy";
import { emptyState, type Notice } from "../engine";

const notice = (key: string, severity = 2, kind: Notice["kind"] = "open"): Notice => ({ key, severity, kind, id: key, text: "", delivered: [], attempts: 0, expiresAt: 1e15 });

describe("customer alert audience", () => {
  it("keeps only measured service failures, slow responses and account spending signals", () => {
    for (const key of ["Service:roast:errors", "Service:roast:slow", "Service:probe-home:errors", "Workers:ghfind-api:errors", "account:burn", "Billing:account:daily"]) {
      expect(userFacing(notice(key))).toBe(true);
    }
    for (const key of ["Monitor:collection:health", "Monitor:collector:failed", "Workers:ghfind-cost-monitor:errors", "Workers:ghfind-cost-monitor-e2e:errors", "Workers:ghfind-cost-monitor-local:errors", "Workers:ghfind-cost-monitor-local-e2e:errors", "D1:db:read", "D1:db:sql-123-read", "KV:cache:write", "Workers:ghfind-api:cpu", "R2:bucket:storage:Standard", "DO:namespace:duration", "Billing:unknown:forecast"]) {
      expect(userFacing(notice(key))).toBe(false);
      expect(urgent(notice(key))).toBe(false);
    }
  });

  it("never leaks internal notices into either urgent messages or a mixed hourly digest", () => {
    const internal = [notice("Monitor:collection:health"), notice("D1:db:read"), notice("Workers:api:cpu")];
    const customer = [notice("Service:roast:errors"), notice("Workers:api:errors", 1)];
    expect(selectMail(internal, DIGEST_MS, DIGEST_MS)).toEqual([]);
    expect(selectMail([...internal, ...customer], 0, DIGEST_MS)).toEqual([customer[0]]);
    expect(selectMail([...internal, ...customer], DIGEST_MS, DIGEST_MS)).toEqual(customer);
  });

  it("batches slow responses, worker errors, reminders and recovery until the hourly digest", () => {
    const rows = [notice("Service:roast:slow"), notice("Workers:api:errors"), notice("Service:roast:errors", 2, "reminder"), notice("Workers:api:errors", 0, "recovery")];
    expect(selectMail(rows, 0, DIGEST_MS)).toEqual([rows[2]]);
    expect(selectMail(rows, DIGEST_MS, DIGEST_MS)).toEqual(rows.slice(0,3));
  });

  it("sends severe business failures and billing risk immediately but not repeated reminders", () => {
    for (const key of ["Service:roast:errors", "account:burn", "Billing:account:daily"]) {
      expect(urgent(notice(key))).toBe(true);
      expect(urgent(notice(key, 2, "reminder"))).toBe(false);
      expect(urgent(notice(key, 1))).toBe(key!=="Service:roast:errors");
    }
  });

  it("retires partially delivered legacy internal mail without acknowledging unrelated customer incidents", () => {
    const state = emptyState();
    const internal = notice("Monitor:collection:health"); internal.delivered = ["one@example.org"]; internal.attempts = 2;
    const customer = notice("Workers:api:errors"); customer.delivered = ["one@example.org"];
    state.outbox = [internal, notice("D1:db:read"), customer];
    expect(discardInternalMail(state)).toBe(2);
    expect(state.outbox).toEqual([customer]);
    expect(state.mailReceipts).toEqual([]);
    expect(discardInternalMail(state)).toBe(0);
  });
});

it("anchors daily reports at 09:00 UTC+8 across UTC date boundaries",()=>{
 const due=Date.UTC(2026,9,22,1);
 expect(dailySlot(due)).toBe(due);expect(dailySlot(due-1)).toBe(due-86400_000);
 expect(dailySlot(due+23*3600_000)).toBe(due);
});
