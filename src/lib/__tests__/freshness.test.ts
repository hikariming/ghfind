import { describe, expect, it } from "vitest";
import { RESCAN_COOLDOWN_MS, ROAST_FRESH_MS } from "@/lib/freshness";

describe("freshness constants", () => {
  it("keeps roast handoff freshness at 48h and manual rescan cooldown at 24h", () => {
    expect(ROAST_FRESH_MS).toBe(48 * 60 * 60 * 1000);
    expect(RESCAN_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
    expect(RESCAN_COOLDOWN_MS).toBeLessThan(ROAST_FRESH_MS);
  });
});
