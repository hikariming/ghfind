import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTrendingLeaderboard: vi.fn(), getLeaderboard: vi.fn(),
  getHeatLeaderboard: vi.fn(), getProgressLeaderboard: vi.fn(),
  getCachedLeaderboard: vi.fn(), setCachedLeaderboard: vi.fn(),
  acquireLeaderboardRefresh: vi.fn(), waitUntil: vi.fn(), worker: false,
}));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => {
  if (!mocks.worker) throw new Error("No request");
  return { ctx: { waitUntil: mocks.waitUntil } };
} }));
vi.mock("@/lib/db", () => ({
  getTrendingLeaderboard: mocks.getTrendingLeaderboard, getLeaderboard: mocks.getLeaderboard,
  getHeatLeaderboard: mocks.getHeatLeaderboard, getProgressLeaderboard: mocks.getProgressLeaderboard,
}));
vi.mock("@/lib/redis", () => ({
  getCachedLeaderboard: mocks.getCachedLeaderboard, setCachedLeaderboard: mocks.setCachedLeaderboard,
  acquireLeaderboardRefresh: mocks.acquireLeaderboardRefresh, LEADERBOARD_FRESH_MS: 300_000,
  LEADERBOARD_REWRITE_MS: 900_000,
}));
import { getLeaderboardCached } from "@/lib/leaderboard";
const old = [{ username: "old" }];
beforeEach(() => {
  vi.resetAllMocks(); mocks.worker = false;
  mocks.getCachedLeaderboard.mockResolvedValue(null);
  mocks.setCachedLeaderboard.mockResolvedValue(undefined);
  mocks.acquireLeaderboardRefresh.mockResolvedValue(true);
});
describe("getLeaderboardCached", () => {
  it("caches a non-empty fetch", async () => {
    mocks.getTrendingLeaderboard.mockResolvedValue([{ username: "a" }]);
    expect((await getLeaderboardCached()).entries).toHaveLength(1);
    expect(mocks.setCachedLeaderboard).toHaveBeenCalledOnce();
  });
  it("does not cache a failed/empty cold fetch", async () => {
    mocks.getTrendingLeaderboard.mockResolvedValue([]);
    expect((await getLeaderboardCached()).entries).toEqual([]);
    expect(mocks.setCachedLeaderboard).not.toHaveBeenCalled();
  });
  it("serves fresh cache without a query or refresh lease", async () => {
    mocks.getCachedLeaderboard.mockResolvedValue({ entries: old, at: Date.now() });
    expect(await getLeaderboardCached()).toEqual({ entries: old, cached: true });
    expect(mocks.getTrendingLeaderboard).not.toHaveBeenCalled();
    expect(mocks.acquireLeaderboardRefresh).not.toHaveBeenCalled();
  });
  it("serves stale data when another isolate owns the refresh, holding it for the lease", async () => {
    // Its own window: a lost lease holds the copy in this isolate.
    mocks.getCachedLeaderboard.mockResolvedValue({ entries: old, at: 0 });
    mocks.acquireLeaderboardRefresh.mockResolvedValue(false);
    expect((await getLeaderboardCached("trending", "7d")).entries).toEqual(old);
    expect((await getLeaderboardCached("trending", "7d")).entries).toEqual(old);
    expect(mocks.getTrendingLeaderboard).not.toHaveBeenCalled();
    expect(mocks.acquireLeaderboardRefresh).toHaveBeenCalledOnce();
  });
  it("does not rewrite an unchanged board, and holds it instead of re-asking for the lease", async () => {
    const board = [{ username: "same" }];
    mocks.getCachedLeaderboard.mockResolvedValue({ entries: board, at: Date.now() - 400_000 });
    mocks.getLeaderboard.mockResolvedValue([{ username: "same" }]);
    expect((await getLeaderboardCached("score", "24h")).entries).toEqual(board);
    expect(mocks.getLeaderboard).toHaveBeenCalledOnce();
    expect(mocks.setCachedLeaderboard).not.toHaveBeenCalled();
    await getLeaderboardCached("score", "24h");
    expect(mocks.acquireLeaderboardRefresh).toHaveBeenCalledOnce();
    expect(mocks.getLeaderboard).toHaveBeenCalledOnce();
  });
  it("rewrites a changed board, and an unchanged one nearing its KV expiry", async () => {
    mocks.getCachedLeaderboard.mockResolvedValue({ entries: old, at: Date.now() - 400_000 });
    mocks.getHeatLeaderboard.mockResolvedValue([{ username: "new" }]);
    await getLeaderboardCached("heat", "24h");
    expect(mocks.setCachedLeaderboard).toHaveBeenCalledWith([{ username: "new" }], "heat", "24h");

    mocks.getCachedLeaderboard.mockResolvedValue({ entries: old, at: Date.now() - 1_000_000 });
    mocks.getProgressLeaderboard.mockResolvedValue([{ username: "old" }]);
    await getLeaderboardCached("progress", "30d");
    expect(mocks.setCachedLeaderboard).toHaveBeenCalledWith([{ username: "old" }], "progress", "30d");
  });
  it.each([[], new Error("DB down")])("preserves stale data when refresh fails: %s", async outcome => {
    mocks.getCachedLeaderboard.mockResolvedValue({ entries: old, at: 0 });
    if (outcome instanceof Error) mocks.getTrendingLeaderboard.mockRejectedValue(outcome);
    else mocks.getTrendingLeaderboard.mockResolvedValue(outcome);
    expect((await getLeaderboardCached()).entries).toEqual(old);
    expect(mocks.setCachedLeaderboard).not.toHaveBeenCalled();
  });
  it("responds with stale data while waitUntil keeps one refresh alive", async () => {
    mocks.worker = true;
    mocks.getCachedLeaderboard.mockResolvedValue({ entries: old, at: 0 });
    let finish!: (value: unknown) => void;
    mocks.getTrendingLeaderboard.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const responses = await Promise.all([getLeaderboardCached(), getLeaderboardCached()]);
    expect(responses.every(result => result.entries === old)).toBe(true);
    expect(mocks.getTrendingLeaderboard).toHaveBeenCalledOnce();
    finish([{ username: "new" }]);
    await Promise.all(mocks.waitUntil.mock.calls.map(([promise]) => promise));
    expect(mocks.setCachedLeaderboard).toHaveBeenCalledOnce();
  });
});
