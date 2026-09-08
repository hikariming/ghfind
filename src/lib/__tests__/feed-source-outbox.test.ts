import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validProjectAnalysis, validRuntimeEvidence } from "./project-analysis-contract.test";
import type { ProjectAnalysisArtifact } from "../project-analysis-contract";
import { claimFeedSourceEvents, finishFeedSourceDelivery, replayFeedSourceEvent } from "../feed-source-outbox";
import * as analyses from "../project-analysis-db";

let dir: string;
let connection: Client;

const newRun = (id: string) => analyses.createProjectAnalysisRun({
  id, repoKey: "owner/useful-tool", canonicalUrl: "https://github.com/owner/useful-tool", requestedRef: null,
  schemaVersion: "ghfind.project-analysis.v1", rubricVersion: "project-value-v1", agentVersion: "project-evaluator-v1", skillVersion: "ghfind-project-evaluator-v1",
});
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
  vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true });
});

describe("assessment source receipt and outbox", () => {
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
