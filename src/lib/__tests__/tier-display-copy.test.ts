import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TIER_EN, TIER_LABEL_EN, TIER_ZH } from "../badge";
import { tierFor } from "../score-presentation";
import { TIER_STYLES, tierStyle } from "../tier";
import { V13_SNARK_BANNED_EN, V13_SNARK_BANNED_ZH } from "../roast-v13/voice";
import { BANNED_REALM_DISPLAY_TERMS, REALM_DEFS } from "../realm";

/** Derogatory / mocking / obsolete display strings that must not appear in tier *display* copy. */
const BANNED_TIER_DISPLAY = [
  "拉完了",
  "TRASH",
  "Trash",
  "trash",
  "終わってる",
  "나락",
  "低价值",
  "Low-value",
  "Likely farmed",
  "疑似刷量",
  "AI 机器人",
  "💩",
  // obsolete NPC display (stored key remains "NPC")
  "普通账号",
  "特征平庸",
  "平庸存疑",
  "平庸",
  "Average · Unremarkable",
  "Unremarkable",
  "量産型",
  "特筆事項なし",
  "평범한 계정",
  "존재감 없음",
  "Promedio · Nada memorable",
  "Mediano · Sem destaque",
  "Rata-rata · Biasa saja",
  "Trung bình · Không có gì nổi bật",
  "عادي · لا شيء يلفت",
  "探索者",
  "成长中",
  "Rising",
  "RISING",
  "🧭",
  "🫥",
  "📈",
];

function assertClean(label: string, text: string) {
  for (const banned of BANNED_TIER_DISPLAY) {
    expect(text, `${label} must not contain ${JSON.stringify(banned)}`).not.toContain(banned);
  }
}

describe("lowest-tier display copy (newbie village)", () => {
  it("maps the stored 拉完了 key to bridged realm display words", () => {
    expect(TIER_ZH["拉完了"]).toBe("练气");
    assertClean("TIER_ZH", TIER_ZH["拉完了"]);
    assertClean("TIER_EN", TIER_EN["拉完了"]);
    assertClean("TIER_LABEL_EN", TIER_LABEL_EN["拉完了"]);
  });

  it("keeps score→tier key stable while soft-labelling the blurb", () => {
    const low = tierFor(12);
    expect(low.tier).toBe("拉完了"); // stored/canonical key unchanged
    assertClean("tierFor.blurb", low.tier_label);
    // emoji retired from display; style still exists for legacy callers
    expect(tierStyle("拉完了").hex).toBeTruthy();
    assertClean("TIER_STYLES.blurb", TIER_STYLES["拉完了"].blurb);
  });

  it("uses friendly trash.name/blurb in every locale messages file", () => {
    const dir = join(__dirname, "../../messages");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        tiers: { trash: { name: string; blurb: string } };
      };
      const { name, blurb } = data.tiers.trash;
      assertClean(`${file} tiers.trash.name`, name);
      assertClean(`${file} tiers.trash.blurb`, blurb);
      expect(name.length).toBeGreaterThan(0);
      expect(blurb.length).toBeGreaterThan(0);
    }
  });

  it("bans old derogatory tier labels from roast output lexicons", () => {
    expect(V13_SNARK_BANNED_ZH).toEqual(
      expect.arrayContaining(["拉完了", "NPC", "存疑", "低价值", "普通账号", "平庸"]),
    );
    expect(V13_SNARK_BANNED_EN.map((s) => s.toLowerCase())).toEqual(
      expect.arrayContaining(["low-value", "likely farmed", "unremarkable", "mediocre", "npc"]),
    );
  });
});

describe("realm display copy", () => {
  it("exposes eight realms and bans legacy tier names in messages", () => {
    expect(REALM_DEFS).toHaveLength(8);
    const dir = join(__dirname, "../../messages");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        realms: Record<string, { name: string; blurb: string }>;
        tiers: Record<string, { name: string; blurb: string }>;
      };
      expect(Object.keys(data.realms).sort()).toEqual(
        REALM_DEFS.map((r) => r.id).sort(),
      );
      for (const [id, row] of Object.entries(data.realms)) {
        for (const banned of BANNED_REALM_DISPLAY_TERMS) {
          // Allow English realm names that legitimately contain none of these.
          expect(row.name, `${file} realms.${id}.name`).not.toContain(banned);
          expect(row.blurb, `${file} realms.${id}.blurb`).not.toContain(banned);
        }
        expect(row.name).not.toMatch(/者$/);
      }
      // Bridged tiers.* must also be clean of banned old words (they now alias realms)
      for (const [id, row] of Object.entries(data.tiers ?? {})) {
        for (const banned of ["拉完了", "新手村", "学徒", "探索者", "普通账号", "💩"]) {
          expect(row.name, `${file} tiers.${id}.name`).not.toContain(banned);
        }
      }
    }
  });
});
