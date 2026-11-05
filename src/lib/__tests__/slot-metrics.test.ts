import { describe, expect, it } from "vitest";
import { beijingDay, countSlotHits, MAX_SLOT_EVENTS, parseSlotHits, parseSlotRef, slotAttrs } from "../slot-metrics";

describe("slot refs", () => {
  it("round-trips slotAttrs through parseSlotRef", () => {
    const attrs = slotAttrs("sponsor", "seed-sponsor-lobehub", "top_strip");
    expect(parseSlotRef(attrs["data-track-slot"])).toEqual({ kind: "sponsor", id: "seed-sponsor-lobehub", placement: "top_strip" });
  });

  it("rejects unknown kinds, placements, malformed ids and unlisted static slots", () => {
    for (const value of ["banner|x|top_strip", "sponsor|x|sidebar", "sponsor|../x|home_row", "sponsor||home_row", "static|nope|model_credit", "job|a|home_hiring|extra", "", null]) {
      expect(parseSlotRef(value)).toBeNull();
    }
    expect(parseSlotRef("static|minicpm|model_credit")).not.toBeNull();
  });
});

describe("parseSlotHits", () => {
  it("accepts a well-formed batch", () => {
    expect(parseSlotHits({ e: [["click", "job|modaleap-agent-engineer|home_hiring"]] })).toEqual([
      { event: "click", kind: "job", id: "modaleap-agent-engineer", placement: "home_hiring" },
    ]);
  });

  it("rejects the whole batch on any bad entry, empty or oversized batches", () => {
    expect(parseSlotHits({ e: [["click", "job|a|home_hiring"], ["hover", "job|a|home_hiring"]] })).toBeNull();
    expect(parseSlotHits({ e: [] })).toBeNull();
    expect(parseSlotHits({ e: Array.from({ length: MAX_SLOT_EVENTS + 1 }, () => ["click", "job|a|home_hiring"]) })).toBeNull();
    expect(parseSlotHits(null)).toBeNull();
    expect(parseSlotHits({ e: "x" })).toBeNull();
  });
});

describe("countSlotHits", () => {
  it("collapses hits into one counter per slot", () => {
    const hits = parseSlotHits({
      e: [
        ["impression", "sponsor|a|home_row"],
        ["impression", "sponsor|a|home_row"],
        ["click", "sponsor|a|home_row"],
        ["impression", "sponsor|a|sponsor_page"],
      ],
    })!;
    expect(countSlotHits(hits)).toEqual([
      { kind: "sponsor", id: "a", placement: "home_row", impressions: 2, clicks: 1 },
      { kind: "sponsor", id: "a", placement: "sponsor_page", impressions: 1, clicks: 0 },
    ]);
  });
});

describe("beijingDay", () => {
  it("rolls over at Beijing midnight, not UTC midnight", () => {
    expect(beijingDay(Date.UTC(2026, 10, 5, 15, 59))).toBe("2026-11-05");
    expect(beijingDay(Date.UTC(2026, 10, 5, 16, 0))).toBe("2026-11-06");
  });
});
