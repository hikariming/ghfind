import { describe, expect, it } from "vitest";
import {
  readExplorationHistory,
  recordExplorationItem,
  visibleExplorationItems,
  type ExplorationItem,
  type StorageLike,
} from "../exploration-history";

function memoryStorage(initial: string | null = null): StorageLike & { value: string | null } {
  return {
    value: initial,
    getItem() {
      return this.value;
    },
    setItem(_key, value) {
      this.value = value;
    },
  };
}

const item = (key: string, href = `/u/${key}`): ExplorationItem => ({
  kind: "developer",
  key,
  title: `@${key}`,
  href,
  visitedAt: 1,
});

describe("exploration history", () => {
  it("deduplicates most-recent-first and caps history at 12", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 14; index += 1) {
      recordExplorationItem(item(`dev-${index}`), storage, index);
    }
    recordExplorationItem(item("dev-5"), storage, 99);

    const history = readExplorationHistory(storage);
    expect(history).toHaveLength(12);
    expect(history[0]).toMatchObject({ key: "dev-5", visitedAt: 99 });
    expect(new Set(history.map((entry) => entry.key)).size).toBe(12);
  });

  it("returns an empty history for malformed JSON", () => {
    expect(readExplorationHistory(memoryStorage("not-json"))).toEqual([]);
  });

  it("fails closed when storage access throws", () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readExplorationHistory(storage)).toEqual([]);
    expect(() => recordExplorationItem(item("safe"), storage)).not.toThrow();
  });

  it("stores canonical paths without query strings or fragments", () => {
    const storage = memoryStorage();
    recordExplorationItem(item("octo", "/u/octo?roasting=1#report"), storage);
    expect(readExplorationHistory(storage)[0]?.href).toBe("/u/octo");
  });

  it("filters the current page and applies the visible limit", () => {
    expect(
      visibleExplorationItems(
        [item("a"), item("b"), item("c")],
        "/u/b?from=home",
        2,
      ).map((entry) => entry.key),
    ).toEqual(["a", "c"]);
  });
});
