import { createClient, type InArgs } from "@libsql/client";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1DatabaseLike } from "../d1-client";
import {
  collectionAlternates,
  collectionExists,
  getCollection,
  getCollectionArticle,
  getCollectionSlugs,
  listCollections,
  pickText,
} from "../collections";

const state = vi.hoisted(() => ({ binding: null as D1DatabaseLike | null, fail: false }));
vi.mock("../d1-client", async (original) => ({
  ...(await original<typeof import("../d1-client")>()),
  getD1Binding: () => state.binding,
}));

// The real migration (schema + seed) on in-memory SQLite behind a D1-shaped binding.
const client = createClient({ url: "file::memory:" });
const binding: D1DatabaseLike = {
  prepare(sql) {
    let args: unknown[] = [];
    const prepared = {
      bind(...values: unknown[]) {
        args = values;
        return prepared;
      },
      async all() {
        if (state.fail) throw Error("DB down");
        const result = await client.execute({ sql, args: args as InArgs });
        return { results: result.rows.map((row) => ({ ...row })), meta: {} };
      },
    };
    return prepared;
  },
  batch: (prepared) => Promise.all(prepared.map((statement) => statement.all())),
};

beforeAll(async () => {
  await client.executeMultiple(
    readFileSync(new URL("../../../migrations/0022_collections.sql", import.meta.url), "utf8"),
  );
});
beforeEach(() => {
  state.binding = binding;
  state.fail = false;
});
afterAll(() => client.close());

const TIERS = ["夯", "顶级", "人上人", "NPC", "拉完了"];

describe("collections content", () => {
  it("ships at least one collection", async () => {
    expect((await getCollectionSlugs()).length).toBeGreaterThan(0);
  });

  it("every shipped collection is well-formed", async () => {
    for (const slug of await getCollectionSlugs()) {
      const c = await getCollection(slug);
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
        expect(["zh", "en", "ja", "ko"], `${slug}: body locale ${l}`).toContain(l);
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

  it("serves article bodies with locale fallback (requested → en → zh)", async () => {
    for (const slug of await getCollectionSlugs()) {
      const c = await getCollection(slug);
      if (!c || c.bodyLocales.length === 0) continue;
      for (const locale of ["zh", "en", "ja", "ar"]) {
        const article = await getCollectionArticle(c, locale);
        expect(article, `${slug}: article for ${locale}`).not.toBeNull();
        if (!article) continue;
        expect(c.bodyLocales, `${slug}: served locale`).toContain(article.bodyLocale);
        if (c.bodyLocales.includes(locale)) {
          expect(article.bodyLocale, `${slug}: exact locale`).toBe(locale);
        }
        expect(article.body.length, `${slug}: body`).toBeGreaterThan(0);
        expect(article.readingMinutes, `${slug}: reading time`).toBeGreaterThan(0);
        expect(c.readingMinutes[article.bodyLocale], `${slug}: listed reading time`).toBe(
          article.readingMinutes,
        );
      }
    }
  });

  it("rejects malformed and unknown slugs", async () => {
    expect(await getCollection("../secrets")).toBeNull();
    expect(await getCollection("No_Caps")).toBeNull();
    expect(await getCollection("nope.json")).toBeNull();
    expect(await getCollection("does-not-exist")).toBeNull();
    expect(await collectionExists("does-not-exist")).toBe(false);
    expect(await collectionExists("dify")).toBe(true);
  });

  it("lists collections newest first, ties by slug descending", async () => {
    const list = await listCollections();
    const keys = list.map((c) => `${c.publishedAt} ${c.slug}`);
    expect(keys).toEqual([...keys].sort().reverse());
  });

  it("hides drafts from listing, lookup and the comment check", async () => {
    await client.execute("UPDATE collections SET status = 'draft' WHERE slug = 'dify'");
    try {
      expect(await getCollectionSlugs()).not.toContain("dify");
      expect(await getCollection("dify")).toBeNull();
      expect(await collectionExists("dify")).toBe(false);
    } finally {
      await client.execute("UPDATE collections SET status = 'published' WHERE slug = 'dify'");
    }
  });

  it("throws on D1 failures instead of reporting a missing collection", async () => {
    state.fail = true;
    await expect(listCollections()).rejects.toThrow("DB down");
    await expect(getCollection("dify")).rejects.toThrow("DB down");
    expect(await collectionExists("dify")).toBe(false);
  });

  it("is empty without a D1 binding", async () => {
    state.binding = null;
    expect(await listCollections()).toEqual([]);
    expect(await getCollection("dify")).toBeNull();
  });

  it("serves zh copy to zh and en copy to every other locale", () => {
    const text = { zh: "中文", en: "English" };
    expect(pickText(text, "zh")).toBe("中文");
    for (const locale of ["en", "ja", "ko", "es", "pt", "id", "vi", "ar"]) {
      expect(pickText(text, locale)).toBe("English");
    }
  });

  it("serves ja/ko copy when present and falls back locale → en → zh", () => {
    const text = { zh: "中文", en: "English", ja: "日本語", ko: "한국어" };
    expect(pickText(text, "ja")).toBe("日本語");
    expect(pickText(text, "ko")).toBe("한국어");
    expect(pickText(text, "es")).toBe("English");
    expect(pickText({ zh: "中文", en: "", ja: "日本語" }, "en")).toBe("中文");
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
