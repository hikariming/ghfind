import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  validProjectAnalysis,
  validRuntimeEvidence,
} from "./project-analysis-contract.test";
import type { ProjectAnalysisArtifact } from "../project-analysis-contract";
let db: typeof import("../project-analysis-db");
let service: typeof import("../project-analysis-service");
let temporaryDirectory: string;

const analysisId = "service-analysis";
const threadId = "service-thread";
const retryAnalysisId = "service-retry-analysis";

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "ghroast-project-service-"));
  process.env.TURSO_DATABASE_URL = `file:${join(temporaryDirectory, "test.db")}`;
  process.env.MOSOO_API_BASE = "https://mosoo.test/api/v1";
  process.env.MOSOO_API_TOKEN = "test-token";
  process.env.MOSOO_PROJECT_AGENT_ID = "project-agent";
  db = await import("../project-analysis-db");
  service = await import("../project-analysis-service");
  db.resetProjectAnalysisDbForTests();
});

afterAll(() => {
  vi.unstubAllGlobals();
  db.resetProjectAnalysisDbForTests();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.MOSOO_API_BASE;
  delete process.env.MOSOO_API_TOKEN;
  delete process.env.MOSOO_PROJECT_AGENT_ID;
  delete process.env.PROJECT_ANALYSIS_RUNTIME_ALLOWLIST;
  delete process.env.PROJECT_ANALYSIS_CREATE_MAX_ATTEMPTS;
  delete process.env.PROJECT_ANALYSIS_CREATE_RETRY_BASE_MS;
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("project analysis reconciliation", () => {
  it("keeps arbitrary public repositories source-only unless exactly allowlisted", () => {
    process.env.PROJECT_ANALYSIS_RUNTIME_ALLOWLIST = "owner/trusted,other/repo";
    expect(service.projectAnalysisExecutionMode("owner/trusted")).toBe(
      "allowlisted_runtime",
    );
    expect(service.projectAnalysisExecutionMode("OWNER/TRUSTED")).toBe(
      "allowlisted_runtime",
    );
    expect(service.projectAnalysisExecutionMode("owner/trusted-fork")).toBe("source_only");
    delete process.env.PROJECT_ANALYSIS_RUNTIME_ALLOWLIST;
  });

  it("does not accept artifacts from a failed Mosoo terminal run", async () => {
    await db.createProjectAnalysisRun({
      id: analysisId,
      repoKey: "owner/useful-tool",
      canonicalUrl: "https://github.com/owner/useful-tool",
      requestedRef: null,
      schemaVersion: "ghfind.project-analysis.v1",
      rubricVersion: "project-value-v1",
      agentVersion: "project-evaluator-v1",
      skillVersion: "ghfind-project-evaluator-v1",
    });
    await db.attachMosooThread({
      analysisId,
      agentId: "project-agent",
      threadId,
      runId: "service-run",
    });

    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.endsWith(`/threads/${threadId}`)) {
          return Response.json({
            thread: {
              id: threadId,
              agent_id: "project-agent",
              kind: "cattle",
              status: "IDLE",
              client_external_ref: analysisId,
            },
            run: {
              id: "service-run",
              status: "failed",
              createdAt: "2026-07-15T00:00:00.000Z",
              startedAt: "2026-07-15T00:00:01.000Z",
              completedAt: "2026-07-15T00:00:10.000Z",
              updatedAt: "2026-07-15T00:00:10.000Z",
              trigger: "user_prompt",
            },
          });
        }
        if (url.includes(`/threads/${threadId}/events`)) {
          return Response.json({ events: [], truncated: false });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      }),
    );

    const failed = await service.reconcileProjectAnalysis(analysisId);
    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "mosoo_run_failed",
    });
    await expect(service.reconcileProjectAnalysis(analysisId)).resolves.toMatchObject({
      status: "failed",
    });
    expect(requestedUrls.some((url) => url.endsWith(`/threads/${threadId}/files`))).toBe(false);
    await expect(service.getPublicProjectAnalysisView(analysisId)).resolves.toMatchObject({
      error: {
        code: "mosoo_run_failed",
        message: "Project analysis could not be completed. Please try again.",
      },
    });
    await expect(db.getProjectAssessment("owner/useful-tool")).resolves.toBeNull();
    await expect(db.listTreasureHistory("owner/useful-tool")).resolves.toHaveLength(0);
  });

  it("reuses the durable completed result before creating another Mosoo Thread", async () => {
    const persistedAnalysisId = "service-persisted-analysis";
    const persistedRepoKey = "owner/persisted-tool";
    await db.createProjectAnalysisRun({
      id: persistedAnalysisId,
      repoKey: persistedRepoKey,
      canonicalUrl: `https://github.com/${persistedRepoKey}`,
      requestedRef: null,
      schemaVersion: "ghfind.project-analysis.v3",
      rubricVersion: "project-value-v1",
      agentVersion: "project-evaluator-v3",
      skillVersion: "ghfind-project-evaluator-v4",
    });
    const analysis = {
      ...(validProjectAnalysis as ProjectAnalysisArtifact),
      analysis_id: persistedAnalysisId,
      repository: {
        ...(validProjectAnalysis as ProjectAnalysisArtifact).repository,
        repo_key: persistedRepoKey,
        canonical_url: `https://github.com/${persistedRepoKey}`,
      },
    };
    await db.finalizeProjectAnalysis({
      analysisId: persistedAnalysisId,
      analysis,
      analysisJson: JSON.stringify(analysis),
      evidenceJson: JSON.stringify({
        ...validRuntimeEvidence,
        analysis_id: persistedAnalysisId,
        repo_key: persistedRepoKey,
      }),
      reportMarkdown: "# Persisted Tool",
      hashes: {
        analysis: "persisted-analysis-hash",
        evidence: "persisted-evidence-hash",
        report: "persisted-report-hash",
      },
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      service.createProjectAnalysis({ repositoryUrl: persistedRepoKey }),
    ).resolves.toMatchObject({
      id: persistedAnalysisId,
      repoKey: persistedRepoKey,
      status: "completed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a runtime.inactive failure once with a fresh Thread", async () => {
    await db.createProjectAnalysisRun({
      id: retryAnalysisId,
      repoKey: "owner/retry-tool",
      canonicalUrl: "https://github.com/owner/retry-tool",
      requestedRef: null,
      schemaVersion: "ghfind.project-analysis.v1",
      rubricVersion: "project-value-v1",
      agentVersion: "project-evaluator-v1",
      skillVersion: "ghfind-project-evaluator-v1",
    });
    await db.attachMosooThread({
      analysisId: retryAnalysisId,
      agentId: "project-agent",
      threadId: "inactive-thread",
      runId: "inactive-run",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/threads/inactive-thread")) {
          return Response.json({
            thread: {
              id: "inactive-thread",
              agent_id: "project-agent",
              kind: "cattle",
              status: "IDLE",
              client_external_ref: retryAnalysisId,
            },
            run: {
              id: "inactive-run",
              status: "failed",
              createdAt: "2026-07-15T00:00:00.000Z",
              startedAt: "2026-07-15T00:00:01.000Z",
              completedAt: "2026-07-15T00:01:30.000Z",
              updatedAt: "2026-07-15T00:01:30.000Z",
              trigger: "user_prompt",
              error: {
                code: "runtime.inactive",
                message: "Runtime session became inactive before the run completed.",
                retryable: false,
              },
            },
          });
        }
        if (url.includes("/threads/inactive-thread/events")) {
          return Response.json({ events: [], truncated: false });
        }
        if (url.endsWith("/agents/project-agent/threads") && init?.method === "POST") {
          expect(new Headers(init.headers).get("Idempotency-Key")).toMatch(/-retry-1$/);
          return Response.json({
            thread: {
              id: "retry-thread",
              agent_id: "project-agent",
              kind: "cattle",
              status: "RUNNING",
              client_external_ref: retryAnalysisId,
            },
            run: {
              id: "retry-run",
              status: "running",
              createdAt: "2026-07-15T00:01:31.000Z",
              startedAt: "2026-07-15T00:01:32.000Z",
              completedAt: null,
              updatedAt: "2026-07-15T00:01:32.000Z",
              trigger: "user_prompt",
              error: null,
            },
          });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      }),
    );

    await expect(service.reconcileProjectAnalysis(retryAnalysisId)).resolves.toMatchObject({
      status: "running",
      mosooThreadId: "retry-thread",
      mosooRunId: "retry-run",
      errorCode: null,
    });
  });

  it("backs off failed Thread creation, releases the slot, and stops at the attempt limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T00:00:00.000Z"));
    process.env.PROJECT_ANALYSIS_CREATE_MAX_ATTEMPTS = "2";
    process.env.PROJECT_ANALYSIS_CREATE_RETRY_BASE_MS = "1000";
    const fetchMock = vi.fn(async () =>
      Response.json(
        { error: { code: "internal_error", message: "Public API request failed." } },
        { status: 500 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const first = await service.createProjectAnalysis({
        repositoryUrl: "owner/create-retry-tool",
      });
      expect(first).toMatchObject({
        status: "queued",
        createAttempts: 1,
      });
      expect(first.createRetryAt).toBe(Date.now() + 1_000);
      await expect(service.getPublicProjectAnalysisView(first.id)).resolves.toMatchObject({
        retry: {
          attempt: 1,
          maxAttempts: 2,
          nextAttemptAt: Date.now() + 1_000,
        },
      });

      await expect(service.reconcileProjectAnalysis(first.id)).resolves.toMatchObject({
        status: "queued",
        createAttempts: 1,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1_000);
      await expect(service.reconcileProjectAnalysis(first.id)).resolves.toMatchObject({
        status: "failed",
        errorCode: "mosoo_create_retry_exhausted",
        createAttempts: 2,
        createRetryAt: null,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      delete process.env.PROJECT_ANALYSIS_CREATE_MAX_ATTEMPTS;
      delete process.env.PROJECT_ANALYSIS_CREATE_RETRY_BASE_MS;
    }
  });
});
