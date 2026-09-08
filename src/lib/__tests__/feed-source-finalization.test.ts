import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  validProjectAnalysis,
  validRuntimeEvidence,
} from "./project-analysis-contract.test";
import * as analyses from "../project-analysis-db";
import { reconcileProjectAnalysis } from "../project-analysis-service";

const legacy = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock("../feed", () => ({ syncFeedProjectProjection: legacy.sync }));

const analysisId = "source-finalization-analysis";
const threadId = "source-finalization-thread";
const mosooRunId = "source-finalization-run";
const analysis = { ...validProjectAnalysis, analysis_id: analysisId };
const evidence = { ...validRuntimeEvidence, analysis_id: analysisId };
const report = "# Durable source assessment\n\nSource inspected successfully.";
let directory: string;
let connection: Client;
let artifactContents: Map<string, string>;
let requests: string[];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "ghfind-source-finalization-"));
  vi.stubEnv("TURSO_DATABASE_URL", `file:${join(directory, "core.db")}`);
  vi.stubEnv("FEED_SOURCE_OUTBOX_ENABLED", "false");
  vi.stubEnv("MOSOO_API_BASE", "https://mosoo.test/api/v1");
  vi.stubEnv("MOSOO_API_TOKEN", "source-finalization-test-token");
  vi.stubEnv("MOSOO_PROJECT_AGENT_ID", "source-finalization-agent");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  analyses.resetProjectAnalysisDbForTests();
  legacy.sync.mockReset();
  legacy.sync.mockRejectedValue(new Error("Feed must not join source finalization"));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  await analyses.createProjectAnalysisRun({
    id: analysisId,
    repoKey: analysis.repository.repo_key,
    canonicalUrl: analysis.repository.canonical_url,
    requestedRef: analysis.repository.requested_ref,
    schemaVersion: analysis.schema_version,
    rubricVersion: analysis.rubric_version,
    agentVersion: analysis.agent_version,
    skillVersion: analysis.skill_version,
  });
  connection = createClient({ url: process.env.TURSO_DATABASE_URL! });
  for (const migration of [
    "0005_feed_source_outbox.sql",
    "0006_feed_source_replay_audit.sql",
  ]) {
    // Fresh, isolated SQLite database only; the source seam never installs DDL.
    await connection.executeMultiple(readFileSync(join("migrations", migration), "utf8"));
  }
  vi.stubEnv("FEED_SOURCE_OUTBOX_ENABLED", "true");
  await analyses.recordProjectAnalysisSubmission(analysisId);
  await analyses.attachMosooThread({
    analysisId,
    agentId: "source-finalization-agent",
    threadId,
    runId: mosooRunId,
  });

  artifactContents = new Map([
    ["analysis", JSON.stringify(analysis)],
    ["evidence", JSON.stringify(evidence)],
    ["report", report],
  ]);
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (init?.method === "POST") throw new Error("Completed assessment must not start a new Mosoo run");
    if (url.endsWith(`/threads/${threadId}`)) {
      const now = new Date().toISOString();
      return Response.json({
        thread: {
          id: threadId, agent_id: "source-finalization-agent", kind: "cattle",
          status: "IDLE", client_external_ref: analysisId,
        },
        run: {
          id: mosooRunId, status: "completed", createdAt: now, startedAt: now,
          completedAt: now, updatedAt: now, trigger: "user_prompt",
        },
      });
    }
    if (url.includes(`/threads/${threadId}/events`)) {
      return Response.json({ events: [], truncated: false });
    }
    if (url.endsWith(`/threads/${threadId}/files`)) {
      return Response.json({
        files: [
          ["analysis", `project-analysis-${analysisId}.json`, "application/json"],
          ["evidence", `runtime-evidence-${analysisId}.json`, "application/json"],
          ["report", `project-report-${analysisId}.md`, "text/markdown"],
        ].map(([id, name, mimeType]) => ({
          id, name, mimeType, kind: "artifact", committed: true,
          size: Buffer.byteLength(artifactContents.get(id)!),
        })),
      });
    }
    for (const [id, content] of artifactContents) {
      if (url.includes(`/files/${id}/content?`)) return new Response(content);
    }
    throw new Error("Unexpected external request in source finalization fixture");
  }));
});

afterEach(() => {
  connection.close();
  analyses.resetProjectAnalysisDbForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

async function assertCompletedExactlyOnce() {
  expect(await analyses.getProjectAnalysisRun(analysisId)).toMatchObject({
    id: analysisId, status: "completed", mosooThreadId: threadId, mosooRunId,
    errorCode: null,
  });
  const stored = (await connection.execute(
    "SELECT id,analysis_json,evidence_json,report_markdown,analysis_sha256 FROM project_analysis_runs",
  )).rows;
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    id: analysisId,
    analysis_json: JSON.stringify(analysis),
    evidence_json: JSON.stringify(evidence),
    report_markdown: report,
    analysis_sha256: createHash("sha256").update(JSON.stringify(analysis)).digest("hex"),
  });
  expect((await connection.execute("SELECT latest_analysis_id,product_score FROM project_assessments")).rows)
    .toEqual([{ latest_analysis_id: analysisId, product_score: analysis.scores.product_score }]);
  expect((await connection.execute("SELECT analysis_id,receipt_id,status,source_hash FROM feed_source_outbox")).rows)
    .toEqual([{
      analysis_id: analysisId, receipt_id: `app:${analysisId}`, status: "pending",
      source_hash: stored[0].analysis_sha256,
    }]);
  expect((await connection.execute("SELECT * FROM feed_source_assertions")).rows).toHaveLength(0);
  expect(legacy.sync).not.toHaveBeenCalled();
  expect(requests.some((url) => url.includes("/agents/"))).toBe(false);
}

describe("source finalization through the real reconciliation service", () => {
  it("retries an aborted source transaction after the original assessment execution deadline", async () => {
    await connection.executeMultiple(`CREATE TRIGGER reject_source_event
      BEFORE INSERT ON feed_source_outbox BEGIN SELECT RAISE(ABORT,'injected-source-commit-failure'); END;`);
    await expect(reconcileProjectAnalysis(analysisId)).rejects.toMatchObject({
      code: "analysis_persistence_unavailable", status: 503,
    });
    expect(await analyses.getProjectAnalysisRun(analysisId)).toMatchObject({
      status: "finalizing", mosooThreadId: threadId, mosooRunId, errorCode: null,
    });
    expect((await connection.execute("SELECT * FROM project_assessments")).rows).toHaveLength(0);
    expect((await connection.execute("SELECT * FROM feed_source_outbox")).rows).toHaveLength(0);
    expect((await connection.execute("SELECT * FROM feed_source_assertions")).rows).toHaveLength(0);
    expect(legacy.sync).not.toHaveBeenCalled();

    await connection.execute("DROP TRIGGER reject_source_event");
    // Finalizing means the external assessment already completed. Even its
    // original execution timeout must not force another paid evaluation.
    await connection.execute({ sql: "UPDATE project_analysis_runs SET started_at=1 WHERE id=?", args: [analysisId] });
    await expect(reconcileProjectAnalysis(analysisId)).resolves.toMatchObject({ status: "completed" });
    await expect(reconcileProjectAnalysis(analysisId)).resolves.toMatchObject({ status: "completed" });
    await assertCompletedExactlyOnce();
  });

  it("never invokes a failing legacy Feed projection after the source commit", async () => {
    await expect(reconcileProjectAnalysis(analysisId)).resolves.toMatchObject({ status: "completed" });
    await assertCompletedExactlyOnce();
  });

  it("never waits for an unavailable legacy Feed projection", async () => {
    legacy.sync.mockImplementation(() => new Promise<void>(() => {}));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(Promise.race([
        reconcileProjectAnalysis(analysisId),
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("Source response waited for legacy Feed")), 2_000);
        }),
      ])).resolves.toMatchObject({ status: "completed" });
    } finally {
      clearTimeout(deadline);
    }
    await assertCompletedExactlyOnce();
  });

  it("still rejects invalid artifact identity without retrying or publishing it", async () => {
    artifactContents.set("analysis", JSON.stringify({ ...analysis, analysis_id: "forged-analysis-id" }));
    await expect(reconcileProjectAnalysis(analysisId)).resolves.toMatchObject({
      status: "failed", errorCode: "artifact_invalid",
    });
    expect((await connection.execute("SELECT * FROM project_assessments")).rows).toHaveLength(0);
    expect((await connection.execute("SELECT * FROM feed_source_outbox")).rows).toHaveLength(0);
    expect(legacy.sync).not.toHaveBeenCalled();
  });
});
