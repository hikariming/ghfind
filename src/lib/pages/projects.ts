import { countProjectBoard, listProjectBoard, type ProjectBoard } from "@/lib/project-analysis-db";

/** Data for the /projects boards, shared by the Next page and apps/web. */

const PAGE_SIZE = 18;

function parseBoard(value: unknown): ProjectBoard {
  const scalar = Array.isArray(value) ? value[0] : value;
  if (scalar === "classic") return "classic";
  if (scalar === "all") return "all";
  return "treasure";
}

function parsePage(value: unknown): number {
  const scalar = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(String(scalar ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export async function loadProjectsPage(query: { board?: string | string[]; page?: string | string[] }) {
  const board = parseBoard(query.board);
  const page = parsePage(query.page);
  let databaseError = false;
  let entries = [] as Awaited<ReturnType<typeof listProjectBoard>>;
  let total = 0;
  try {
    entries = await listProjectBoard(board, {
      limit: PAGE_SIZE + 1,
      offset: (page - 1) * PAGE_SIZE,
    });
    total = await countProjectBoard(board);
  } catch (error) {
    console.error("projectBoards.load_failed", error);
    databaseError = true;
  }
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Past the last page: the caller redirects (Next's redirect(): 307, unprefixed).
  const redirectTo =
    !databaseError && page > totalPages ? `/projects?board=${board}&page=${totalPages}` : null;
  return {
    redirectTo,
    board,
    currentPage: page,
    totalPages,
    total,
    databaseError,
    hasNext: page < totalPages,
    visibleEntries: entries.slice(0, PAGE_SIZE),
  };
}
