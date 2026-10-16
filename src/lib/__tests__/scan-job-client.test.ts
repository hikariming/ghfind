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

  it("keeps polling past the old 75 s limit and reports each pending status", async () => {
    vi.useFakeTimers();
    let polls = 0;
    const fetch = vi.fn(async () => {
      polls += 1;
      return polls < 60
        ? Response.json({ status: { state: "running", phase: "merged_prs", progress: polls / 100 } }, { status: 202 })
        : Response.json({ status: { state: "done" }, result: { metrics: { username: "octocat" } } });
    });
    vi.stubGlobal("fetch", fetch);
    const statuses: unknown[] = [];
    const pending = readScanResponse(
      Response.json({ status: { state: "queued" } }, { status: 202, headers: { Location: "/api/scan/status/octocat" } }),
      { onStatus: (status) => statuses.push(status) },
    );

    await vi.advanceTimersByTimeAsync(3 * 60_000);

    await expect(pending).resolves.toMatchObject({ metrics: { username: "octocat" } });
    expect(polls).toBe(60);
    expect(statuses[0]).toEqual({ state: "queued" });
    expect(statuses.at(-1)).toEqual({ state: "running", phase: "merged_prs", progress: 0.59 });
    vi.useRealTimers();
  });

  it("surfaces a failed job's error code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: { state: "failed", error: "account_not_found" } })));
    const response = Response.json({}, { status: 202, headers: { Location: "/api/scan/status/ghost" } });

    await expect(readScanResponse(response)).rejects.toMatchObject({ code: "account_not_found" });
  });
});
