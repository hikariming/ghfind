import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ recover: vi.fn(), pending: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/project-analysis-service", () => ({
  recoverProjectAnalysis: mocked.recover, reconcilePendingProjectAnalyses: mocked.pending,
  ProjectAnalysisServiceError: class extends Error { constructor(public code: string, message: string, public status: number) { super(message); } },
}));
vi.mock("@/lib/project-analysis-db", () => ({ getProjectAnalysisRecovery: mocked.audit }));
import { POST } from "../../app/api/internal/project-analyses/reconcile/route";
const input = { action: "retry_interrupted", analysisId: "analysis", requestedRef: "a".repeat(40),
  expectedThreadId: "old-thread", expectedRunId: "old-run", requestId: "stable-request", operatorRef: "github-actions:123:1" };
const request = (body: string, authorized = true) => new NextRequest("https://ghfind.test/api/internal/project-analyses/reconcile", {
  method: "POST", body, headers: { "content-type": "application/json", ...(authorized ? { authorization: "Bearer synthetic-reconcile-secret" } : {}) },
});
afterEach(() => { vi.clearAllMocks(); delete process.env.PROJECT_ANALYSIS_RECONCILE_SECRET; });
describe("protected explicit assessment recovery", () => {
  it("rejects missing authentication before any recovery or pending processing", async () => {
    process.env.PROJECT_ANALYSIS_RECONCILE_SECRET = "synthetic-reconcile-secret";
    expect((await POST(request(JSON.stringify(input), false))).status).toBe(403);
    expect(mocked.recover).not.toHaveBeenCalled(); expect(mocked.pending).not.toHaveBeenCalled();
  });
  it("passes exact identity to service and returns the durable deadline and original timestamps", async () => {
    process.env.PROJECT_ANALYSIS_RECONCILE_SECRET = "synthetic-reconcile-secret";
    mocked.recover.mockResolvedValue({ id: "analysis", requestedRef: input.requestedRef, status: "running", idempotencyKey: "new-key",
      mosooThreadId: "new-thread", mosooRunId: "new-run", startedAt: 1000, createAttempts: 1 });
    mocked.audit.mockResolvedValue({ ...input, createdAt: 2000, executionDeadlineAt: 1802000, nextIdempotencyKey: "new-key" });
    const response = await POST(request(JSON.stringify(input)));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocked.recover).toHaveBeenCalledWith(input);
    expect(await response.json()).toEqual({ analysisId: "analysis", requestedRef: input.requestedRef, status: "running", idempotencyKey: "new-key",
      threadId: "new-thread", runId: "new-run", startedAt: 1000, createAttempts: 1,
      recovery: { requestId: "stable-request", action: "retry_interrupted", executionDeadlineAt: 1802000, createdAt: 2000,
        priorThreadId: "old-thread", priorRunId: "old-run", nextIdempotencyKey: "new-key" } });
    expect(mocked.pending).not.toHaveBeenCalled();
  });
  it("rejects malformed or oversized bodies without invoking recovery", async () => {
    process.env.PROJECT_ANALYSIS_RECONCILE_SECRET = "synthetic-reconcile-secret";
    expect((await POST(request("{"))).status).toBe(400);
    expect((await POST(request("x".repeat(4097)))).status).toBe(413);
    expect(mocked.recover).not.toHaveBeenCalled();
  });
});
