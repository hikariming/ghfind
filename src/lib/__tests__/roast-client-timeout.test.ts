import { describe, expect, it, vi } from "vitest";
import {
  ROAST_CLIENT_TIMEOUT_MS,
  isRoastClientTimeout,
  roastClientSignal,
} from "../roast-client-timeout";

/** Mirrors V13_ATTACH_BUDGET_MS without pulling Next via roast-handler. */
const ATTACH_BUDGET_MS = 100_000;

describe("roastClientTimeout", () => {
  it("exposes a client deadline under the Worker LLM ceiling with room after attach", () => {
    expect(ROAST_CLIENT_TIMEOUT_MS).toBeLessThanOrEqual(220_000);
    expect(ROAST_CLIENT_TIMEOUT_MS).toBeGreaterThan(ATTACH_BUDGET_MS + 60_000);
  });

  it("detects AbortError and TimeoutError", () => {
    expect(isRoastClientTimeout(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(
      true,
    );
    expect(isRoastClientTimeout(Object.assign(new Error("timeout"), { name: "TimeoutError" }))).toBe(
      true,
    );
    expect(isRoastClientTimeout(new Error("network"))).toBe(false);
    expect(isRoastClientTimeout(null)).toBe(false);
  });

  it("builds an AbortSignal.timeout for the roast fetch", () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const signal = roastClientSignal(12_345);
    expect(spy).toHaveBeenCalledWith(12_345);
    expect(signal).toBeInstanceOf(AbortSignal);
    spy.mockRestore();
  });
});
