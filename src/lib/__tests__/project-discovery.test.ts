import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectListItem, RelatedProject } from "@/lib/db";
import {
  getProfileCommonProjects,
  getProjects,
  getRelatedProjects,
  getRepoLanguage,
} from "@/lib/db";
import { isBotRequest } from "@/lib/bot-user-agent";
import { setCachedProjectValue } from "@/lib/redis";
import {
  createCachedLoader,
  getProfileCommonProjectsCached,
  getRelatedProjectsCached,
  projectListCacheKey,
  relatedProjectsCacheKey,
} from "../project-discovery";

const store = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/lib/db", () => ({
  getProfileCommonProjects: vi.fn(async () => []),
  getProjects: vi.fn(async () => []),
  getRelatedProjects: vi.fn(async () => []),
  getRepoLanguage: vi.fn(async () => null),
}));

vi.mock("@/lib/redis", () => ({
  getCachedProjectValue: vi.fn(async (key: string) => store.get(key) ?? null),
  setCachedProjectValue: vi.fn(async (key: string, value: unknown) => {
    store.set(key, value);
  }),
}));

vi.mock("@/lib/bot-user-agent", () => ({ isBotRequest: vi.fn(() => false) }));

const item = (key: string) => ({ repo: { repo_key: key } }) as unknown as ProjectListItem;
const related = (key: string, sharedContributorCount: number): RelatedProject =>
  ({ project: item(key), sharedContributorCount }) as unknown as RelatedProject;

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("project discovery cache", () => {
  it("builds deterministic cache keys", () => {
    expect(projectListCacheKey({ sort: "quality", language: null, limit: 24, offset: 0 })).toBe(
      "projects:list:quality:all:24:0",
    );
    expect(
      projectListCacheKey({ sort: "momentum", language: "TypeScript", limit: 12, offset: 24 }),
    ).toBe("projects:list:momentum:typescript:12:24");
    expect(relatedProjectsCacheKey("OpenAI/SDK", 6)).toBe("projects:related:openai/sdk:6");
  });

  it("falls back to the database loader when cache reads fail", async () => {
    const dbLoad = vi.fn(async () => ["fresh"]);
    const cacheSet = vi.fn(async () => undefined);
    const load = createCachedLoader<string[]>({
      cacheGet: async () => {
        throw new Error("redis unavailable");
      },
      cacheSet,
      dbLoad,
      fallback: [],
    });

    await expect(load("key")).resolves.toEqual(["fresh"]);
    expect(dbLoad).toHaveBeenCalledOnce();
    expect(cacheSet).toHaveBeenCalledWith("key", ["fresh"]);
  });

  it("single-flights concurrent misses and caches empty results", async () => {
    let release!: (value: string[]) => void;
    const dbLoad = vi.fn(() => new Promise<string[]>((resolve) => (release = resolve)));
    const cacheSet = vi.fn(async () => undefined);
    const load = createCachedLoader<string[]>({
      cacheGet: async () => null,
      cacheSet,
      dbLoad,
      fallback: [],
    });

    const first = load("same");
    const second = load("same");
    await vi.waitFor(() => expect(dbLoad).toHaveBeenCalledOnce());
    release(["one"]);
    await expect(Promise.all([first, second])).resolves.toEqual([["one"], ["one"]]);
    expect(dbLoad).toHaveBeenCalledOnce();

    // "No results" is the common case on profile pages; skipping the cache
    // write here sent every crawler hit straight to the database.
    const emptyLoad = createCachedLoader<string[]>({
      cacheGet: async () => null,
      cacheSet,
      dbLoad: async () => [],
      fallback: [],
    });
    await emptyLoad("empty");
    expect(cacheSet).toHaveBeenCalledWith("empty", []);
  });

  it("returns the fallback without caching when the database load fails", async () => {
    const cacheSet = vi.fn(async () => undefined);
    const dbLoad = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error("turso unreachable"))
      .mockResolvedValueOnce(["recovered"]);
    const load = createCachedLoader<string[]>({
      cacheGet: async () => null,
      cacheSet,
      dbLoad,
      fallback: ["fallback"],
    });

    // A transient DB error degrades this one read — it must NOT be cached as
    // an empty result for a full TTL (the homepage band vanished for 6h).
    await expect(load("flaky")).resolves.toEqual(["fallback"]);
    expect(cacheSet).not.toHaveBeenCalled();

    // The next read goes back to the database and caches the real value.
    await expect(load("flaky")).resolves.toEqual(["recovered"]);
    expect(cacheSet).toHaveBeenCalledWith("flaky", ["recovered"]);
  });
});

describe("in-isolate cache", () => {
  it("keeps values that fail `persist` out of KV and serves them from the isolate", async () => {
    const cacheSet = vi.fn(async () => undefined);
    const dbLoad = vi.fn(async () => [] as string[]);
    const load = createCachedLoader<string[]>({
      cacheGet: async () => null,
      cacheSet,
      dbLoad,
      fallback: [],
      persist: (value) => value.length > 0,
      localTtlSeconds: 60,
    });
    await expect(load("empty")).resolves.toEqual([]);
    await expect(load("empty")).resolves.toEqual([]);
    expect(dbLoad).toHaveBeenCalledOnce();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("skips KV writes on crawler requests but still caches the answer locally", async () => {
    const cacheSet = vi.fn(async () => undefined);
    const dbLoad = vi.fn(async (key: string) => [key]);
    let bot = true;
    const load = createCachedLoader<string[]>({
      cacheGet: async () => null,
      cacheSet,
      dbLoad,
      fallback: [],
      skipBotWrites: true,
      localTtlSeconds: 60,
      isBot: () => bot,
    });
    await load("crawled");
    await load("crawled");
    expect(dbLoad).toHaveBeenCalledOnce();
    expect(cacheSet).not.toHaveBeenCalled();
    bot = false;
    await load("visited");
    expect(cacheSet).toHaveBeenCalledExactlyOnceWith("visited", ["visited"]);
  });

  it("does not write KV for empty results, and a second isolate reloads from the database", async () => {
    // Cache API match-miss is a zone 504, so empty answers stay isolate-local.
    const options = {
      cacheGet: async () => null,
      cacheSet: vi.fn(async () => undefined),
      dbLoad: vi.fn(async () => [] as string[]),
      fallback: [] as string[],
      persist: (value: string[]) => value.length > 0,
      localTtlSeconds: 3600,
    };
    await expect(createCachedLoader<string[]>(options)("shared-empty")).resolves.toEqual([]);
    expect(options.dbLoad).toHaveBeenCalledOnce();
    await expect(createCachedLoader<string[]>(options)("shared-empty")).resolves.toEqual([]);
    expect(options.dbLoad).toHaveBeenCalledTimes(2);
    expect(options.cacheSet).not.toHaveBeenCalled();
  });
});

describe("getProfileCommonProjectsCached", () => {
  it("reads every candidate in one database call and one cache entry", async () => {
    vi.mocked(getProfileCommonProjects).mockResolvedValueOnce([[item("fixture/shared")], [], []]);
    const result = await getProfileCommonProjectsCached("Octocat", ["S1", "s2", "s3"], 6);
    expect(result).toEqual([[item("fixture/shared")], [], []]);
    expect(getProfileCommonProjects).toHaveBeenCalledExactlyOnceWith("Octocat", ["S1", "s2", "s3"], 6);
    expect(setCachedProjectValue).toHaveBeenCalledOnce();
    expect([...store.keys()]).toEqual(["projects:common:v2:octocat:6:s1,s2,s3"]);
    await expect(getProfileCommonProjectsCached("octocat", ["s1", "s2", "s3"], 6)).resolves.toEqual(result);
    expect(getProfileCommonProjects).toHaveBeenCalledOnce();
  });

  it("never writes KV for a profile with nothing in common, yet skips the database on repeats", async () => {
    vi.mocked(getProfileCommonProjects).mockResolvedValue([[], []]);
    await expect(getProfileCommonProjectsCached("lonely", ["a", "b"], 6)).resolves.toEqual([[], []]);
    await expect(getProfileCommonProjectsCached("lonely", ["a", "b"], 6)).resolves.toEqual([[], []]);
    expect(getProfileCommonProjects).toHaveBeenCalledOnce();
    expect(setCachedProjectValue).not.toHaveBeenCalled();
  });

  it("never writes KV on a crawler render", async () => {
    vi.mocked(isBotRequest).mockReturnValue(true);
    vi.mocked(getProfileCommonProjects).mockResolvedValue([[item("fixture/crawled")]]);
    await getProfileCommonProjectsCached("crawled", ["c1"], 6);
    expect(setCachedProjectValue).not.toHaveBeenCalled();
    vi.mocked(isBotRequest).mockReturnValue(false);
  });

  it("does not cache a failed read and allows the next request to recover", async () => {
    vi.mocked(getProfileCommonProjects)
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce([[item("fixture/recovered")]]);
    await expect(getProfileCommonProjectsCached("retry", ["r1"], 6)).resolves.toEqual([[]]);
    expect(store.size).toBe(0);
    await expect(getProfileCommonProjectsCached("retry", ["r1"], 6)).resolves.toEqual([[item("fixture/recovered")]]);
    expect(getProfileCommonProjects).toHaveBeenCalledTimes(2);
  });

  it("does not query without candidates", async () => {
    await expect(getProfileCommonProjectsCached("solo", [], 6)).resolves.toEqual([]);
    expect(getProfileCommonProjects).not.toHaveBeenCalled();
  });
});

describe("getRelatedProjectsCached", () => {
  it("fills short shared lists from the per-language cached project list", async () => {
    vi.mocked(getRelatedProjects).mockResolvedValue([related("x/shared", 2)]);
    vi.mocked(getRepoLanguage).mockResolvedValue("Rust");
    vi.mocked(getProjects).mockResolvedValue([
      item("x/shared"), // already present — must not duplicate
      item("x/y"), // the target repo itself — must be excluded
      item("rust/one"),
      item("rust/two"),
    ]);

    const result = await getRelatedProjectsCached("x/y", 4);

    expect(result.map((r) => [r.project.repo.repo_key, r.sharedContributorCount])).toEqual([
      ["x/shared", 2],
      ["rust/one", 0],
      ["rust/two", 0],
    ]);
    // The filler goes through the language-keyed list loader, so its cost is
    // once per language per TTL — assert it hit that cache namespace.
    expect(getProjects).toHaveBeenCalledWith(
      expect.objectContaining({ sort: "quality", language: "Rust", offset: 0 }),
    );
    expect(store.has("projects:list:quality:rust:12:0")).toBe(true);
    expect(store.get("projects:related:x/y:4")).toEqual(result);
    expect(setCachedProjectValue).toHaveBeenCalledWith("projects:related:x/y:4", result, 86400);
  });

  it("returns shared results as-is when they satisfy the limit", async () => {
    vi.mocked(getRelatedProjects).mockResolvedValue([
      related("a/one", 3),
      related("a/two", 1),
    ]);

    const result = await getRelatedProjectsCached("a/target", 2);

    expect(result.map((r) => r.project.repo.repo_key)).toEqual(["a/one", "a/two"]);
    expect(getRepoLanguage).not.toHaveBeenCalled();
    expect(getProjects).not.toHaveBeenCalled();
  });

  it("keeps empty related results out of KV, yet repeat visits skip the database", async () => {
    vi.mocked(getRelatedProjects).mockResolvedValue([]);
    vi.mocked(getRepoLanguage).mockResolvedValue(null);

    await expect(getRelatedProjectsCached("b/lonely", 6)).resolves.toEqual([]);
    await expect(getRelatedProjectsCached("b/lonely", 6)).resolves.toEqual([]);
    expect(getRelatedProjects).toHaveBeenCalledOnce();
    expect(store.has("projects:related:b/lonely:6")).toBe(false);
  });

  it("keeps filler-only related results out of KV", async () => {
    vi.mocked(getRelatedProjects).mockResolvedValue([]);
    vi.mocked(getRepoLanguage).mockResolvedValue("Go");
    vi.mocked(getProjects).mockResolvedValue([item("go/one"), item("go/two")]);

    const result = await getRelatedProjectsCached("c/filler", 6);
    expect(result.map((r) => r.sharedContributorCount)).toEqual([0, 0]);
    expect(store.has("projects:related:c/filler:6")).toBe(false);
    // The filler itself is the shared per-language list, which stays in KV.
    expect(store.has("projects:list:quality:go:12:0")).toBe(true);
    await getRelatedProjectsCached("c/filler", 6);
    expect(getRelatedProjects).toHaveBeenCalledOnce();
  });

  it("does not write related results to KV on a crawler render", async () => {
    vi.mocked(isBotRequest).mockReturnValue(true);
    vi.mocked(getRelatedProjects).mockResolvedValue([related("d/one", 2)]);
    await getRelatedProjectsCached("d/crawled", 1);
    expect(store.has("projects:related:d/crawled:1")).toBe(false);
    vi.mocked(isBotRequest).mockReturnValue(false);
  });
});
