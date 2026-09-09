import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflowPath = resolve(
  process.cwd(),
  ".github/workflows/deploy-cf-production.yml",
);
const workflow = readFileSync(workflowPath, "utf8");

// The user explicitly replaced the staging prerequisite with direct production.
// Retain exact-CI authorization, serialized resources, authenticated actual
// Container identity, and Go-compatible containment instead of legacy rollback.
function jobBody(source: string, job: string): string {
  const jobs = source.slice(source.indexOf("\njobs:\n"));
  const match = new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|$(?![\\s\\S]))`, "m").exec(jobs);
  if (!match) throw new Error(`Required workflow job ${job} absent`);
  return match[1].split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
}
const authorization = jobBody(workflow, "authorize");
const deployJob = jobBody(workflow, "deploy");
for (const fragment of ['workflow_run:', 'workflows: ["CI"]', 'types: [completed]', 'branches: [main]', 'cancel-in-progress: false']) {
  if (!workflow.includes(fragment)) throw new Error(`Production trigger missing ${fragment}`);
}
for (const fragment of ["github.repository == 'hikariming/ghfind'", "github.event.workflow_run.conclusion == 'success'", "github.event.workflow_run.event == 'push'", "github.event.workflow_run.head_branch == 'main'", "github.event.workflow_run.repository.full_name == 'hikariming/ghfind'", 'node scripts/feed-ci-evidence.mjs verify-ci-remote', 'node scripts/feed-github-protection.mjs --verify-existing']) {
  if (!authorization.includes(fragment)) throw new Error(`Authorization missing ${fragment}`);
}
for (const job of [authorization,deployJob]) for (const fragment of ['ref: ${{ github.event.workflow_run.head_sha }}','persist-credentials: false']) {
  if (!job.includes(fragment)) throw new Error(`Exact checkout missing ${fragment}`);
}
for (const fragment of ['needs: [authorize]', 'environment: Production', 'EXPECTED_ACCOUNT_ID: 8f19bebe359e4ec1a24c68c5f49c1584', 'secrets.CF_API_TOKEN', 'gh api repos/hikariming/ghfind/git/ref/heads/main', 'node scripts/feed-production-release.mjs schema', 'wrangler d1 migrations apply ghfind --remote --config', 'wrangler d1 migrations apply ghfind-feed --remote --config', 'node scripts/feed-platform-production.mjs verify', 'runtime-off.json', 'runtime-baseline.json', 'node scripts/feed-production-release.mjs web-verify', 'web-paused.json', 'web-all.json', 'steps.paused.outputs.version', 'pnpm smoke:deployment']) {
  if (!deployJob.includes(fragment)) throw new Error(`Production job missing ${fragment}`);
}
const order = ['Build and push the portable image','Apply and verify explicitly approved','Detach only the owned consumers','Deploy private adapter and off-mode','Install a compatible paused gateway','Start or resume the single real production assessment','Activate executor and verify actual baseline','Require real assessment finalization and durable queue projection','Verify bounded authenticated Go service contracts','Cut all Feed requests'];
for (let i=1;i<order.length;i++) if(deployJob.indexOf(order[i])<=deployJob.indexOf(order[i-1])) throw new Error('Unsafe deployment ordering');
if (/^  (push|workflow_dispatch):/m.test(workflow) || workflow.includes('secrets: inherit') || deployJob.includes('previous_version') || /continue-on-error:\s*true/.test(deployJob)) throw new Error('Unsafe bypass, inherited secrets, legacy rollback or optional production gate');

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
