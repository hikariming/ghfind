import { describe, expect, it } from "vitest";
import {
  BANNED_REALM_DISPLAY_TERMS,
  adventurerLevel,
  formatAdventurerLevel,
  nextRealm,
  realmForScore,
  remapRoastHeaderLine,
} from "../realm";

describe("adventurerLevel", () => {
  it("clamps floor(score) into 1..100", () => {
    expect(adventurerLevel(97.9)).toBe(97);
    expect(adventurerLevel(0.4)).toBe(1);
    expect(adventurerLevel(100)).toBe(100);
    expect(adventurerLevel(0)).toBe(1);
    expect(adventurerLevel(-3)).toBe(1);
  });
});

describe("realmForScore boundaries", () => {
  it("maps inclusive mins correctly", () => {
    expect(realmForScore(0).id).toBe("qi");
    expect(realmForScore(29.99).id).toBe("qi");
    expect(realmForScore(30).id).toBe("foundation");
    expect(realmForScore(40).id).toBe("goldenCore");
    expect(realmForScore(42.7).id).toBe("goldenCore");
    expect(realmForScore(50).id).toBe("nascentSoul");
    expect(realmForScore(60).id).toBe("deity");
    expect(realmForScore(70).id).toBe("voidRefining");
    expect(realmForScore(80).id).toBe("integration");
    expect(realmForScore(90).id).toBe("mahayana");
    expect(realmForScore(100).id).toBe("mahayana");
  });
});

describe("nextRealm", () => {
  it("returns the next threshold or null at top", () => {
    expect(nextRealm(25)?.realm.id).toBe("foundation");
    expect(nextRealm(25)?.threshold).toBe(30);
    expect(nextRealm(95)).toBeNull();
  });
});

describe("remapRoastHeaderLine", () => {
  it("rewrites the H2 score/tier header to Lv + realm", () => {
    const md = "## AsperforMias — 82.90/100 · 顶级\n\n**小总评** hello";
    const out = remapRoastHeaderLine(md, 82.9, "合体");
    expect(out).toContain("Lv.82 · 合体");
    expect(out).not.toContain("/100");
    expect(out).not.toContain("顶级");
    expect(out).toContain("**小总评** hello");
  });
});

describe("formatAdventurerLevel", () => {
  it("prefixes Lv.", () => {
    expect(formatAdventurerLevel(82.9)).toBe("Lv.82");
  });
});

describe("banned legacy display terms", () => {
  it("lists old tier display words", () => {
    expect(BANNED_REALM_DISPLAY_TERMS).toEqual(
      expect.arrayContaining(["拉完了", "新手村", "学徒", "顶级", "夯", "NPC", "探索者"]),
    );
  });
});
