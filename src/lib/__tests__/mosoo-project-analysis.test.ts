import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectAnalysisRun } from "../project-analysis-db";
import {
  createMosooProjectAnalysisThread,
  getMosooProjectAnalysisSnapshot,
  MosooProjectAnalysisError,
  readMosooProjectAnalysisArtifacts,
} from "../mosoo-project-analysis";

const run: ProjectAnalysisRun = {
  id: "analysis-1",
  repoKey: "owner/repo",
  canonicalUrl: "https://github.com/owner/repo",
  requestedRef: null,
  resolvedCommitSha: null,
  idempotencyKey: "ghfind-project-analysis-1",
  status: "queued",
  phase: "queued",
  progress: 0,
  mosooAgentId: null,
  mosooThreadId: null,
  mosooRunId: null,
  schemaVersion: "ghfind.project-analysis.v2",
  rubricVersion: "project-value-v1",
  agentVersion: "project-evaluator-v2",
  skillVersion: "ghfind-project-evaluator-v2",
  verificationLevel: null,
  errorCode: null,
  errorMessage: null,
  createAttempts: 0,
  createRetryAt: null,
  createdAt: 1,
  updatedAt: 1,
  startedAt: null,
  completedAt: null,
};

function threadResponse(
  kind: "pet" | "cattle" = "cattle",
  status = "running",
  error?: { code: string; message: string; retryable?: boolean },
) {
  return {
    thread: {
      id: "thread-1",
      agent_id: "agent-1",
      kind,
      status: "RUNNING",
      client_external_ref: "analysis-1",
    },
    run: {
      id: "run-1",
      status,
      createdAt: "2026-07-15T00:00:00.000Z",
      startedAt: "2026-07-15T00:00:01.000Z",
      completedAt: null,
      updatedAt: "2026-07-15T00:00:01.000Z",
      trigger: "user_prompt",
      error: error ?? null,
    },
  };
}

beforeEach(() => {
  process.env.MOSOO_API_BASE = "https://mosoo.test/api/v1";
  process.env.MOSOO_API_TOKEN = "test-token";
  process.env.MOSOO_PROJECT_AGENT_ID = "agent-1";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MOSOO_API_BASE;
  delete process.env.MOSOO_API_TOKEN;
  delete process.env.MOSOO_PROJECT_AGENT_ID;
});

describe("Mosoo project analysis client", () => {
  it("creates a cattle Thread with the versioned task and stable idempotency key", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(run.idempotencyKey);
      const body = JSON.parse(String(init?.body));
      expect(body.client_external_ref).toBe(run.id);
      expect(body.input.content[0].text).toContain("[GHFIND_PROJECT_ANALYSIS_V2]");
      expect(body.input.content[0].text).toContain("schema_version: ghfind.project-analysis.v2");
      expect(body.input.content[0].text).toContain("execution_mode: source_only");
      return Response.json(threadResponse());
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createMosooProjectAnalysisThread(run, "source_only")).resolves.toMatchObject({
      threadId: "thread-1",
      runId: "run-1",
      runStatus: "running",
      kind: "cattle",
    });
  });

  it("rejects a pet Agent response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(threadResponse("pet"))));
    await expect(createMosooProjectAnalysisThread(run, "source_only")).rejects.toMatchObject({
      code: "mosoo_invalid_response",
    });
  });

  it("maps upstream rate limits without leaking the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: "rate_limited", message: "Slow down" } },
          { status: 429, headers: { "Retry-After": "12" } },
        ),
      ),
    );
    const error = await createMosooProjectAnalysisThread(run, "source_only").catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(MosooProjectAnalysisError);
    expect(error).toMatchObject({ code: "mosoo_rate_limited", retryAfterSeconds: 12 });
    expect(String(error)).not.toContain("test-token");
  });

  it("reads a Thread snapshot and the exact committed artifact names", async () => {
    const contents = new Map([
      ["analysis-file", "{\"analysis\":true}"],
      ["evidence-file", "{\"evidence\":true}"],
      ["report-file", "# Report"],
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/threads/thread-1")) {
          return Response.json(
            threadResponse("cattle", "failed", {
              code: "runtime.inactive",
              message: "Runtime session became inactive before the run completed.",
            }),
          );
        }
        if (url.includes("/threads/thread-1/events")) {
          return Response.json({
            events: [
              {
                id: "event-1",
                type: "session_files.updated",
                status: "available",
                content: "Session files updated.",
                occurredAt: "2026-07-15T00:00:02.000Z",
                durationMs: 1,
                tokens: null,
              },
            ],
            truncated: false,
          });
        }
        if (url.endsWith("/threads/thread-1/files")) {
          return Response.json({
            files: [
              { id: "analysis-file", name: "project-analysis-analysis-1.json", kind: "artifact", committed: true, size: 20, mimeType: "application/json" },
              { id: "evidence-file", name: "runtime-evidence-analysis-1.json", kind: "artifact", committed: true, size: 20, mimeType: "application/json" },
              { id: "report-file", name: "project-report-analysis-1.md", kind: "artifact", committed: true, size: 20, mimeType: "text/markdown" },
            ],
          });
        }
        const fileId = [...contents.keys()].find((id) => url.includes(`/files/${id}/content`));
        if (fileId) return new Response(contents.get(fileId));
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      }),
    );

    await expect(getMosooProjectAnalysisSnapshot("thread-1")).resolves.toMatchObject({
      runStatus: "failed",
      runError: {
        code: "runtime.inactive",
        message: "Runtime session became inactive before the run completed.",
      },
      eventTypes: ["session_files.updated"],
    });
    await expect(readMosooProjectAnalysisArtifacts("thread-1", "analysis-1")).resolves.toEqual({
      analysisJson: "{\"analysis\":true}",
      evidenceJson: "{\"evidence\":true}",
      reportMarkdown: "# Report",
    });
  });
});
