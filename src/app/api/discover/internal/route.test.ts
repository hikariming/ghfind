import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as null | { user: { githubId: number; login: string; image: string | null } } }));
const listProjectBoard = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({ auth: async () => session.current }));
vi.mock("@/lib/project-analysis-db", () => ({ listProjectBoard }));
vi.mock("@/lib/discover/covers", () => ({ attachCoverUrls: async <T,>(cards: T[]) => cards }));
vi.mock("@/lib/discover/map", () => ({
  cardFromAssessment: (entry: { repoKey: string; productScore: number; score: number; tryability: number }) => ({
    repoKey: entry.repoKey,
    productScore: entry.productScore,
    coverUrl: null,
    discoverScore: { score: entry.score, band: "must_try", version: "discover-score-v1.1", tryGate: { strangerTryability: entry.tryability } },
  }),
}));

import { GET } from "./route";

// Anonymized account ids and repos.
const INTERNAL_ID = 1001;

function get(query = "") {
  return GET(new Request(`http://localhost/api/discover/internal${query}`));
}

describe("GET /api/discover/internal", () => {
  beforeEach(() => {
    listProjectBoard.mockReset();
    listProjectBoard.mockImplementation(async (_board: string, { offset }: { offset: number }) =>
      offset > 0
        ? []
        : [
            { repoKey: "acme/low", productScore: 90, score: 60, tryability: 90 },
            { repoKey: "acme/tie-hard", productScore: 88, score: 84, tryability: 30 },
            { repoKey: "acme/tie-easy", productScore: 80, score: 84, tryability: 75 },
          ],
    );
    process.env.GHFIND_DISCOVER_SCORE_V1 = "1";
    process.env.GHFIND_DISCOVER_INTERNAL_GITHUB_IDS = String(INTERNAL_ID);
  });
  afterEach(() => {
    session.current = null;
    delete process.env.GHFIND_DISCOVER_SCORE_V1;
    delete process.env.GHFIND_DISCOVER_INTERNAL_GITHUB_IDS;
  });

  it("404s for anonymous callers without touching the database", async () => {
    const response = await get();
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(listProjectBoard).not.toHaveBeenCalled();
  });

  it("404s for signed-in accounts outside the allowlist", async () => {
    session.current = { user: { githubId: 1002, login: "someone", image: null } };
    expect((await get()).status).toBe(404);
  });

  it("404s for allowlisted accounts while the flag is off", async () => {
    delete process.env.GHFIND_DISCOVER_SCORE_V1;
    session.current = { user: { githubId: INTERNAL_ID, login: "internal", image: null } };
    expect((await get()).status).toBe(404);
  });

  it("ranks by discover score with the tryability tie-break, privately", async () => {
    session.current = { user: { githubId: INTERNAL_ID, login: "internal", image: null } };
    const response = await get("?locale=zh");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    const body = (await response.json()) as { items: { repoKey: string }[]; scoreVersion: string };
    expect(body.items.map((item) => item.repoKey)).toEqual(["acme/tie-easy", "acme/tie-hard", "acme/low"]);
    expect(body.scoreVersion).toBe("discover-score-v1.1");
  });
});
