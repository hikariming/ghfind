import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("backend extraction runbook", () => {
  it("treats missing backend origin as fail-closed containment, not rollback", () => {
    const runbook = readFileSync("docs/operations/go-backend-runbook.md", "utf8");

    expect(runbook).toContain("Emergency fail-closed containment");
    expect(runbook).toMatch(/not a\s+functional rollback/);
    expect(runbook).toContain("Vercel release rollback");
    expect(runbook).not.toContain("restores the existing Next handler");
  });

  it("documents executable staging resilience evidence", () => {
    const runbook = readFileSync("docs/operations/go-backend-runbook.md", "utf8");
    const smoke = readFileSync("docs/releases/deployment-smoke.md", "utf8");

    for (const document of [runbook, smoke]) {
      expect(document).toContain("pnpm smoke:backend:resilience");
      expect(document).toContain("SMOKE_REQUIRE_RETRY_EVIDENCE=1");
      expect(document).toContain("SMOKE_REQUIRE_DLQ_EVIDENCE=1");
      expect(document).toContain("SMOKE_REQUIRE_RESTART_EVIDENCE=1");
    }
  });

  it("ships alert rules for the extracted backend", () => {
    const runbook = readFileSync("docs/operations/go-backend-runbook.md", "utf8");
    const smoke = readFileSync("docs/releases/deployment-smoke.md", "utf8");
    const alerts = readFileSync("docs/operations/backend-alerts.prometheus.yml", "utf8");

    expect(runbook).toContain("backend-alerts.prometheus.yml");
    expect(smoke).toContain("backend-alerts.prometheus.yml");
    expect(alerts).toContain("GhfindBackendPublishFailures");
    expect(alerts).toContain("GhfindWorkerDeadLetteredJobs");
    expect(alerts).toContain('rabbitmq_queue_messages{queue="ghfind.scan.quick.v1"}');
  });
});
