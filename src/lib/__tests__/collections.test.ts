import { describe, expect, it } from "vitest";
import {
  collectionAlternates,
  getCollection,
  getCollectionArticle,
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
      // A collection must have something to render: an article body, a card
      // list, or at least a feature subject.
      expect(
        c.bodyLocales.length + c.items.length + (c.subject ? 1 : 0),
        `${slug}: empty collection`,
      ).toBeGreaterThan(0);
      for (const l of c.bodyLocales) {
        expect(["zh", "en"], `${slug}: body locale ${l}`).toContain(l);
      }
      if (c.subject) {
        expect(["repo", "developer"], `${slug}: subject.kind`).toContain(c.subject.kind);
        if (c.subject.kind === "repo") {
          expect(c.subject.id, `${slug}: subject id`).toMatch(/^[^/\s]+\/[^/\s]+$/);
        } else {
          expect(c.subject.id, `${slug}: subject id`).toMatch(/^[A-Za-z0-9-]+$/);
        }
      }
      for (const item of c.items) {
        const label = `${slug}/${item.id}`;
        expect(["repo", "developer"], `${label}: kind`).toContain(item.kind);
        expect(item.blurb.zh, `${label}: blurb.zh`).toBeTruthy();
        expect(item.blurb.en, `${label}: blurb.en`).toBeTruthy();
        if (item.kind === "repo") {
          expect(item.id, `${label}: repo id`).toMatch(/^[^/\s]+\/[^/\s]+$/);
          expect(item.stats.stars, `${label}: stars`).toBeGreaterThan(0);
          for (const contributor of item.stats.contributors ?? []) {
            expect(TIERS, `${label}: contributor tier`).toContain(contributor.tier);
          }
        } else {
          expect(item.id, `${label}: username`).toMatch(/^[A-Za-z0-9-]+$/);
          expect(TIERS, `${label}: tier`).toContain(item.stats.tier);
          expect(item.stats.score, `${label}: score`).toBeGreaterThan(0);
          expect(item.stats.score, `${label}: score`).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it("serves article bodies with locale fallback (requested → en → zh)", () => {
    for (const slug of getCollectionSlugs()) {
      const c = getCollection(slug);
      if (!c || c.bodyLocales.length === 0) continue;
      for (const locale of ["zh", "en", "ja", "ar"]) {
        const article = getCollectionArticle(slug, locale);
        expect(article, `${slug}: article for ${locale}`).not.toBeNull();
        if (!article) continue;
        expect(c.bodyLocales, `${slug}: served locale`).toContain(article.bodyLocale);
        if (c.bodyLocales.includes(locale)) {
          expect(article.bodyLocale, `${slug}: exact locale`).toBe(locale);
        }
        expect(article.body.length, `${slug}: body`).toBeGreaterThan(0);
        expect(article.readingMinutes, `${slug}: reading time`).toBeGreaterThan(0);
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

  it("canonicalizes body-less locales onto a real body locale", () => {
    // zh-only article: every other locale canonicalizes onto the zh URL and
    // hreflang lists only zh.
    const zhOnly = collectionAlternates("ja", "some-slug", ["zh"]);
    expect(zhOnly.canonical).toBe("/collections/some-slug");
    expect(Object.keys(zhOnly.languages)).toEqual(["zh-CN", "x-default"]);
    // No body at all (meta.json is fully bilingual): zh+en pair as usual.
    const noBody = collectionAlternates("ja", "some-slug", []);
    expect(noBody.canonical).toBe("/en/collections/some-slug");
  });
});
