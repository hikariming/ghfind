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
const botJob = jobBody(workflow, "deploy-bot");
for (const fragment of ['needs: [deploy]', 'environment: Production',
  'group: ghfind-bot-production', 'cancel-in-progress: false',
  "github.repository == 'hikariming/ghfind'", "github.event.workflow_run.conclusion == 'success'",
  "github.event.workflow_run.event == 'push'", "github.event.workflow_run.head_branch == 'main'",
  "github.event.workflow_run.repository.full_name == 'hikariming/ghfind'",
  'ref: ${{ github.event.workflow_run.head_sha }}', 'persist-credentials: false',
  'RELEASE_SHA: ${{ github.event.workflow_run.head_sha }}',
  'test "$(git rev-parse HEAD)" = "$RELEASE_SHA"',
  'git ls-remote origin refs/heads/main', 'if [ "$current_main" != "$RELEASE_SHA" ]; then',
  'pnpm exec wrangler d1 migrations apply ghfind-bot --remote --env production',
  'pnpm exec wrangler deploy --env production --tag "production-$RELEASE_SHA"']) {
  if (!botJob.includes(fragment)) throw new Error(`Bot production gate missing ${fragment}`);
}
if (/always\(\)|continue-on-error:\s*true/.test(botJob))
  throw new Error('Bot must wait for a successful legacy SCORE deployment');
const botOrder = ['Require exact current main', 'wrangler d1 migrations apply ghfind-bot', 'wrangler deploy --env production'];
for (let i = 1; i < botOrder.length; i++)
  if (botJob.indexOf(botOrder[i]) <= botJob.indexOf(botOrder[i - 1])) throw new Error('Unsafe bot deployment ordering');
for (const fragment of ['workflow_run:', 'workflows: ["CI"]', 'types: [completed]', 'branches: [main]', 'cancel-in-progress: false']) {
  if (!workflow.includes(fragment)) throw new Error(`Production trigger missing ${fragment}`);
}
for (const fragment of ["github.repository == 'hikariming/ghfind'", "github.event.workflow_run.conclusion == 'success'", "github.event.workflow_run.event == 'push'", "github.event.workflow_run.head_branch == 'main'", "github.event.workflow_run.repository.full_name == 'hikariming/ghfind'", 'node scripts/feed-ci-evidence.mjs verify-ci-remote', 'node scripts/feed-github-protection.mjs --verify-existing']) {
  if (!authorization.includes(fragment)) throw new Error(`Authorization missing ${fragment}`);
}
for (const job of [authorization,deployJob]) for (const fragment of ['ref: ${{ github.event.workflow_run.head_sha }}','persist-credentials: false']) {
  if (!job.includes(fragment)) throw new Error(`Exact checkout missing ${fragment}`);
}
for (const fragment of ['needs: [authorize]', 'environment: Production', 'EXPECTED_ACCOUNT_ID: 8f19bebe359e4ec1a24c68c5f49c1584', 'secrets.CF_API_TOKEN', 'gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main"', 'node scripts/feed-production-release.mjs schema', 'wrangler d1 migrations apply ghfind --remote --config', 'wrangler d1 migrations apply ghfind-feed --remote --config', 'node scripts/feed-platform-production.mjs verify', 'runtime-off.json', 'runtime-baseline.json', 'node scripts/feed-production-release.mjs web-verify', 'web-paused.json', 'web-all.json', 'steps.paused.outputs.version', 'pnpm smoke:deployment']) {
  if (!deployJob.includes(fragment)) throw new Error(`Production job missing ${fragment}`);
}
const order = ['Build and push the portable image','Apply and verify explicitly approved','Pause an already active Go gateway','Detach only the owned consumers','Deploy private adapter and off-mode','Install a compatible paused gateway','Activate executor and verify actual baseline','Verify completed assessment and current durable projection','Verify bounded authenticated Go service contracts','Cut all Feed requests'];
for (let i=1;i<order.length;i++) if(deployJob.indexOf(order[i])<=deployJob.indexOf(order[i-1])) throw new Error('Unsafe deployment ordering');
// Traffic is already legacy or Go-paused. Replace the private fleet in one
// platform rollout step, but retain all actual readiness/instance gates.
const runtimeDeploys = deployJob.split('\n').filter(line => line.includes('wrangler deploy --config platform/runtime/wrangler.production.generated.json'));
if (runtimeDeploys.length !== 2 || runtimeDeploys.some(line => !line.includes('--containers-rollout=immediate'))) throw new Error('Paused production runtime requires explicit immediate Container rollout');
const offStep = /      - name: Deploy private adapter and off-mode[^\n]*\n([\s\S]*?)(?=      - name:)/.exec(deployJob)?.[1] ?? '';
const offTransition = offStep.indexOf('240s node scripts/feed-production-off-transition.mjs');
const offRollout = offStep.indexOf('310s node scripts/feed-production-rollout.mjs');
if (offRollout < offStep.indexOf('wrangler deploy --config platform/runtime/wrangler.production.generated.json') ||
    offRollout < 0 || offRollout >= offTransition || !offStep.includes('applications-before-off.json\" \"$RUNNER_TEMP/feed-production-evidence/off-rollout.json\"'))
  throw new Error('Off restart requires completed image rollout evidence before lifecycle mutation');
if (offTransition < offStep.indexOf('wrangler deploy --config platform/runtime/wrangler.production.generated.json') ||
    offTransition < 0 || offTransition >= offStep.indexOf('node scripts/feed-platform-production.mjs verify') ||
    !offStep.includes('consumer-pause.json" "$RUNNER_TEMP/feed-production-evidence/off-transition.json"') ||
    /continue-on-error|if:|\|\|/.test(offStep.replace("        if: steps.current.outputs.current == 'true'\n", "")))
  throw new Error('Off process replacement must follow deployment and consumer detachment, and precede full readiness without bypass');
const imageStep = /      - name: Build and push the portable image[^\n]*\n([\s\S]*?)(?=      - name:)/.exec(deployJob)?.[1] ?? '';
for (const fragment of ['openssl rand -hex 32', '--build-arg IMAGE_BUILD_ID="$FEED_IMAGE_BUILD_ID"',
  '--entrypoint /usr/local/bin/feed-api', '--entrypoint /usr/local/bin/feed-worker', '--build-info',
  'node scripts/feed-image-proof.mjs "$image_ref"', 'FEED_IMAGE_BUILD_ID=$FEED_IMAGE_BUILD_ID']) {
  if (!imageStep.includes(fragment)) throw new Error(`Production compiled image proof missing ${fragment}`);
}
const containment = /      - name: Contain failed cutover[^\n]*\n([\s\S]*?)(?=      - name:)/.exec(deployJob)?.[1] ?? '';
if (!containment.includes("always() && steps.paused.outputs.version != '' && steps.admission.outputs.started == 'true' && steps.smoke.outcome != 'success'"))
  throw new Error('Incomplete or cancelled admission must retain Go-only containment');
for (const fragment of ['timeout-minutes: 3', 'timeout --signal=TERM --kill-after=5s 120s',
  'timeout --signal=TERM --kill-after=5s 30s', 'containment-attempt.json', 'attempted_unverified'])
  if (!containment.includes(fragment)) throw new Error(`Containment deadline/evidence missing ${fragment}`);
const admissionAt = deployJob.indexOf('      - name: Record gateway admission intent');
if (admissionAt < 0 || admissionAt >= deployJob.indexOf('      - name: Cut all Feed requests') ||
    !deployJob.slice(admissionAt, deployJob.indexOf('      - name: Cut all Feed requests')).includes('echo "started=true" >> "$GITHUB_OUTPUT"'))
  throw new Error('Gateway admission intent must precede any possible all deployment');
for (const [mode, title] of [['off', 'Deploy private adapter and off-mode candidate by immutable digest'], ['baseline', 'Activate executor and verify actual baseline instances before gateway traffic']]) {
  const step = new RegExp(`      - name: ${title}\\n([\\s\\S]*?)(?=      - name:)`).exec(deployJob)?.[1] ?? '';
  const capture = `node scripts/feed-platform-production.mjs snapshot ops/feed-production-manifest.json "$RUNNER_TEMP/feed-production-evidence/applications-before-${mode}.json"`;
  const verify = ` ${mode} "$RUNNER_TEMP/feed-production-evidence/runtime-${mode}.json" "$RUNNER_TEMP/feed-production-evidence/applications-before-${mode}.json"`;
  const deployAt = step.indexOf('wrangler deploy --config platform/runtime/wrangler.production.generated.json');
  if (!step.includes(capture) || !step.includes(verify) || step.indexOf(capture) >= deployAt || step.indexOf(verify) <= deployAt) throw new Error(`Production ${mode} requires its own predeployment application snapshot`);
}
const baselineStep = /      - name: Activate executor and verify actual baseline[^\n]*\n([\s\S]*?)(?=      - name:)/.exec(deployJob)?.[1] ?? '';
const transitionAt = baselineStep.indexOf('420s node scripts/feed-production-transition.mjs');
if (transitionAt < baselineStep.indexOf('wrangler deploy --config platform/runtime/wrangler.production.generated.json') ||
    transitionAt >= baselineStep.indexOf('node scripts/feed-platform-production.mjs verify') ||
    !baselineStep.includes('mode-transition.json') || baselineStep.includes('sleep 130'))
  throw new Error('Baseline requires explicit bounded native mode transition before strict readiness');
if (!deployJob.includes('FEED_ASSESSMENT_CARRYOVER: ops/feed-production-assessment-carryover.json'))
  throw new Error('Existing first-cutover assessment must retain its explicit predecessor identity');
const publicSmoke = /      - name: Bounded public production smoke\n([\s\S]*?)(?=      - name:)/.exec(deployJob)?.[1] ?? '';
for (const fragment of ['SMOKE_BASE_URL: https://ghfind.beiming1201.workers.dev', 'SMOKE_EXPECTED_ORIGIN: https://ghfind.com', 'run: pnpm smoke:deployment']) {
  if (!publicSmoke.includes(fragment)) throw new Error(`Production smoke must preserve its transport and canonical origin: ${fragment}`);
}
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

const sourceCheckpoint = /      - name: Verify completed assessment source before deployment[^\n]*\n([\s\S]*?)(?=      - name:)/.exec(deployJob)?.[1] ?? '';
const projectionCheckpoint = /      - name: Verify completed assessment and current durable projection[^\n]*\n([\s\S]*?)(?=      - name:)/.exec(deployJob)?.[1] ?? '';
const checkpointCommand = 'node scripts/feed-production-assessment-checkpoint.mjs "$RELEASE_SHA" ops/feed-production-assessment-checkpoint.json ops/feed-production-assessment-carryover.json';
if (!sourceCheckpoint.includes(checkpointCommand) || !sourceCheckpoint.includes('assessment-source.json" --source-only') ||
    !projectionCheckpoint.includes(checkpointCommand) || !projectionCheckpoint.includes('assessment-result.json"') || projectionCheckpoint.includes('--source-only') ||
    /if:|continue-on-error|\|\|/.test((sourceCheckpoint + projectionCheckpoint).replaceAll("        if: steps.current.outputs.current == 'true'\n", "")) ||
    deployJob.indexOf('Verify completed assessment source before deployment') >= deployJob.indexOf('Build the real Web') ||
    /assessment-operator\.mjs|assessment\.mjs (start|operator-window|wait)|assessment-recovery\.mjs/.test(deployJob))
  throw new Error('Completed assessment requires unskippable source preflight and live projection verification without provider mutation or expiring history');

const cachePreflight = deployJob.indexOf('name: Populate new build cache before replacing the public Web');
const firstWebDeploy = deployJob.indexOf('wrangler deploy --config platform/runtime/wrangler.web.production.generated.json');
if (cachePreflight < 0 || cachePreflight >= firstWebDeploy ||
    !deployJob.slice(cachePreflight, firstWebDeploy).includes('populateCache remote --config platform/runtime/wrangler.web.production.generated.json'))
  throw new Error('New build cache must be populated before replacing the public Web');

// Every post-guard step must honor a successful superseded skip.
for(const name of ['deploy-cf-production.yml','cost-monitor.yml','deploy-apps-production.yml']) {
 const source=readFileSync(resolve('.github/workflows',name),'utf8');
 for(const body of source.split(/^  [a-z][a-z0-9-]*:\n/m).slice(1)) {
  const steps=body.split(/^      - /m);let guarded=false;
  for(const step of steps){
   if(step.includes('id: current')){guarded=true;continue;}
   if(guarded&&!step.includes("if: steps.current.outputs.current == 'true'"))throw new Error(`${name}: unguarded post-authorization step`);
  }
 }
}
