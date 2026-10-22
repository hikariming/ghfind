import { describe, expect, it } from "vitest";
import { mapSwipeAction, mapUndo } from "../events";
import { commandFromKey } from "../keyboard";
import { dedupeCards } from "../map";
import type { DiscoverCard } from "../types";

const feedCard: DiscoverCard = {
  repoKey: "fixture-owner/fixture-repo",
  ownerLogin: "fixture-owner",
  name: "fixture-repo",
  summary: "A compact CLI.",
  hook: "Filters selections with shell commands.",
  audience: null,
  coverUrl: null,
  language: "TypeScript",
  tags: [{ id: "artifact:cli", label: "CLI" }],
  productScore: 81,
  confidence: 70,
  communityStrength: 40,
  canonicalUrl: "https://github.com/fixture-owner/fixture-repo",
  analysisId: "analysis-1",
  impressionToken: "imp-token",
  source: "feed",
  verificationLevel: "built",
};

describe("discover swipe mapping", () => {
  it("maps like and super-like to saved=true and skip to impression only", () => {
    expect(mapSwipeAction(feedCard, "like", "11111111-1111-4111-8111-111111111111")).toEqual([
      { kind: "state", saved: true, impressionToken: "imp-token", repoKey: "fixture-owner/fixture-repo" },
    ]);
    expect(mapSwipeAction(feedCard, "superlike", "11111111-1111-4111-8111-111111111111")).toEqual([
      { kind: "state", saved: true, impressionToken: "imp-token", repoKey: "fixture-owner/fixture-repo" },
    ]);
    expect(mapSwipeAction(feedCard, "skip", "11111111-1111-4111-8111-111111111111", 200)).toEqual([]);
    expect(mapSwipeAction(feedCard, "skip", "11111111-1111-4111-8111-111111111111", 1000)).toEqual([
      {
        kind: "event",
        type: "impression",
        impressionToken: "imp-token",
        repoKey: "fixture-owner/fixture-repo",
        eventId: "11111111-1111-4111-8111-111111111111",
      },
    ]);
  });

  it("undoes a like with saved=false and does not write on skip undo", () => {
    expect(mapUndo(feedCard, "like")).toEqual([
      { kind: "state", saved: false, impressionToken: "imp-token", repoKey: "fixture-owner/fixture-repo" },
    ]);
    expect(mapUndo(feedCard, "skip")).toEqual([]);
  });

  it("does not write Feed state for public cards", () => {
    const pub = { ...feedCard, source: "public" as const, impressionToken: null };
    expect(mapSwipeAction(pub, "like", "11111111-1111-4111-8111-111111111111")).toEqual([]);
  });
});

describe("discover keyboard", () => {
  it("maps arrow keys and backspace", () => {
    expect(commandFromKey("ArrowLeft")).toBe("skip");
    expect(commandFromKey("ArrowRight")).toBe("like");
    expect(commandFromKey("ArrowUp")).toBe("superlike");
    expect(commandFromKey("Backspace")).toBe("undo");
    expect(commandFromKey("a")).toBeNull();
  });
});

describe("discover 410 rebuild", () => {
  it("dedupes rebuilt pages by repoKey", () => {
    const rebuilt = dedupeCards([feedCard], [
      feedCard,
      { ...feedCard, repoKey: "fixture-owner/fixture-other", name: "fixture-other", canonicalUrl: "https://github.com/fixture-owner/fixture-other" },
    ]);
    expect(rebuilt.map((card) => card.repoKey)).toEqual([
      "fixture-owner/fixture-repo",
      "fixture-owner/fixture-other",
    ]);
  });
});
