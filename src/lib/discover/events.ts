import type { DiscoverAction, DiscoverCard } from "./types";

/** v1 swipe mapping: existing Feed state/events only. Ranking formulas unchanged. */
export type FeedWrite =
  | { kind: "state"; saved: boolean; impressionToken: string; repoKey: string }
  | { kind: "event"; type: "impression"; impressionToken: string; repoKey: string; eventId: string };

export function mapSwipeAction(
  card: DiscoverCard,
  action: DiscoverAction,
  eventId: string,
  visibleMs = 0,
): FeedWrite[] {
  if (!card.impressionToken || card.source !== "feed") return [];
  if (action === "skip") {
    // Impression only after the card has been the focused item for a full second.
    if (visibleMs < 1000) return [];
    return [{
      kind: "event",
      type: "impression",
      impressionToken: card.impressionToken,
      repoKey: card.repoKey,
      eventId,
    }];
  }
  // like and super-like both save. Super-like is local chrome only in v1.
  return [{
    kind: "state",
    saved: true,
    impressionToken: card.impressionToken,
    repoKey: card.repoKey,
  }];
}

export function mapUndo(card: DiscoverCard, action: DiscoverAction): FeedWrite[] {
  if (!card.impressionToken || card.source !== "feed") return [];
  if (action === "skip") return [];
  return [{
    kind: "state",
    saved: false,
    impressionToken: card.impressionToken,
    repoKey: card.repoKey,
  }];
}

export function reportHref(card: DiscoverCard): string | null {
  return card.analysisId ? `/projects/analyses/${card.analysisId}` : null;
}
