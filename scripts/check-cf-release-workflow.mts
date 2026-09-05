import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflowPath = resolve(
  process.cwd(),
  ".github/workflows/deploy-cf-production.yml",
);
const workflow = readFileSync(workflowPath, "utf8");

const requiredFragments = [
  'workflow_run:',
  'workflows: ["CI"]',
  "types: [completed]",
  "branches: [main]",
  "github.repository == 'hikariming/ghfind'",
  "github.event.workflow_run.conclusion == 'success'",
  "github.event.workflow_run.event == 'push'",
  "github.event.workflow_run.head_branch == 'main'",
  "github.event.workflow_run.repository.full_name == 'hikariming/ghfind'",
  "ref: ${{ github.event.workflow_run.head_sha }}",
  "persist-credentials: false",
  "cancel-in-progress: false",
  "EXPECTED_ACCOUNT_ID: 8f19bebe359e4ec1a24c68c5f49c1584",
  "CF_VERSION_TAG: main-${{ github.event.workflow_run.head_sha }}",
  "CF_VERSION_MESSAGE: release-${{ github.event.workflow_run.head_sha }}-from-upstream-main",
  "secrets.CF_API_TOKEN",
  "wrangler deployments status",
  "wrangler rollback",
  "steps.release.outputs.previous_version",
  "id: rollback_smoke",
];

for (const fragment of requiredFragments) {
  if (!workflow.includes(fragment)) {
    throw new Error(`Cloudflare release workflow is missing: ${fragment}`);
  }
}

if (/^  push:/m.test(workflow) || /^  workflow_dispatch:/m.test(workflow)) {
  throw new Error(
    "Production deploy must remain workflow_run-only; do not add a direct trigger.",
  );
}

console.log(`Cloudflare release workflow contract passed (${workflowPath})`);
