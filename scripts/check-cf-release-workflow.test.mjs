import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const checker = resolve('scripts/check-cf-release-workflow.mts');
const originals = Object.fromEntries(['ci.yml', 'deploy-cf-production.yml', 'feed-catalog-reconcile.yml', 'cost-monitor.yml', 'deploy-apps-production.yml'].map(name => [name, readFileSync(`.github/workflows/${name}`, 'utf8')]));
function check(change = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'feed-workflow-contract-'));
  try {
    const directory = join(temporary, '.github/workflows'); mkdirSync(directory, { recursive: true });
    for (const [name, content] of Object.entries(originals)) writeFileSync(join(directory, name), change[name] ?? content);
    return execFileSync(process.execPath, ['--experimental-strip-types', checker], { cwd: temporary, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

test('current exact-checkout CI, direct production and containment gates satisfy the workflow contract', () => {
  assert.match(check(), /workflow contract passed/);
});

test('bot release cannot precede SCORE, use a stale SHA, skip migrations or escape serialization', () => {
  const production = originals['deploy-cf-production.yml'];
  const begin = production.indexOf('\n  deploy-bot:\n');
  for (const fragment of ['needs: [deploy]', 'environment: Production', 'group: ghfind-bot-production',
    'cancel-in-progress: false', 'ref: ${{ github.event.workflow_run.head_sha }}',
    'if [ "$current_main" != "$RELEASE_SHA" ]; then', 'pnpm exec wrangler d1 migrations apply ghfind-bot --remote --env production',
    "github.event.workflow_run.event == 'push'"]) {
    const unsafe = production.slice(0, begin) + production.slice(begin).replace(fragment, 'removed');
    assert.throws(() => check({ 'deploy-cf-production.yml': unsafe }), /Bot production gate/);
  }
  const unsafe = production.slice(0, begin) + production.slice(begin).replace('    needs: [deploy]', '    needs: [deploy]\n    continue-on-error: true');
  assert.throws(() => check({ 'deploy-cf-production.yml': unsafe }), /Bot must wait/);
});

test('gate text elsewhere does not compensate for a production job that lost its dependency or environment', () => {
  for (const removed of ['    needs: [authorize]\n', '    environment: Production\n']) {
    const content = originals['deploy-cf-production.yml'].replace(removed, '') + `\n# Documentation only: ${removed.trim()}\n`;
    assert.throws(() => check({ 'deploy-cf-production.yml': content }));
  }
});

test('a job using default checkout or missing a receipt cannot borrow another job checkout evidence', () => {
  const ci = originals['ci.yml'];
  const begin = ci.indexOf('\n  feed-contracts:\n');
  const end = ci.indexOf('\n  feed-runtime:\n');
  for (const removed of ['          ref: ${{ github.sha }}\n', '        run: node scripts/feed-ci-evidence.mjs record-job feed-contracts "$RUNNER_TEMP/feed-contracts.json"\n']) {
    const content = ci.slice(0, begin) + ci.slice(begin, end).replace(removed, '') + ci.slice(end);
    assert.throws(() => check({ 'ci.yml': content }));
  }
});

test('optional E2E and broad inherited production secrets are rejected', () => {
  const ci = originals['ci.yml'].replace('    name: Complete local Feed E2E\n', '    name: Complete local Feed E2E\n    continue-on-error: true\n');
  assert.throws(() => check({ 'ci.yml': ci }));
  const production = originals['deploy-cf-production.yml'].replace('    needs: [authorize]\n', '    needs: [authorize]\n    secrets: inherit\n');
  assert.throws(() => check({ 'deploy-cf-production.yml': production }));
});

test('private runtime rollout stays immediate after the existing Go gateway pause', () => {
  const production = originals['deploy-cf-production.yml'];
  for (const replacement of ['', '--containers-rollout=none']) {
    assert.throws(() => check({ 'deploy-cf-production.yml': production.replace('--containers-rollout=immediate', replacement) }));
  }
  assert.throws(() => check({ 'deploy-cf-production.yml': production.replace('Pause an already active Go gateway', 'Missing pre-update pause') }));
});

test('public production smoke checks the canonical custom domain even through workers.dev', () => {
  const production = originals['deploy-cf-production.yml'];
  for (const replacement of ['', '          SMOKE_EXPECTED_ORIGIN: https://ghfind.beiming1201.workers.dev\n']) {
    assert.throws(() => check({ 'deploy-cf-production.yml': production.replace('          SMOKE_EXPECTED_ORIGIN: https://ghfind.com\n', replacement) }));
  }
  const misplaced = production.replace('          SMOKE_EXPECTED_ORIGIN: https://ghfind.com\n', '')
    .replace('    env:\n', '    env:\n      SMOKE_EXPECTED_ORIGIN: https://ghfind.com\n');
  assert.throws(() => check({ 'deploy-cf-production.yml': misplaced }));
});

test('each runtime deployment captures and verifies its own preceding application identities', () => {
  const production = originals['deploy-cf-production.yml'];
  for (const mode of ['off', 'baseline']) {
    const capture = `          node scripts/feed-platform-production.mjs snapshot ops/feed-production-manifest.json "$RUNNER_TEMP/feed-production-evidence/applications-before-${mode}.json"\n`;
    assert.throws(() => check({ 'deploy-cf-production.yml': production.replace(capture, '') }));
    assert.throws(() => check({ 'deploy-cf-production.yml': production.replace(capture, '').replace('          sleep 130\n', `          sleep 130\n${capture}`) }));
    const verify = ` ${mode} "$RUNNER_TEMP/feed-production-evidence/runtime-${mode}.json" "$RUNNER_TEMP/feed-production-evidence/applications-before-${mode}.json"`;
    assert.throws(() => check({ 'deploy-cf-production.yml': production.replace(verify, ` ${mode} "$RUNNER_TEMP/feed-production-evidence/runtime-${mode}.json"`) }));
  }
});

test('cancelled or incomplete cutover cannot escape containment after admission begins', () => {
  const original=originals['deploy-cf-production.yml'];
  for(const replacement of ['failure()', 'cancelled()'])
    assert.throws(()=>check({'deploy-cf-production.yml': original.replace('always() && steps.paused',replacement+' && steps.paused')}));
  assert.throws(()=>check({'deploy-cf-production.yml':original.replace("steps.smoke.outcome != 'success'", "steps.smoke.outcome == 'failure'")}));
  assert.throws(()=>check({'deploy-cf-production.yml':original.replace('          echo "started=true" >> "$GITHUB_OUTPUT"','          true')}));
});

test('a configured image identity does not replace inspection of both compiled entrypoints', () => {
  const original=originals['deploy-cf-production.yml'];
  for(const fragment of ['--build-arg IMAGE_BUILD_ID="$FEED_IMAGE_BUILD_ID"','--entrypoint /usr/local/bin/feed-worker','node scripts/feed-image-proof.mjs "$image_ref"'])
    assert.throws(()=>check({'deploy-cf-production.yml':original.replace(fragment,'')}));
});


test('baseline cannot replace native mode transition with an idle wait or move it after readiness', () => {
  const production = originals['deploy-cf-production.yml'];
  assert.throws(() => check({'deploy-cf-production.yml':production.replace('420s node scripts/feed-production-transition.mjs','420s node missing-transition.mjs')}));
  assert.throws(() => check({'deploy-cf-production.yml':production.replace('          # Explicitly stop and restart','          sleep 130\n          # Explicitly stop and restart')}));
  assert.throws(() => check({'deploy-cf-production.yml':production.replace('      FEED_ASSESSMENT_CARRYOVER: ops/feed-production-assessment-carryover.json\n','')}));
});

test('completed assessment requires source preflight and projection after baseline without paid operations', () => {
  const production = originals['deploy-cf-production.yml'];
  for (const fragment of ['Verify completed assessment source before deployment', 'ops/feed-production-assessment-checkpoint.json', 'Verify completed assessment and current durable projection'])
    assert.throws(() => check({'deploy-cf-production.yml': production.replaceAll(fragment, 'removed')}));
  for (const suffix of [' --source-only', ' || true'])
    assert.throws(() => check({'deploy-cf-production.yml': production.replace('assessment-result.json"', 'assessment-result.json"' + suffix)}));
  for (const command of ['node scripts/feed-production-assessment.mjs start', 'node scripts/feed-production-assessment-operator.mjs', 'node scripts/feed-production-assessment-recovery.mjs'])
    assert.throws(() => check({'deploy-cf-production.yml': production.replace('      - name: Build the real Web', '          '+command+'\n      - name: Build the real Web')}));
  assert.throws(() => check({'deploy-cf-production.yml': production.replace('      - name: Verify completed assessment and current durable projection\n', '      - name: Verify completed assessment and current durable projection\n        if: always()\n')}));
  const a = production.indexOf('      - name: Activate executor');
  const b = production.indexOf('      - name: Verify completed assessment and current durable projection');
  const c = production.indexOf('      - name: Verify bounded authenticated');
  assert.throws(() => check({'deploy-cf-production.yml': production.slice(0,a) + production.slice(b,c) + production.slice(a,b) + production.slice(c)}));
});

test('provider failure cannot strand the new public Web without its build cache', () => {
  const production=originals['deploy-cf-production.yml'];
  assert.throws(()=>check({'deploy-cf-production.yml':production.replace('Populate new build cache before replacing the public Web','Missing early cache')}));
  const command='run: node node_modules/@opennextjs/cloudflare/dist/cli/index.js populateCache remote --config platform/runtime/wrangler.web.production.generated.json --cacheChunkSize 10';
  assert.throws(()=>check({'deploy-cf-production.yml':production.replace(command,'run: true')}));
});

test('off process replacement cannot bypass pause evidence, deployment or readiness', () => {
  const production=originals['deploy-cf-production.yml'];
  for (const part of ['240s node scripts/feed-production-off-transition.mjs', 'consumer-pause.json" "$RUNNER_TEMP/feed-production-evidence/off-transition.json"'])
    assert.throws(()=>check({'deploy-cf-production.yml':production.replace(part,'removed')}));
  assert.throws(()=>check({'deploy-cf-production.yml':production.replace('off-transition.json"','off-transition.json" || true')}));
});

test("off restart requires bounded platform rollout completion", () => {
  assert.throws(() => check({"deploy-cf-production.yml": originals["deploy-cf-production.yml"].replace("310s node scripts/feed-production-rollout.mjs", "310s node scripts/removed.mjs")}));
});

test('superseded release guards protect every following deployment step',()=>{
 for(const name of ['deploy-cf-production.yml','cost-monitor.yml','deploy-apps-production.yml']){
  const content=originals[name].replace("        if: steps.current.outputs.current == 'true'\n",'');
  assert.throws(()=>check({[name]:content}),/unguarded post-authorization step/);
 }
});
