import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Cloudflare Worker operations contract", () => {
  const runbook = readFileSync("docs/operations/cloudflare-worker-runbook.md", "utf8");
  const smoke = readFileSync("docs/releases/deployment-smoke.md", "utf8");
  const workflow = readFileSync(".github/workflows/deploy-production.yml", "utf8");

  it("documents Wrangler as the only production deployment surface", () => {
    expect(runbook).toContain("wrangler.jsonc");
    expect(runbook).toContain("pnpm cf:deploy:prod");
    expect(runbook).toContain("pnpm exec wrangler rollback <healthy-version-id>");
    expect(runbook).not.toContain("GHFIND_BACKEND_ORIGIN");
  });

  it("keeps the deployment smoke on public Worker contracts", () => {
    expect(smoke).toContain("pnpm smoke:deployment");
    expect(smoke).toContain("OpenNext Worker");
    expect(smoke).not.toContain("SMOKE_BACKEND_BASE_URL");
    expect(smoke).not.toContain("SMOKE_WORKER_METRICS_BASE_URL");
  });

  it("deploys and smokes the Worker from main", () => {
    expect(workflow).toContain("CLOUDFLARE_API_TOKEN");
    expect(workflow).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(workflow).toContain("pnpm cf:deploy:prod");
    expect(workflow).toContain("pnpm smoke:deployment");
    expect(workflow).not.toContain("RAILWAY_TOKEN");
    expect(workflow).not.toContain("VERCEL_TOKEN");
  });
});
