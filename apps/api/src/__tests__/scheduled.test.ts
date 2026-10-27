import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/project-analysis-service", () => ({ reconcilePendingProjectAnalyses: vi.fn() }));
vi.mock("@/lib/auto-reroast-worker", () => ({ runAutoReroastQueue: vi.fn() }));
import { getCloudflareContext } from "../shims/opennext-cloudflare";
import {
  PROJECT_ANALYSIS_RECONCILE_BATCH,
  scheduledAutoReroast,
  scheduledProjectAnalysisReconcile,
} from "../scheduled";

vi.mock("cloudflare:workers", () => ({ env: {} }));

afterEach(() => {
  delete process.env.PROJECT_ANALYSIS_RECONCILE_CRON;
});

describe("scheduled project analysis reconcile", () => {
  it("reconciles one normal batch inside a request context", async () => {
    const pending: Promise<unknown>[] = [];
    const reconcile = vi.fn(async (limit: number) => {
      getCloudflareContext().ctx!.waitUntil(Promise.resolve("bg"));
      return { processed: limit, completed: 0, failed: 0 };
    });
    const result = await scheduledProjectAnalysisReconcile((p) => pending.push(p), reconcile as never);
    expect(reconcile).toHaveBeenCalledWith(PROJECT_ANALYSIS_RECONCILE_BATCH);
    expect(PROJECT_ANALYSIS_RECONCILE_BATCH).toBe(20);
    expect(result).toMatchObject({ status: "ran", processed: 20 });
    expect(pending).toHaveLength(1);
  });

  it("does nothing when paused with PROJECT_ANALYSIS_RECONCILE_CRON=off", async () => {
    process.env.PROJECT_ANALYSIS_RECONCILE_CRON = "off";
    const reconcile = vi.fn();
    await expect(scheduledProjectAnalysisReconcile(() => {}, reconcile as never)).resolves.toEqual({ status: "disabled" });
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe("scheduled auto re-roast", () => {
  it("drains the queue inside a request context", async () => {
    const pending: Promise<unknown>[] = [];
    const run = vi.fn(async () => {
      getCloudflareContext().ctx!.waitUntil(Promise.resolve("bg"));
      return { status: "ran" as const, processed: 1, outcomes: { done: 1 } };
    });
    await expect(scheduledAutoReroast((p) => pending.push(p), run as never)).resolves.toEqual({
      status: "ran",
      processed: 1,
      outcomes: { done: 1 },
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(1);
  });

  it("never throws into the cron handler", async () => {
    const run = vi.fn(async () => {
      throw new Error("store down");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(scheduledAutoReroast(() => {}, run as never)).resolves.toEqual({ status: "unavailable" });
    error.mockRestore();
  });
});
