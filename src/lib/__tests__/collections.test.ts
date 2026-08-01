import { describe, expect, it } from "vitest";
import {
  getCollection,
  getCollectionSlugs,
  listCollections,
  pickText,
} from "../collections";

const TIERS = ["夯", "顶级", "人上人", "NPC", "拉完了"];

describe("collections content", () => {
  it("ships at least one collection", () => {
    expect(getCollectionSlugs().length).toBeGreaterThan(0);
  });

  it("every shipped collection is well-formed", () => {
    for (const slug of getCollectionSlugs()) {
      const c = getCollection(slug);
      expect(c, slug).not.toBeNull();
      if (!c) continue;
      expect(["projects", "developers", "mixed"], `${slug}: type`).toContain(c.type);
      expect(c.title.zh, `${slug}: title.zh`).toBeTruthy();
      expect(c.title.en, `${slug}: title.en`).toBeTruthy();
      expect(c.intro.zh, `${slug}: intro.zh`).toBeTruthy();
      expect(c.intro.en, `${slug}: intro.en`).toBeTruthy();
      expect(c.publishedAt, `${slug}: publishedAt`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.items.length, `${slug}: items`).toBeGreaterThan(0);
      for (const item of c.items) {
        const label = `${slug}/${item.id}`;
        expect(["repo", "developer"], `${label}: kind`).toContain(item.kind);
        expect(item.blurb.zh, `${label}: blurb.zh`).toBeTruthy();
        expect(item.blurb.en, `${label}: blurb.en`).toBeTruthy();
        if (item.kind === "repo") {
          // Repo ids must be "owner/name" — the card builds the on-site route from it.
          expect(item.id, `${label}: repo id`).toMatch(/^[^/\s]+\/[^/\s]+$/);
          expect(item.mock.stars, `${label}: stars`).toBeGreaterThan(0);
          for (const contributor of item.mock.contributors ?? []) {
            expect(TIERS, `${label}: contributor tier`).toContain(contributor.tier);
          }
        } else {
          expect(item.id, `${label}: username`).toMatch(/^[A-Za-z0-9-]+$/);
          expect(TIERS, `${label}: tier`).toContain(item.mock.tier);
          expect(item.mock.score, `${label}: score`).toBeGreaterThan(0);
          expect(item.mock.score, `${label}: score`).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it("rejects slugs that could escape the content dir", () => {
    expect(getCollection("../secrets")).toBeNull();
    expect(getCollection("No_Caps")).toBeNull();
    expect(getCollection("nope.json")).toBeNull();
  });

  it("lists collections newest first", () => {
    const dates = listCollections().map((c) => c.publishedAt);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("serves zh copy to zh and en copy to every other locale", () => {
    const text = { zh: "中文", en: "English" };
    expect(pickText(text, "zh")).toBe("中文");
    for (const locale of ["en", "ja", "ko", "es", "pt", "id", "vi", "ar"]) {
      expect(pickText(text, locale)).toBe("English");
    }
  });
});
