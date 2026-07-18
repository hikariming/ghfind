import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  drainPublicScanJobsFromCron: vi.fn(),
}));

vi.mock("@/lib/public-scan-dispatcher", () => ({
  drainPublicScanJobsFromCron: mocks.drainPublicScanJobsFromCron,
}));

import { GET } from "./route";

const originalCronSecret = process.env.CRON_SECRET;

describe("durable scan Cron worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "cron-test-secret";
    mocks.drainPublicScanJobsFromCron.mockResolvedValue({
      processed: 2,
      exhaustedBudget: false,
      results: [{ status: "continued", jobId: "job-id", phase: "merged_prs" }],
    });
  });

  afterEach(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
  });

  it("accepts only the existing deployment Cron credential", async () => {
    const denied = await GET(new NextRequest("https://example.test/api/internal/public-scan"));
    expect(denied.status).toBe(401);

    const accepted = await GET(
      new NextRequest("https://example.test/api/internal/public-scan", {
        headers: { authorization: "Bearer cron-test-secret" },
      }),
    );
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ status: "ok", processed: 2 });
    expect(mocks.drainPublicScanJobsFromCron).toHaveBeenCalledTimes(1);
  });
});
