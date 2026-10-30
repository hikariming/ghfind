import { describe, expect, it } from "vitest";
import {
  affinityScore,
  applySignal,
  heatThreshold,
  diversify,
  freshness,
  rankStream,
  relatedItems,
  topInterests,
} from "../rank";
import { seedStreamItems } from "../seed";
import type { StreamAffinity, StreamItem, StreamKind } from "../types";

const NOW = Date.parse("2026-10-25T00:00:00Z");
const EMPTY: StreamAffinity = { kinds: {}, tags: {} };

function make(id: string, kind: StreamKind, extra: Partial<StreamItem> = {}): StreamItem {
  const quality = extra.quality ?? 0.7;
  return {
    id,
    kind,
    title: id,
    summary: "",
    body: null,
    author: { id: `a-${id}`, name: id, avatarUrl: null, handle: null },
    coverUrl: null,
    tags: [],
    score: null,
    scoreLabel: null,
    stats: [],
    href: "#",
    external: false,
    publishedAt: new Date(NOW).toISOString(),
    readingMinutes: null,
    sponsored: false,
    quality,
    heat: 0.3,
    counter: null,
    badge: null,
    comments: null,
    extra: null,
    ...extra,
  };
}

const ctx = (overrides: Partial<Parameters<typeof rankStream>[1]> = {}) => ({
  affinity: EMPTY,
  hidden: new Set<string>(),
  now: NOW,
  seed: "0",
  ...overrides,
});

describe("stream ranking", () => {
  it("is deterministic for the same inputs and reshuffles with the seed", () => {
    const items = seedStreamItems("en", NOW);
    const a = rankStream(items, ctx()).map((item) => item.id);
    const b = rankStream(items, ctx()).map((item) => item.id);
    expect(a).toEqual(b);
    const seeds = ["1", "2", "3", "4"].map((seed) => rankStream(items, ctx({ seed })).map((item) => item.id).join());
    expect(new Set([a.join(), ...seeds]).size).toBeGreaterThan(1);
  });

  it("decays freshness by half every 21 days", () => {
    expect(freshness(new Date(NOW).toISOString(), NOW)).toBeCloseTo(1);
    expect(freshness(new Date(NOW - 21 * 86_400_000).toISOString(), NOW)).toBeCloseTo(0.5);
  });

  it("drops hidden items", () => {
    const items = [make("a", "project"), make("b", "article")];
    expect(rankStream(items, ctx({ hidden: new Set(["a"]) })).map((item) => item.id)).toEqual(["b"]);
  });

  it("never puts three of a kind in a row while other kinds remain", () => {
    const sorted = [
      make("p1", "project"), make("p2", "project"), make("p3", "project"),
      make("p4", "project"), make("d1", "developer"), make("a1", "article"),
    ];
    const kinds = diversify(sorted).map((item) => item.kind);
    for (let i = 2; i < 5; i++) {
      expect(kinds[i] === kinds[i - 1] && kinds[i] === kinds[i - 2]).toBe(false);
    }
  });

  it("keeps sponsored items off the first slots and spaced apart", () => {
    const sorted = [
      make("j1", "job", { sponsored: true }), make("j2", "job", { sponsored: true }),
      ...["project", "developer", "article", "talent", "collection", "project", "developer", "article"].map((kind, i) => make(`x${i}`, kind as StreamKind)),
    ];
    const positions = diversify(sorted).flatMap((item, index) => (item.sponsored ? [index] : []));
    expect(positions[0]).toBeGreaterThanOrEqual(3);
    expect(positions[1] - positions[0]).toBeGreaterThanOrEqual(6);
  });

  it("learns from likes and lifts liked kinds and tags", () => {
    const liked = make("liked", "talent", { tags: ["Rust"] });
    let affinity = EMPTY;
    for (let i = 0; i < 3; i++) affinity = applySignal(affinity, liked, "like");
    expect(affinityScore(make("t", "talent"), affinity)).toBeGreaterThan(0.5);
    expect(affinityScore(make("p", "project", { tags: ["rust"] }), affinity)).toBeGreaterThan(0);
    expect(topInterests(affinity)).toEqual(["rust"]);

    const items = [make("p", "project", { quality: 0.8 }), make("t", "talent", { quality: 0.6 })];
    expect(rankStream(items, ctx()).map((item) => item.id)[0]).toBe("p");
    expect(rankStream(items, ctx({ affinity })).map((item) => item.id)[0]).toBe("t");
  });

  it("pushes a kind down after 'not interested'", () => {
    const affinity = applySignal(EMPTY, make("j", "job"), "hide");
    expect(affinityScore(make("j2", "job"), affinity)).toBeLessThan(0);
  });

  it("sinks already-seen items on refresh", () => {
    const items = [make("a", "project", { quality: 0.8 }), make("b", "article", { quality: 0.75 })];
    expect(rankStream(items, ctx()).map((item) => item.id)[0]).toBe("a");
    expect(rankStream(items, ctx({ seen: new Set(["a"]) })).map((item) => item.id)[0]).toBe("b");
  });

  it("finds related items by shared tags first", () => {
    const target = make("t", "project", { tags: ["agent"] });
    const related = relatedItems(target, [target, make("x", "project"), make("y", "article", { tags: ["Agent"] })]);
    expect(related.map((item) => item.id)).toEqual(["y", "x"]);
  });

  it("treats undated items as neutral, never as new", () => {
    expect(freshness(null, NOW)).toBe(0.3);
  });

  it("lifts hotter items when everything else is equal", () => {
    const items = [make("cold", "project", { heat: 0 }), make("hot", "article", { heat: 1 })];
    expect(rankStream(items, ctx()).map((item) => item.id)[0]).toBe("hot");
  });

  it("marks only the real top slice as hot", () => {
    expect(heatThreshold([0.1, 0.2, 0.3])).toBe(Infinity);
    expect(heatThreshold([0.9, 0.5, 0.4, 0.3, 0.2, 0.1, 0.1, 0.1])).toBe(0.5);
  });
});
