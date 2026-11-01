import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(), acquire: vi.fn(), coalesce: vi.fn(), build: vi.fn(), persist: vi.fn(), log: vi.fn(),
}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("../redis", () => ({ tryAcquireScanRefresh: mocks.acquire, coalesceScan: mocks.coalesce, admitVisitRefresh: vi.fn() }));
vi.mock("../db", () => ({ publishCompleteQuickScan: mocks.persist }));
vi.mock("../scan-core", () => ({
  buildScanResult: mocks.build,
  logFreshScanFailure: mocks.log,
  discardIncrementalCursor: vi.fn(),
}));
import { refreshScanInBackground, scheduleFullScanIfNeeded } from "../scan-background-refresh";
import type { ScanResult } from "../types";

const partial = { metrics: { username: "fiction-highfork" }, collection: {
  mode: "quick", coverage: "partial_public", truncation_reasons: ["public_repos_quick_limit"],
} } as ScanResult;
const complete = { ...partial, collection: { mode: "full", coverage: "complete_public", truncation_reasons: [] } } as ScanResult;

beforeEach(() => {
  vi.clearAllMocks();
  const admitted = new Set<string>();
  mocks.acquire.mockImplementation(async (username: string) => {
    const key = username.toLowerCase();
    if (admitted.has(key)) return false;
    admitted.add(key); return true;
  });
  mocks.coalesce.mockImplementation(async (_username: string, produce: () => Promise<ScanResult>) => produce());
  mocks.build.mockResolvedValueOnce(partial).mockResolvedValue(complete);
  mocks.persist.mockResolvedValue(true);
});

it("coalesces visit refresh and fullscan under #580 admission and deepens once", async () => {
  await Promise.all([refreshScanInBackground("fiction-highfork"), refreshScanInBackground("FICTION-HIGHFORK", true)]);
  expect(mocks.coalesce).toHaveBeenCalledExactlyOnceWith("fiction-highfork", expect.any(Function), { force: true, background: true, continueOnDeadline: true });
  expect(mocks.build).toHaveBeenCalledTimes(2);
  expect(mocks.build).toHaveBeenNthCalledWith(2, "fiction-highfork", { full: true, deadlineMs: expect.any(Number) });
  expect(mocks.persist).toHaveBeenCalledExactlyOnceWith(complete, expect.any(Number));
});

it("schedules a partial quick result without running GitHub in the response", () => {
  scheduleFullScanIfNeeded(partial);
  scheduleFullScanIfNeeded(complete);
  expect(mocks.after).toHaveBeenCalledOnce();
  expect(mocks.build).not.toHaveBeenCalled();
});

it("joins existing pending collection through the same coalesce lock", async () => {
  mocks.coalesce.mockRejectedValueOnce(new Error("existing pending owner"));
  await refreshScanInBackground("fiction-highfork", true);
  expect(mocks.build).not.toHaveBeenCalled();
  expect(mocks.persist).not.toHaveBeenCalled();
});
