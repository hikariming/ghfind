import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectAnalysisArtifact } from "../project-analysis-contract";
import { validProjectAnalysis, validRuntimeEvidence } from "./project-analysis-contract.test";

let db: typeof import("../project-analysis-db");
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ghroast-project-analysis-"));
  process.env.TURSO_DATABASE_URL = `file:${join(tmpDir, "test.db")}`;
  delete process.env.TURSO_AUTH_TOKEN;
  db = await import("../project-analysis-db");
  db.resetProjectAnalysisDbForTests();
});

afterAll(() => {
  db.resetProjectAnalysisDbForTests();
  delete process.env.TURSO_DATABASE_URL;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("project analysis persistence", () => {
  it("deduplicates one active run per repository, ref, and rubric", async () => {
    const first = await db.createProjectAnalysisRun({
      id: "analysis-1",
      repoKey: "owner/useful-tool",
      canonicalUrl: "https://github.com/owner/useful-tool",
      requestedRef: null,
      schemaVersion: "ghfind.project-analysis.v1",
      rubricVersion: "project-value-v1",
      agentVersion: "project-evaluator-v1",
      skillVersion: "ghfind-project-evaluator-v1",
    });
    const duplicate = await db.createProjectAnalysisRun({
      id: "analysis-duplicate",
      repoKey: "owner/useful-tool",
      canonicalUrl: "https://github.com/owner/useful-tool",
      requestedRef: null,
      schemaVersion: "ghfind.project-analysis.v1",
      rubricVersion: "project-value-v1",
      agentVersion: "project-evaluator-v1",
      skillVersion: "ghfind-project-evaluator-v1",
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.run.id).toBe("analysis-1");
  });

  it("stores Mosoo correlation and finalizes assessment atomically", async () => {
    await db.attachMosooThread({
      analysisId: "analysis-1",
      agentId: "01KXZBBD8VW1S3AF6GB5EEG13G",
      threadId: "01KTESTTHREAD000000000000000",
      runId: "01KTESTRUN00000000000000000",
    });
    await db.updateProjectAnalysisState({
      analysisId: "analysis-1",
      status: "running",
      phase: "inspecting",
      progress: 40,
      activities: [
        {
          id: "event-1",
          kind: "inspecting_docs",
          occurredAt: "2026-07-30T14:00:00.000Z",
        },
      ],
    });

    const completed = await db.finalizeProjectAnalysis({
      analysisId: "analysis-1",
      analysis: validProjectAnalysis as ProjectAnalysisArtifact,
      analysisJson: JSON.stringify(validProjectAnalysis),
      evidenceJson: JSON.stringify(validRuntimeEvidence),
      reportMarkdown: "# Useful Tool\n\nA useful project.",
      hashes: {
        analysis: "analysis-hash",
        evidence: "evidence-hash",
        report: "report-hash",
      },
    });

    expect(completed.status).toBe("completed");
    expect(completed.mosooThreadId).toBe("01KTESTTHREAD000000000000000");
    expect(completed.activities).toMatchObject([{ kind: "inspecting_docs" }]);

    const assessment = await db.getProjectAssessment("OWNER/USEFUL-TOOL");
    expect(assessment).toMatchObject({
      repoKey: "owner/useful-tool",
      productScore: 87,
      treasureEligible: true,
      classicEligible: false,
      reportMarkdown: "# Useful Tool\n\nA useful project.",
    });

    const treasure = await db.listProjectBoard("treasure", { limit: 10, offset: 0 });
    expect(treasure).toHaveLength(1);
    expect(treasure[0]?.repoKey).toBe("owner/useful-tool");

    await expect(
      db.findReusableCompletedProjectAnalysisRun({
        repoKey: "OWNER/USEFUL-TOOL",
        requestedRef: null,
        schemaVersion: "ghfind.project-analysis.v1",
        rubricVersion: "project-value-v1",
        agentVersion: "project-evaluator-v1",
        skillVersion: "ghfind-project-evaluator-v1",
      }),
    ).resolves.toMatchObject({ id: "analysis-1", status: "completed" });
    await expect(
      db.findReusableCompletedProjectAnalysisRun({
        repoKey: "owner/useful-tool",
        requestedRef: "main",
        schemaVersion: "ghfind.project-analysis.v1",
        rubricVersion: "project-value-v1",
        agentVersion: "project-evaluator-v1",
        skillVersion: "ghfind-project-evaluator-v1",
      }),
    ).resolves.toBeNull();
  });

  it("keeps the treasure discovery record when a later assessment graduates", async () => {
    const created = await db.createProjectAnalysisRun({
      id: "analysis-2",
      repoKey: "owner/useful-tool",
      canonicalUrl: "https://github.com/owner/useful-tool",
      requestedRef: "main",
      schemaVersion: "ghfind.project-analysis.v1",
      rubricVersion: "project-value-v1",
      agentVersion: "project-evaluator-v1",
      skillVersion: "ghfind-project-evaluator-v1",
    });
    expect(created.created).toBe(true);

    const established = {
      ...(validProjectAnalysis as ProjectAnalysisArtifact),
      analysis_id: "analysis-2",
      repository: {
        ...(validProjectAnalysis as ProjectAnalysisArtifact).repository,
        requested_ref: "main",
      },
      confidence: 82,
      project: {
        ...(validProjectAnalysis as ProjectAnalysisArtifact).project,
        lifecycle: "stable_maintenance" as const,
      },
      exposure: {
        ...(validProjectAnalysis as ProjectAnalysisArtifact).exposure,
        band: "established" as const,
      },
    };
    const establishedEvidence = {
      ...validRuntimeEvidence,
      analysis_id: "analysis-2",
    };

    await db.finalizeProjectAnalysis({
      analysisId: "analysis-2",
      analysis: established,
      analysisJson: JSON.stringify(established),
      evidenceJson: JSON.stringify(establishedEvidence),
      reportMarkdown: "# Established Tool",
      hashes: { analysis: "a2", evidence: "e2", report: "r2" },
    });

    const assessment = await db.getProjectAssessment("owner/useful-tool");
    expect(assessment?.treasureEligible).toBe(false);
    expect(assessment?.classicEligible).toBe(true);
    const history = await db.listTreasureHistory("owner/useful-tool");
    expect(history).toMatchObject([{ status: "graduated" }]);
  });

  it("reserves bounded execution slots and releases them at terminal state", async () => {
    const first = await db.createProjectAnalysisRun({
      id: "slot-1",
      repoKey: "owner/slot-one",
      canonicalUrl: "https://github.com/owner/slot-one",
      requestedRef: null,
      schemaVersion: "ghfind.project-analysis.v1",
      rubricVersion: "project-value-v1",
      agentVersion: "project-evaluator-v1",
      skillVersion: "ghfind-project-evaluator-v1",
    });
    const second = await db.createProjectAnalysisRun({
      id: "slot-2",
      repoKey: "owner/slot-two",
      canonicalUrl: "https://github.com/owner/slot-two",
      requestedRef: null,
      schemaVersion: "ghfind.project-analysis.v1",
      rubricVersion: "project-value-v1",
      agentVersion: "project-evaluator-v1",
      skillVersion: "ghfind-project-evaluator-v1",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);

    await expect(db.reserveProjectAnalysisExecutionSlot("slot-1", 1)).resolves.toBe(true);
    await expect(db.reserveProjectAnalysisExecutionSlot("slot-2", 1)).resolves.toBe(false);
    await db.failProjectAnalysis("slot-1", "test_complete", "Test slot released.");
    await expect(db.reserveProjectAnalysisExecutionSlot("slot-2", 1)).resolves.toBe(true);
    await db.failProjectAnalysis("slot-2", "test_complete", "Test slot released.");
  });

  it("releases a creation slot while a retry is backing off", async () => {
    await db.createProjectAnalysisRun({
      id: "retry-slot-1",
      repoKey: "owner/retry-slot-one",
      canonicalUrl: "https://github.com/owner/retry-slot-one",
      requestedRef: null,
      schemaVersion: "ghfind.project-analysis.v1",
      rubricVersion: "project-value-v1",
      agentVersion: "project-evaluator-v1",
      skillVersion: "ghfind-project-evaluator-v1",
    });
    await db.createProjectAnalysisRun({
      id: "retry-slot-2",
      repoKey: "owner/retry-slot-two",
      canonicalUrl: "https://github.com/owner/retry-slot-two",
      requestedRef: null,
      schemaVersion: "ghfind.project-analysis.v1",
      rubricVersion: "project-value-v1",
      agentVersion: "project-evaluator-v1",
      skillVersion: "ghfind-project-evaluator-v1",
    });

    await expect(db.reserveProjectAnalysisExecutionSlot("retry-slot-1", 1)).resolves.toBe(true);
    const scheduled = await db.scheduleProjectAnalysisCreateRetry(
      "retry-slot-1",
      Date.now() + 60_000,
    );
    expect(scheduled).toMatchObject({
      status: "queued",
      createAttempts: 1,
    });
    expect(scheduled?.createRetryAt).toBeGreaterThan(Date.now());
    await expect(db.reserveProjectAnalysisExecutionSlot("retry-slot-1", 1)).resolves.toBe(false);
    await expect(db.reserveProjectAnalysisExecutionSlot("retry-slot-2", 1)).resolves.toBe(true);
    await db.failProjectAnalysis("retry-slot-1", "test_complete", "Test retry completed.");
    await db.failProjectAnalysis("retry-slot-2", "test_complete", "Test slot released.");
  });

  it("removes an active treasure while preserving its discovery record", async () => {
    const removed = await db.removeTreasureProject(
      "owner/useful-tool",
      "Evidence was superseded during manual review.",
    );
    expect(removed).toBe(false);

    const created = await db.createProjectAnalysisRun({
      id: "analysis-3",
      repoKey: "owner/another-treasure",
      canonicalUrl: "https://github.com/owner/another-treasure",
      requestedRef: null,
      schemaVersion: "ghfind.project-analysis.v1",
      rubricVersion: "project-value-v1",
      agentVersion: "project-evaluator-v1",
      skillVersion: "ghfind-project-evaluator-v1",
    });
    expect(created.created).toBe(true);
    const treasure = {
      ...(validProjectAnalysis as ProjectAnalysisArtifact),
      analysis_id: "analysis-3",
      repository: {
        ...(validProjectAnalysis as ProjectAnalysisArtifact).repository,
        repo_key: "owner/another-treasure",
        canonical_url: "https://github.com/owner/another-treasure",
      },
    };
    const treasureEvidence = {
      ...validRuntimeEvidence,
      analysis_id: "analysis-3",
      repo_key: "owner/another-treasure",
    };
    await db.finalizeProjectAnalysis({
      analysisId: "analysis-3",
      analysis: treasure,
      analysisJson: JSON.stringify(treasure),
      evidenceJson: JSON.stringify(treasureEvidence),
      reportMarkdown: "# Another Treasure",
      hashes: { analysis: "a3", evidence: "e3", report: "r3" },
    });

    await expect(
      db.removeTreasureProject(
        "owner/another-treasure",
        "Evidence was superseded during manual review.",
      ),
    ).resolves.toBe(true);
    await expect(db.listProjectBoard("treasure", { limit: 20, offset: 0 })).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repoKey: "owner/another-treasure" }),
      ]),
    );
    await expect(db.listTreasureHistory("owner/another-treasure")).resolves.toMatchObject([
      {
        status: "removed",
        removedReason: "Evidence was superseded during manual review.",
      },
    ]);

    await db.createProjectAnalysisRun({
      id: "analysis-4",
      repoKey: "owner/another-treasure",
      canonicalUrl: "https://github.com/owner/another-treasure",
      requestedRef: "main",
      schemaVersion: "ghfind.project-analysis.v1",
      rubricVersion: "project-value-v1",
      agentVersion: "project-evaluator-v1",
      skillVersion: "ghfind-project-evaluator-v1",
    });
    const reevaluated = {
      ...treasure,
      analysis_id: "analysis-4",
      repository: { ...treasure.repository, requested_ref: "main" },
    };
    await db.finalizeProjectAnalysis({
      analysisId: "analysis-4",
      analysis: reevaluated,
      analysisJson: JSON.stringify(reevaluated),
      evidenceJson: JSON.stringify({ ...treasureEvidence, analysis_id: "analysis-4" }),
      reportMarkdown: "# Another Treasure, Re-evaluated",
      hashes: { analysis: "a4", evidence: "e4", report: "r4" },
    });
    await expect(db.listTreasureHistory("owner/another-treasure")).resolves.toMatchObject([
      { status: "active" },
      { status: "removed" },
    ]);
  });
});
