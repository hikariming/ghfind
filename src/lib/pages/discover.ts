import { cardFromAssessment, dedupeCards } from "@/lib/discover/map";
import type { DiscoverCard } from "@/lib/discover/types";
import { listProjectBoard, type ProjectBoard } from "@/lib/project-analysis-db";

const PREVIEW_LIMIT = 24;

export async function loadDiscoverPage(locale: string): Promise<{
  cards: DiscoverCard[];
  board: ProjectBoard;
  databaseError: boolean;
}> {
  let databaseError = false;
  let cards: DiscoverCard[] = [];
  let board: ProjectBoard = "treasure";
  for (const candidate of ["treasure", "classic", "all"] as const) {
    board = candidate;
    try {
      const entries = await listProjectBoard(candidate, { limit: PREVIEW_LIMIT, offset: 0 });
      cards = dedupeCards(cards, entries.map((entry) => cardFromAssessment(entry, locale)));
    } catch (error) {
      console.error("discover.load_failed", error);
      databaseError = true;
    }
    if (cards.length >= 8) break;
  }
  return { cards, board, databaseError };
}
