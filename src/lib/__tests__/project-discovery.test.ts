import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectListItem, RelatedProject } from "@/lib/db";
import {
  getProjects,
  getRelatedProjects,
  getRepoLanguage,
} from "@/lib/db";
import { setCachedProjectValue } from "@/lib/redis";
import {
  createCachedLoader,
  getRelatedProjectsCached,
  projectListCacheKey,
  relatedProjectsCacheKey,
} from "../project-discovery";

const store = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/lib/db", () => ({
  getDeveloperCommonProjects: vi.fn(async () => []),
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

const item = (key: string) => ({ repo: { repo_key: key } }) as unknown as ProjectListItem;
const related = (key: string, sharedContributorCount: number): RelatedProject =>
  ({ project: item(key), sharedContributorCount }) as unknown as RelatedProject;

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
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
    });
    await emptyLoad("empty");
    expect(cacheSet).toHaveBeenCalledWith("empty", []);
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

  it("caches empty related results so repeat visits skip the database", async () => {
    vi.mocked(getRelatedProjects).mockResolvedValue([]);
    vi.mocked(getRepoLanguage).mockResolvedValue(null);

    await expect(getRelatedProjectsCached("b/lonely", 6)).resolves.toEqual([]);
    expect(setCachedProjectValue).toHaveBeenCalledWith("projects:related:b/lonely:6", []);

    await expect(getRelatedProjectsCached("b/lonely", 6)).resolves.toEqual([]);
    expect(getRelatedProjects).toHaveBeenCalledOnce();
  });
});
