import { attachCoverUrls } from "@/lib/discover/covers";
import { cardFromAssessment, dedupeCards } from "@/lib/discover/map";
import type { DiscoverCard } from "@/lib/discover/types";
import { listProjectBoard, type ProjectBoard } from "@/lib/project-analysis-db";

const PREVIEW_LIMIT = 24;

export async function loadDiscoverPage(locale: string): Promise<{
  cards: DiscoverCard[];
  board: ProjectBoard;
  /** Next offset into `board` only. Null means that board is exhausted. Earlier boards are not counted. */
  nextOffset: number | null;
  databaseError: boolean;
}> {
  let databaseError = false;
  let cards: DiscoverCard[] = [];
  let board: ProjectBoard = "treasure";
  let nextOffset: number | null = null;
  for (const candidate of ["treasure", "classic", "all"] as const) {
    board = candidate;
    try {
      const entries = await listProjectBoard(candidate, { limit: PREVIEW_LIMIT, offset: 0 });
      cards = dedupeCards(cards, entries.map((entry) => cardFromAssessment(entry, locale)));
      nextOffset = entries.length < PREVIEW_LIMIT ? null : entries.length;
    } catch (error) {
      console.error("discover.load_failed", error);
      databaseError = true;
      nextOffset = null;
    }
    if (cards.length >= 8 || candidate === "all") break;
  }
  return { cards: await attachCoverUrls(cards), board, nextOffset, databaseError };
}
