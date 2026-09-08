import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../../app/api/project-analyses/route";
import { validProjectAnalysis, validRuntimeEvidence } from "./project-analysis-contract.test";
import type { ProjectAnalysisArtifact } from "../project-analysis-contract";
import { claimFeedSourceEvents, finishFeedSourceDelivery, replayFeedSourceEvent } from "../feed-source-outbox";
import * as analyses from "../project-analysis-db";

let dir: string;
let connection: Client;

const newRun = (id: string, options?: analyses.ProjectAnalysisSubmissionOptions, repoKey="owner/useful-tool") => analyses.createProjectAnalysisRun({
  id, repoKey, canonicalUrl: `https://github.com/${repoKey}`, requestedRef: null,
  schemaVersion: "ghfind.project-analysis.v1", rubricVersion: "project-value-v1", agentVersion: "project-evaluator-v1", skillVersion: "ghfind-project-evaluator-v1",
},options);
const finish = (id: string) => analyses.finalizeProjectAnalysis({
  analysisId: id, analysis: validProjectAnalysis as ProjectAnalysisArtifact, analysisJson: JSON.stringify(validProjectAnalysis),
  evidenceJson: JSON.stringify(validRuntimeEvidence), reportMarkdown: "# Existing result preserved",
  hashes: { analysis: "source-hash", evidence: "evidence-hash", report: "report-hash" },
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghfind-source-outbox-"));
  vi.stubEnv("TURSO_DATABASE_URL", `file:${join(dir, "test.db")}`);
  vi.stubEnv("FEED_SOURCE_OUTBOX_ENABLED", "false");
  analyses.resetProjectAnalysisDbForTests();
  await newRun("analysis-1");
  connection = createClient({ url: process.env.TURSO_DATABASE_URL! });
  // Explicit migration; new source capabilities never add runtime DDL.
  await connection.executeMultiple(readFileSync("migrations/0005_feed_source_outbox.sql", "utf8"));
  vi.stubEnv("FEED_SOURCE_OUTBOX_ENABLED", "true");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  connection.close(); analyses.resetProjectAnalysisDbForTests();
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true });
});

describe("assessment source receipt and outbox", () => {
  it("rolls back run creation when provenance fails, and records only one receipt for an active-run race",async()=>{
    await connection.executeMultiple("CREATE TRIGGER reject_submission BEFORE INSERT ON feed_submission_receipts BEGIN SELECT RAISE(ABORT,'injected-receipt-failure'); END;");
    await expect(newRun("atomic-run",{appSubmission:true},"owner/new-submission")).rejects.toThrow();
    expect((await connection.execute("SELECT id FROM project_analysis_runs WHERE id='atomic-run'")).rows).toHaveLength(0);
    expect((await connection.execute("SELECT id FROM feed_submission_receipts")).rows).toHaveLength(0);
    await connection.execute("DROP TRIGGER reject_submission");
    const created=await newRun("atomic-run",{appSubmission:true},"owner/new-submission");
    expect(created.created).toBe(true);
    const duplicate=await newRun("duplicate-attempt",{appSubmission:true},"owner/new-submission");
    expect(duplicate).toMatchObject({created:false,run:{id:"atomic-run"}});
    expect((await connection.execute("SELECT id,requested_repo_key,source_kind FROM feed_submission_receipts")).rows).toEqual([{id:"app:atomic-run",requested_repo_key:"owner/new-submission",source_kind:"app_submission"}]);
    await newRun("background-run",undefined,"owner/background");
    expect((await connection.execute("SELECT id FROM feed_submission_receipts WHERE analysis_id='background-run'")).rows).toHaveLength(0);
  });
  it("persists POST submission intent before any external thread is created", async()=>{
    vi.stubEnv("MOSOO_API_BASE","https://mosoo.test/api/v1");
    vi.stubEnv("MOSOO_API_TOKEN","test-token");
    vi.stubEnv("MOSOO_PROJECT_AGENT_ID","project-agent");
    vi.stubEnv("UPSTASH_REDIS_REST_URL","");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN","");
    let receiptBeforeExternalCall=false;
    vi.stubGlobal("fetch",vi.fn(async()=>{
      const receipts=await connection.execute("SELECT s.id FROM feed_submission_receipts s JOIN project_analysis_runs r ON r.id=s.analysis_id WHERE r.repo_key='owner/atomic-intent'");
      receiptBeforeExternalCall=receipts.rows.length===1;
      return Response.json({
        thread:{id:"intent-thread",agent_id:"project-agent",kind:"cattle",status:"RUNNING",client_external_ref:null},
        run:{id:"intent-run",status:"running",createdAt:"2026-09-08T00:00:00.000Z",startedAt:"2026-09-08T00:00:00.000Z",completedAt:null,updatedAt:"2026-09-08T00:00:00.000Z",trigger:"user_prompt"},
      });
    }));
    const response=await POST(new NextRequest("http://localhost/api/project-analyses",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({repositoryUrl:"owner/atomic-intent"})}));
    expect(response.status).toBe(202);
    expect(receiptBeforeExternalCall).toBe(true);
  });
  it("commits assessment plus outbox, deduplicates receipt/finalization and survives unavailable downstream Feed", async () => {
    await analyses.recordProjectAnalysisSubmission("analysis-1");
    expect((await connection.execute("SELECT * FROM feed_source_outbox")).rows).toHaveLength(0);
    expect((await finish("analysis-1")).status).toBe("completed");
    await analyses.recordProjectAnalysisSubmission("analysis-1");
    await finish("analysis-1");
    const outbox = (await connection.execute("SELECT * FROM feed_source_outbox")).rows;
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ aggregate_key: "owner/useful-tool", receipt_id: "app:analysis-1", source_hash: "source-hash", status: "pending" });
    expect((await connection.execute("SELECT * FROM feed_submission_receipts")).rows).toHaveLength(1);
    expect((await analyses.getProjectAssessment("owner/useful-tool"))?.productScore).toBe(87);
  });

  it("does not infer historical submission from assessment, but records explicit reuse", async () => {
    await finish("analysis-1");
    expect((await connection.execute("SELECT * FROM feed_source_outbox")).rows).toHaveLength(0);
    await analyses.recordProjectAnalysisSubmission("analysis-1");
    expect((await connection.execute("SELECT * FROM feed_source_outbox")).rows).toHaveLength(1);
  });

  it("rolls back assessment, completion and outbox together when source commit fails", async () => {
    await analyses.recordProjectAnalysisSubmission("analysis-1");
    await connection.executeMultiple("CREATE TRIGGER inject_failure BEFORE INSERT ON feed_source_outbox BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    await expect(finish("analysis-1")).rejects.toThrow();
    expect((await analyses.getProjectAnalysisRun("analysis-1"))?.status).toBe("queued");
    expect(await analyses.getProjectAssessment("owner/useful-tool")).toBeNull();
    expect((await connection.execute("SELECT * FROM feed_source_assertions")).rows).toHaveLength(0);
    await connection.execute("DROP TRIGGER inject_failure");
    expect((await finish("analysis-1")).status).toBe("completed");
  });

  it("leases, retries and fences stale acknowledgements without changing event identity", async () => {
    await analyses.recordProjectAnalysisSubmission("analysis-1"); await finish("analysis-1");
    const now = Date.now() + 1_000;
    const first = await claimFeedSourceEvents(connection, { limit: 10, leaseToken: "first", now });
    expect(first).toHaveLength(1);
    expect(await claimFeedSourceEvents(connection, { limit: 10, leaseToken: "racing", now })).toHaveLength(0);
    const next = await claimFeedSourceEvents(connection, { limit: 10, leaseToken: "second", now: now + 60_001 });
    expect(next[0].eventId).toBe(first[0].eventId);
    expect(await finishFeedSourceDelivery(connection, { sequence: first[0].sourceVersion, leaseToken: "first", now: now + 60_002, delivered: true })).toBe(false);
    expect(await finishFeedSourceDelivery(connection, { sequence: next[0].sourceVersion, leaseToken: "second", now: now + 60_002, delivered: true })).toBe(true);
    expect((await connection.execute("SELECT status FROM feed_source_outbox")).rows[0].status).toBe("delivered");
  });

  it("persists retry exhaustion after a crashed final attempt and supports audited replay", async () => {
    await analyses.recordProjectAnalysisSubmission("analysis-1"); await finish("analysis-1");
    await connection.execute("UPDATE feed_source_outbox SET status='leased', attempts=10, lease_expires_at=1");
    expect(await claimFeedSourceEvents(connection, { limit: 10, leaseToken: "next", now: Date.now() })).toHaveLength(0);
    const failed = (await connection.execute("SELECT * FROM feed_source_outbox")).rows[0];
    expect(failed.status).toBe("failed");
    expect(await replayFeedSourceEvent(connection, { sequence: Number(failed.sequence), reason: "incident-test", now: Date.now() })).toBe(true);
    expect((await claimFeedSourceEvents(connection, { limit: 10, leaseToken: "replay", now: Date.now() + 100 }))[0].eventId).toBe(failed.event_id);
  });
});
