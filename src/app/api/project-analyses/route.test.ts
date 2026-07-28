import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let route: typeof import("./route");
let db: typeof import("@/lib/project-analysis-db");
let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "ghroast-project-route-"));
  process.env.TURSO_DATABASE_URL = `file:${join(temporaryDirectory, "test.db")}`;
  process.env.MOSOO_API_BASE = "https://mosoo.test/api/v1";
  process.env.MOSOO_API_TOKEN = "test-token";
  process.env.MOSOO_PROJECT_AGENT_ID = "project-agent";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  db = await import("@/lib/project-analysis-db");
  route = await import("./route");
  db.resetProjectAnalysisDbForTests();
});

afterAll(() => {
  vi.unstubAllGlobals();
  db.resetProjectAnalysisDbForTests();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.MOSOO_API_BASE;
  delete process.env.MOSOO_API_TOKEN;
  delete process.env.MOSOO_PROJECT_AGENT_ID;
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function request(body: unknown) {
  return new NextRequest("http://localhost/api/project-analyses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/project-analyses", () => {
  it("rejects invalid repository identities before creating a Mosoo Thread", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await route.POST(
      request({ repositoryUrl: "https://example.com/owner/repository" }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_repository" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 202 and deduplicates the same active repository task", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        thread: {
          id: "route-thread",
          agent_id: "project-agent",
          kind: "cattle",
          status: "RUNNING",
          client_external_ref: null,
        },
        run: {
          id: "route-run",
          status: "running",
          createdAt: "2026-07-15T00:00:00.000Z",
          startedAt: "2026-07-15T00:00:01.000Z",
          completedAt: null,
          updatedAt: "2026-07-15T00:00:01.000Z",
          trigger: "user_prompt",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await route.POST(request({ repositoryUrl: "owner/repository" }));
    expect(first.status).toBe(202);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({
      repoKey: "owner/repository",
      status: "running",
      phase: "classifying",
    });
    expect(first.headers.get("location")).toBe(
      `/api/project-analyses/${firstBody.analysisId}`,
    );
    expect(first.headers.get("idempotency-key")).toContain(firstBody.analysisId);

    const duplicate = await route.POST(
      request({ repositoryUrl: "https://github.com/OWNER/repository" }),
    );
    expect(duplicate.status).toBe(202);
    await expect(duplicate.json()).resolves.toMatchObject({
      analysisId: firstBody.analysisId,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
