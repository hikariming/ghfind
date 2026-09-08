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
  "Apply and verify production D1 migrations",
  'node scripts/feed-platform-schema-release.mjs production "$RUNNER_TEMP/approved-application-schema"',
  'wrangler d1 migrations apply ghfind --remote --config "$release_config"',
  'wrangler d1 migrations apply ghfind-feed --remote --config "$release_config"',
  "wrangler d1 execute ghfind --remote --env production --json",
  "wrangler d1 execute ghfind-feed --remote --env production --json",
  "score_release_fallbacks",
  "wrangler rollback",
  "steps.release.outputs.previous_version",
  "steps.deploy.outcome == 'failure'",
  "steps.active.outcome == 'failure'",
  "steps.smoke.outcome == 'failure'",
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

if (workflow.includes('test "$previous_author" = "beiming1201@gmail.com"')) {
  throw new Error(
    "Do not use Cloudflare author_email as the production account gate; validate the pinned account ID instead.",
  );
}

if (!workflow.includes("Previous active author (audit metadata only)")) {
  throw new Error(
    "Production release must label Cloudflare author_email as audit metadata only.",
  );
}

const unescapedSummaryInterpolation = /echo\s+"[^"\n]*?(?<!\\)`\$[A-Za-z_][A-Za-z0-9_]*`/;
if (unescapedSummaryInterpolation.test(workflow)) {
  throw new Error(
    "Cloudflare release summary must escape Markdown backticks so shell does not execute interpolated values.",
  );
}

console.log(`Cloudflare release workflow contract passed (${workflowPath})`);

const reconcileWorkflowPath = resolve(
  process.cwd(),
  ".github/workflows/feed-catalog-reconcile.yml",
);
const reconcileWorkflow = readFileSync(reconcileWorkflowPath, "utf8");
const requiredReconcileFragments = [
  "workflow_dispatch:",
  "bootstrap_credential:",
  "page_limit:",
  "max_pages:",
  "updated_at:",
  "repo_key:",
  "github.repository == 'hikariming/ghfind'",
  "FEED_ADMIN_SECRET: ${{ secrets.FEED_ADMIN_SECRET }}",
  "CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}",
  "wrangler secret put FEED_ADMIN_SECRET --env production",
  "https://ghfind.com/api/internal/feed/reconcile",
  'if [ "$MAX_PAGES" -lt 1 ] || [ "$MAX_PAGES" -gt 4 ]; then',
  'if [ "$PAGE_LIMIT" -lt 1 ] || [ "$PAGE_LIMIT" -gt 100 ]; then',
  "--data-urlencode \"updatedAt=$updated_at\"",
  "--data-urlencode \"repoKey=$repo_key\"",
];

for (const fragment of requiredReconcileFragments) {
  if (!reconcileWorkflow.includes(fragment)) {
    throw new Error(`Feed reconciliation workflow is missing: ${fragment}`);
  }
}

if (/^\s+(push|schedule|workflow_run):/m.test(reconcileWorkflow)) {
  throw new Error(
    "Feed reconciliation must remain an explicit workflow_dispatch operation, not an automatic or scheduled scan.",
  );
}

console.log(`Feed reconciliation workflow contract passed (${reconcileWorkflowPath})`);
