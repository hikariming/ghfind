import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const checker = resolve('scripts/check-cf-release-workflow.mts');
const originals = Object.fromEntries(['ci.yml', 'deploy-cf-production.yml', 'feed-catalog-reconcile.yml'].map(name => [name, readFileSync(`.github/workflows/${name}`, 'utf8')]));
function check(change = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'feed-workflow-contract-'));
  try {
    const directory = join(temporary, '.github/workflows'); mkdirSync(directory, { recursive: true });
    for (const [name, content] of Object.entries(originals)) writeFileSync(join(directory, name), change[name] ?? content);
    return execFileSync(process.execPath, ['--experimental-strip-types', checker], { cwd: temporary, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

test('current exact-checkout CI, reusable staging and Production gates satisfy the workflow contract', () => {
  assert.match(check(), /workflow contract passed/);
});

test('gate text elsewhere does not compensate for a production job that lost its dependency or environment', () => {
  for (const removed of ['    needs: [staging, staging-evidence]\n', '    environment: Production\n']) {
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
  const production = originals['deploy-cf-production.yml'].replace('    uses: ./.github/workflows/feed-staging.yml\n', '    uses: ./.github/workflows/feed-staging.yml\n    secrets: inherit\n');
  assert.throws(() => check({ 'deploy-cf-production.yml': production }));
});
