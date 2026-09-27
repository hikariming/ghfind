import { afterEach, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ batch: vi.fn(), execute: vi.fn(), close: vi.fn() }));
vi.mock("@libsql/client/web", () => ({ createClient: () => client }));
vi.mock("@/lib/d1-client", () => ({ getD1Binding: () => null }));
vi.mock("@/lib/feed", () => ({ syncFeedProjectProjection: vi.fn() }));
vi.mock("@/lib/feed-source-outbox", () => ({}));
import { listProjectBoard, resetProjectAnalysisDbForTests } from "../project-analysis-db";

afterEach(() => {
  resetProjectAnalysisDbForTests();
  vi.unstubAllEnvs();
});

it("retries schema initialization after an upstream outage without restarting the server", async () => {
  vi.stubEnv("TURSO_DATABASE_URL", "https://example.invalid");
  client.batch.mockRejectedValueOnce(new Error("HTTP 502")).mockResolvedValue([]);
  client.execute.mockResolvedValue({ rows: [] });
  await expect(listProjectBoard("treasure", { limit: 18, offset: 0 })).rejects.toThrow("502");
  await expect(listProjectBoard("treasure", { limit: 18, offset: 0 })).resolves.toEqual([]);
  expect(client.batch).toHaveBeenCalledTimes(2);
});
