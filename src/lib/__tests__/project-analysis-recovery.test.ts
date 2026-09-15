import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validProjectAnalysis, validRuntimeEvidence } from "./project-analysis-contract.test";
import type { ProjectAnalysisArtifact } from "../project-analysis-contract";
import type { ProjectAnalysisRecoveryInput } from "../project-analysis-db";
let db: typeof import("../project-analysis-db");
let service: typeof import("../project-analysis-service");
let raw: Client;
let directory: string;
let now = 1800000000000;
let sequence = 0;
const sha = "a".repeat(40);

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "analysis-operator-recovery-"));
  process.env.TURSO_DATABASE_URL = `file:${join(directory, "core.db")}`;
  process.env.MOSOO_API_BASE = "https://mosoo.test/api/v1";
  process.env.MOSOO_API_TOKEN = "synthetic-provider-token";
  process.env.MOSOO_PROJECT_AGENT_ID = "project-agent";
  process.env.PROJECT_ANALYSIS_MAX_CONCURRENCY = "20";
  db = await import("../project-analysis-db");
  service = await import("../project-analysis-service");
  db.resetProjectAnalysisDbForTests();
  raw = createClient({ url: process.env.TURSO_DATABASE_URL });
});
beforeEach(() => { now = 1800000000000; vi.spyOn(Date, "now").mockImplementation(() => now); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => {
  raw.close(); db.resetProjectAnalysisDbForTests();
  for (const key of ["TURSO_DATABASE_URL", "MOSOO_API_BASE", "MOSOO_API_TOKEN", "MOSOO_PROJECT_AGENT_ID", "PROJECT_ANALYSIS_MAX_CONCURRENCY"]) delete process.env[key];
  rmSync(directory, { recursive: true, force: true });
});
async function seed(expired = true) {
  const analysisId = `operator-analysis-${++sequence}`, repoKey = `owner/recovery-${sequence}`;
  await db.createProjectAnalysisRun({ id: analysisId, repoKey, canonicalUrl: `https://github.com/${repoKey}`, requestedRef: sha,
    schemaVersion: "ghfind.project-analysis.v3", rubricVersion: "project-value-v1", agentVersion: "project-evaluator-v3", skillVersion: "ghfind-project-evaluator-v4" });
  await db.reserveProjectAnalysisExecutionSlot(analysisId, 100);
  await db.attachMosooThread({ analysisId, agentId: "project-agent", threadId: `${analysisId}-old-thread`, runId: `${analysisId}-old-run` });
  const original = (await db.getProjectAnalysisRun(analysisId))!;
  now += 38 * 60_000;
  if (expired) await db.failProjectAnalysis(analysisId, "analysis_timeout", "Original timeout must remain audited.", "expired");
  const input: ProjectAnalysisRecoveryInput = { action: "retry_interrupted", analysisId, requestedRef: sha,
    expectedThreadId: original.mosooThreadId!, expectedRunId: original.mosooRunId!, requestId: `operator-request-${sequence}`, operatorRef: "github-actions:123:1" };
  return { input, original, repoKey };
}
function provider(f: Awaited<ReturnType<typeof seed>>, options: { status?: string; code?: string; wrongAgent?: boolean; failFirstPost?: boolean; invalidArtifact?: boolean } = {}) {
  const posts: string[] = [];
  const response = (newThread = false) => ({ thread: { id: newThread ? `${f.input.analysisId}-new-thread` : f.input.expectedThreadId,
    agent_id: options.wrongAgent ? "other-agent" : "project-agent", kind: "cattle", status: "IDLE", userId: "ghfind" },
    run: { id: newThread ? `${f.input.analysisId}-new-run` : f.input.expectedRunId, status: newThread ? "running" : options.status ?? "failed",
      createdAt: "2026-09-14T00:00:00Z", startedAt: "2026-09-14T00:00:01Z", completedAt: newThread ? null : "2026-09-14T00:02:00Z",
      updatedAt: "2026-09-14T00:02:00Z", trigger: "user_prompt", error: { code: options.code ?? "runtime.turn_interrupted", message: "interrupted" } } });
  const analysis: ProjectAnalysisArtifact = structuredClone(validProjectAnalysis);
  analysis.analysis_id = f.input.analysisId;
  analysis.repository = { ...analysis.repository, repo_key: f.repoKey, canonical_url: `https://github.com/${f.repoKey}`, requested_ref: sha };
  const evidence = { ...validRuntimeEvidence, analysis_id: f.input.analysisId, repo_key: f.repoKey };
  vi.stubGlobal("fetch", vi.fn(async (urlValue: RequestInfo | URL, init?: RequestInit) => {
    const url = String(urlValue);
    if (init?.method === "POST") {
      expect(url).toBe("https://mosoo.test/api/v1/agents/project-agent/threads");
      posts.push(new Headers(init.headers).get("Idempotency-Key")!);
      if (options.failFirstPost && posts.length === 1) throw new TypeError("simulated_lost_ack");
      return Response.json(response(true));
    }
    if (url.includes("/events?")) return Response.json({ events: [], truncated: false });
    if (url.endsWith("/files")) return Response.json({ files: [
      { id: "analysis", name: `project-analysis-${f.input.analysisId}.json` },
      { id: "evidence", name: `runtime-evidence-${f.input.analysisId}.json` },
      { id: "report", name: `project-report-${f.input.analysisId}.md` },
    ].map(row => ({ ...row, kind: "artifact", committed: true, size: 1000, mimeType: "text/plain" })) });
    if (url.includes("/files/analysis/")) return new Response(options.invalidArtifact ? "{}" : JSON.stringify(analysis));
    if (url.includes("/files/evidence/")) return new Response(JSON.stringify(evidence));
    if (url.includes("/files/report/")) return new Response("# Completed report\n\nValid original provider output.");
    if (url.endsWith(`${f.input.analysisId}-new-thread`)) return Response.json(response(true));
    return Response.json(response());
  }));
  return { posts };
}

describe("audited operator recovery", () => {
  it("retries the same analysis once, audits its old identity and uses a fresh deadline without rewriting started_at", async () => {
    const f = await seed(), remote = provider(f);
    const recovered = await service.recoverProjectAnalysis(f.input);
    const audit = (await db.getProjectAnalysisRecovery(f.input.analysisId))!;
    expect(recovered.status).toBe("running");
    expect(recovered.id).toBe(f.input.analysisId);
    expect(recovered.startedAt).toBe(f.original.startedAt);
    expect(audit.originalStartedAt).toBe(f.original.startedAt);
    expect(audit.originalCreateAttempts).toBe(1);
    expect(audit.originalIdempotencyKey).toBe(f.original.idempotencyKey);
    expect(audit.executionDeadlineAt! - audit.createdAt).toBe(1800000);
    expect(remote.posts).toEqual([`ghfind-project-${f.input.analysisId}-retry-1`]);
    await service.recoverProjectAnalysis({ ...f.input, operatorRef: "github-actions:456:1" });
    await service.reconcileProjectAnalysis(f.input.analysisId);
    expect((await db.getProjectAnalysisRun(f.input.analysisId))?.status).toBe("running");
    expect(remote.posts).toHaveLength(1);
    expect(await db.getProjectAnalysisRecovery(f.input.analysisId)).toEqual(audit);
    now = audit.executionDeadlineAt! + 1;
    expect((await service.reconcileProjectAnalysis(f.input.analysisId)).status).toBe("expired");
    await expect(service.recoverProjectAnalysis(f.input)).rejects.toThrow("another retry is prohibited");
    expect(remote.posts).toHaveLength(1);
  });
  it("lost create acknowledgement retries with the same provider idempotency key and original audit", async () => {
    const f = await seed(), remote = provider(f, { failFirstPost: true });
    expect((await service.recoverProjectAnalysis(f.input)).status).toBe("queued");
    const audit = await db.getProjectAnalysisRecovery(f.input.analysisId);
    now += 6000;
    expect((await service.recoverProjectAnalysis(f.input)).status).toBe("running");
    expect(remote.posts).toEqual([`ghfind-project-${f.input.analysisId}-retry-1`, `ghfind-project-${f.input.analysisId}-retry-1`]);
    expect(await db.getProjectAnalysisRecovery(f.input.analysisId)).toEqual(audit);
  });
  it("concurrent recovery cannot claim two provider attempts", async () => {
    const f = await seed(), remote = provider(f);
    const results = await Promise.allSettled([service.recoverProjectAnalysis(f.input), service.recoverProjectAnalysis(f.input)]);
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    expect(remote.posts).toHaveLength(1);
  });
  it("rejects unconfirmed provider failure, wrong identity and changed request without mutating expired state", async () => {
    for (const options of [{ status: "running" }, { code: "different_error" }, { wrongAgent: true }]) {
      const f = await seed(), remote = provider(f, options);
      await expect(service.recoverProjectAnalysis(f.input)).rejects.toThrow();
      expect((await db.getProjectAnalysisRun(f.input.analysisId))?.status).toBe("expired");
      expect(await db.getProjectAnalysisRecovery(f.input.analysisId)).toBeNull();
      expect(remote.posts).toHaveLength(0);
    }
    const f = await seed(), remote = provider(f);
    await service.recoverProjectAnalysis(f.input);
    await expect(service.recoverProjectAnalysis({ ...f.input, requestId: "another-request" })).rejects.toThrow("already consumed");
    expect(remote.posts).toHaveLength(1);
  });
  it("a newer repository assessment prevents an expired result from being resurrected", async () => {
    const f = await seed(), remote = provider(f);
    await db.createProjectAnalysisRun({ id: `${f.input.analysisId}-newer`, repoKey: f.repoKey, canonicalUrl: `https://github.com/${f.repoKey}`,
      requestedRef: sha, schemaVersion: "ghfind.project-analysis.v3", rubricVersion: "project-value-v1", agentVersion: "project-evaluator-v3", skillVersion: "ghfind-project-evaluator-v4" });
    await expect(service.recoverProjectAnalysis(f.input)).rejects.toThrow("superseded");
    expect(remote.posts).toHaveLength(0);
    expect(await db.getProjectAnalysisRecovery(f.input.analysisId)).toBeNull();
  });
  it("late completed provider results finalize instead of expiring and create no thread", async () => {
    const f = await seed(false), remote = provider(f, { status: "completed" });
    expect((await service.reconcileProjectAnalysis(f.input.analysisId)).status).toBe("completed");
    expect((await db.getProjectAssessment(f.repoKey))?.latestAnalysisId).toBe(f.input.analysisId);
    expect(remote.posts).toHaveLength(0);
  });
  it("completed timeout recovery validates artifacts before claiming and is idempotent", async () => {
    const f = await seed(), remote = provider(f, { status: "completed" });
    const input = { ...f.input, action: "finalize_completed" as const };
    expect((await service.recoverProjectAnalysis(input)).status).toBe("completed");
    expect((await service.recoverProjectAnalysis(input)).status).toBe("completed");
    expect((await db.getProjectAnalysisRecovery(input.analysisId))?.executionDeadlineAt).toBeNull();
    expect(remote.posts).toHaveLength(0);
    const invalid = await seed(); provider(invalid, { status: "completed", invalidArtifact: true });
    await expect(service.recoverProjectAnalysis({ ...invalid.input, action: "finalize_completed" })).rejects.toThrow();
    expect((await db.getProjectAnalysisRun(invalid.input.analysisId))?.status).toBe("expired");
    expect(await db.getProjectAnalysisRecovery(invalid.input.analysisId)).toBeNull();
  });
  it("publication rechecks supersession atomically after the recovered attempt has already started", async () => {
    const f = await seed(); provider(f);
    await service.recoverProjectAnalysis(f.input);
    now += 1;
    await db.createProjectAnalysisRun({ id: `${f.input.analysisId}-later`, repoKey: f.repoKey, canonicalUrl: `https://github.com/${f.repoKey}`,
      requestedRef: "b".repeat(40), schemaVersion: "ghfind.project-analysis.v3", rubricVersion: "project-value-v1", agentVersion: "project-evaluator-v3", skillVersion: "ghfind-project-evaluator-v4" });
    const analysis: ProjectAnalysisArtifact = structuredClone(validProjectAnalysis);
    analysis.analysis_id = f.input.analysisId;
    analysis.repository = { ...analysis.repository, repo_key: f.repoKey, canonical_url: `https://github.com/${f.repoKey}`, requested_ref: sha };
    await expect(db.finalizeProjectAnalysis({ analysisId: f.input.analysisId, analysis,
      analysisJson: JSON.stringify(analysis), evidenceJson: JSON.stringify(validRuntimeEvidence), reportMarkdown: "report",
      hashes: { analysis: "a", evidence: "b", report: "c" } })).rejects.toThrow();
    expect(await db.getProjectAssessment(f.repoKey)).toBeNull();
    expect((await db.getProjectAnalysisRun(f.input.analysisId))?.status).toBe("running");
    expect((await raw.execute("SELECT COUNT(*) AS n FROM project_analysis_recovery_guards")).rows[0].n).toBe(0);
  });
  it("the audited deadline also bounds an old nullable started_at and preserves that null", async () => {
    const f = await seed(); provider(f);
    await raw.execute({ sql: "UPDATE project_analysis_runs SET started_at=NULL WHERE id=?", args: [f.input.analysisId] });
    const recovered = await service.recoverProjectAnalysis(f.input);
    expect(recovered.startedAt).toBeNull();
    const audit = (await db.getProjectAnalysisRecovery(f.input.analysisId))!;
    expect(audit.originalStartedAt).toBeNull();
    now = audit.executionDeadlineAt! + 1;
    expect((await service.reconcileProjectAnalysis(f.input.analysisId)).status).toBe("expired");
  });
  it("migration is repeatable and preserved audit rows retain their original timeout", async () => {
    const migration = readFileSync("migrations/0007_project_analysis_recovery.sql", "utf8");
    await raw.executeMultiple(migration); await raw.executeMultiple(migration);
    const f = await seed(); provider(f);
    await service.recoverProjectAnalysis(f.input);
    const audit = await raw.execute({ sql: "SELECT original_error_code,original_started_at,original_create_attempts FROM project_analysis_recoveries WHERE analysis_id=?", args: [f.input.analysisId] });
    expect(audit.rows[0]).toMatchObject({ original_error_code: "analysis_timeout", original_started_at: f.original.startedAt, original_create_attempts: 1 });
  });
});
