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
  "uses: ./.github/workflows/feed-staging.yml",
  "needs: [staging, staging-evidence]",
  "environment: Production",
  'node scripts/feed-ci-evidence.mjs verify-ci-remote "$RELEASE_SHA" "$RUNNER_TEMP/feed-ci-evidence.json"',
  'node scripts/feed-platform-staging-evidence.mjs verify "$RUNNER_TEMP/feed-staging-acceptance/feed-staging-evidence.json" "$RELEASE_SHA" "$EXPECTED_EVIDENCE_SHA256"',
  "needs.staging.outputs.evidence_artifact",
  "needs.staging.outputs.evidence_sha256",
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

// Check job ownership as well as token presence: a correct-looking guard in a
// comment or another job must not authorize production deployment.
function jobBody(source: string, job: string): string {
  const jobs = source.slice(source.indexOf("\njobs:\n"));
  const match = new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|$(?![\\s\\S]))`, "m").exec(jobs);
  if (!match) throw new Error(`Required workflow job ${job} absent`);
  return match[1].split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
}
const deployJob = jobBody(workflow, "deploy");
for (const fragment of ["needs: [staging, staging-evidence]", "environment: Production", "ref: ${{ github.event.workflow_run.head_sha }}"]) {
  if (!deployJob.includes(fragment)) throw new Error(`Production job itself must require ${fragment}`);
}
if (workflow.includes("secrets: inherit")) throw new Error("Staging must use its dedicated environment, not inherited production credentials.");
if (/FEED_BACKEND:\s*["']?go/m.test(workflow)) throw new Error("This release phase cannot activate Go production traffic.");

const ciPath = resolve(process.cwd(), ".github/workflows/ci.yml");
const ci = readFileSync(ciPath, "utf8");
for (const fragment of ["pull_request:", 'branches: [dev, main, "codex/feed-**"]', 'needs: [verify, feed-contracts, feed-runtime, feed-e2e]', 'CI_JOB_RESULTS: ${{ toJSON(needs) }}']) {
  if (!ci.includes(fragment)) throw new Error(`Exact-checkout CI contract missing ${fragment}`);
}
for (const id of ["verify", "feed-contracts", "feed-runtime", "feed-e2e", "release-verify"]) {
  const job = jobBody(ci, id);
  if (!job.includes("ref: ${{ github.sha }}") || !job.includes("persist-credentials: false")) throw new Error(`${id} must check out the actual event SHA without persisted credentials`);
  if (id !== "release-verify" && !job.includes(`record-job ${id}`)) throw new Error(`${id} must record its actual checkout after its checks pass`);
}
const e2eJob = jobBody(ci, "feed-e2e");
if (!e2eJob.includes('python3 scripts/run-feed-e2e.py --release-sha "$GITHUB_SHA" --directory "$RUNNER_TEMP/feed-complete-e2e" --execute')) throw new Error("Complete dual-profile E2E must execute in its mandatory job.");
if (/continue-on-error:\s*true/.test(e2eJob)) throw new Error("Complete E2E must not continue on error.");
const gateJob = jobBody(ci, "release-verify");
if (!gateJob.includes('node scripts/feed-ci-evidence.mjs aggregate') || !gateJob.includes('if: always()')) throw new Error("CI aggregation must validate failed/skipped dependencies and exact checkout receipts.");
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
