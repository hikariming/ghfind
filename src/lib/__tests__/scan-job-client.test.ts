import { afterEach, describe, expect, it, vi } from "vitest";
import { readScanResponse } from "@/lib/scan-job-client";

describe("readScanResponse", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns immediate scan payloads unchanged", async () => {
    const response = Response.json({ metrics: { username: "octocat" }, scoring: { final_score: 42 } });
    await expect(readScanResponse(response)).resolves.toMatchObject({
      metrics: { username: "octocat" },
      scoring: { final_score: 42 },
    });
  });

  it("follows a public scan job Location after 202", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        status: { state: "completed" },
        result: { metrics: { username: "octocat" }, scoring: { final_score: 42 } },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const response = Response.json(
      { id: "job_aaaaaaaaaaaaaaaa", state: "queued" },
      { status: 202, headers: { Location: "/api/scan/jobs/job_aaaaaaaaaaaaaaaa" } },
    );

    await expect(readScanResponse(response)).resolves.toMatchObject({
      metrics: { username: "octocat" },
      scoring: { final_score: 42 },
    });
    expect(fetch).toHaveBeenCalledWith("/api/scan/jobs/job_aaaaaaaaaaaaaaaa", { cache: "no-store" });
  });

  it("polls GET /api/scan until a 200 snapshot arrives", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: "scan_pending", scan_pending: true, status: { state: "running" } },
          { status: 202, headers: { "Retry-After": "1" } },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ metrics: { username: "tj" }, scoring: { final_score: 88 } }),
      );
    vi.stubGlobal("fetch", fetch);
    vi.useFakeTimers();
    const pending = readScanResponse(
      Response.json(
        { error: "scan_pending", scan_pending: true },
        { status: 202, headers: { Location: "/api/scan?username=tj", "Retry-After": "1" } },
      ),
    );
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ metrics: { username: "tj" }, scoring: { final_score: 88 } });
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/scan?username=tj", { cache: "no-store" });
    vi.useRealTimers();
  });
});
