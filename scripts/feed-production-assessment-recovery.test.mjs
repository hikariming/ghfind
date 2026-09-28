import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractReceipt, githubReader, mayHaveStarted, recover, repository, startStep, validateContext, workflowPath } from './feed-production-assessment-recovery.mjs';
const sourceSha = 'a'.repeat(40);
const intentId = '11111111-1111-4111-8111-111111111111';
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository, GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF: `${repository}/${workflowPath}@refs/heads/main`, GITHUB_RUN_ID: '20', GITHUB_RUN_ATTEMPT: '1' };
const receipt = changes => ({ format: 'ghfind-production-assessment-intent-v1', sourceSha, origin: 'https://ghfind.beiming1201.workers.dev',
  repository, intentId, phase: 'selected', postIssued: true, analysisId: 'synthetic-analysis', idempotencyKey: 'synthetic-stable-key', ...changes });
function fixture(t, histories = [], currentAttempt = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'ghfind-assessment-recovery-test-')), destination = join(directory, 'assessment-intent.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (runId, attempt = 1) => ({ id: runId, run_attempt: attempt, head_sha: sourceSha, path: workflowPath,
    repository: { full_name: repository }, head_repository: { full_name: repository }, event: 'workflow_run', head_branch: 'main', status: 'completed', created_at: `2026-09-14T01:${String(runId).padStart(2, '0')}:00Z` });
  const current = run(20, currentAttempt), runs = new Map([[20, current]]);
  const responses = new Map(), calls = [];
  const artifactsByRun = new Map();
  let artifactId = 100;
  for (const history of histories) {
    const historySha = history.headSha ?? sourceSha;
    const runId = history.runId ?? 10, attempt = history.attempt ?? 1;
    if (runId !== 20) runs.set(runId, { ...run(runId, Math.max(attempt, runs.get(runId)?.run_attempt ?? 0)), head_sha: historySha });
    responses.set(`/repos/${repository}/actions/runs/${runId}/attempts/${attempt}`, { ...run(runId, attempt), head_sha: historySha, ...history.runChanges });
    const step = history.prestart ? { name: 'Build Web', status: 'completed', conclusion: 'failure' } : { name: startStep, status: 'completed', conclusion: history.skipped ? 'skipped' : 'failure' };
    responses.set(`/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, { total_count: 1, jobs: [{ run_id: runId, head_sha: historySha, steps: [step] }] });
    if (!history.missingArtifact) {
      const bytes = Buffer.from(JSON.stringify(history.receipt ?? receipt()));
      const artifact = { id: ++artifactId, name: `feed-production-${runId}-${attempt}`, expired: false,
        workflow_run: { id: runId, head_sha: historySha }, created_at: history.createdAt ?? `2026-09-09T12:${String(runId + attempt).padStart(2, '0')}:00Z`,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, ...history.artifactChanges };
      const artifacts = artifactsByRun.get(runId) ?? []; artifacts.push(artifact); artifactsByRun.set(runId, artifacts);
      responses.set(`/repos/${repository}/actions/artifacts/${artifact.id}/zip`, bytes);
    }
  }
  responses.set(`/repos/${repository}/actions/workflows/deploy-cf-production.yml/runs?head_sha=${sourceSha}&per_page=100`, { total_count: [...runs.values()].filter(r => r.head_sha === sourceSha).length, workflow_runs: [...runs.values()].filter(r => r.head_sha === sourceSha) });
  for (const runId of runs.keys()) {
    responses.set(`/repos/${repository}/actions/runs/${runId}`, runs.get(runId));
    const artifacts = artifactsByRun.get(runId) ?? [];
    responses.set(`/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`, { total_count: artifacts.length, artifacts });
  }
  if (runs.has(10)) {
    const interval = `${runs.get(10).created_at}..${current.created_at}`;
    responses.set(`/repos/${repository}/actions/workflows/deploy-cf-production.yml/runs?branch=main&event=workflow_run&created=${encodeURIComponent(interval)}&per_page=100`,
      { total_count: runs.size, workflow_runs: [...runs.values()] });
  }
  const request = async (path, binary = false) => { calls.push({ path, binary }); assert.ok(responses.has(path), path); return responses.get(path); };
  return { destination, calls, responses, deps: { env: { ...env, GITHUB_RUN_ATTEMPT: String(currentAttempt) }, request,
    // Unit flow fixtures substitute already-unzipped bytes. A separate test
    // exercises actual ZIP listing/stream extraction including hostile paths.
    extract: bytes => bytes } };
}

test('only exact SHA and pinned main production workflow context are accepted', () => {
  validateContext(sourceSha, env);
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'false', GITHUB_REPOSITORY: 'other/ghfind', GITHUB_REF: 'refs/heads/topic', GITHUB_WORKFLOW_REF: 'other', GITHUB_RUN_ID: '', GITHUB_RUN_ATTEMPT: '0' }))
    assert.throws(() => validateContext(sourceSha, { ...env, [key]: value }));
  assert.throws(() => validateContext('main', env));
});

test('fresh first run has no historical possible POST and does not create the destination', async t => {
  const f = fixture(t);
  assert.equal((await recover(sourceSha, f.destination, f.deps)).status, 'no_prior_start');
  assert.equal(existsSync(f.destination), false);
});

test('a failed historical start restores the entire existing receipt without a fresh POST', async t => {
  const saved = receipt({ phase: 'uncertain', analysisId: null, postIssued: true });
  const f = fixture(t, [{ receipt: saved }]);
  const result = await recover(sourceSha, f.destination, f.deps);
  assert.equal(result.status, 'recovered');
  assert.deepEqual(JSON.parse(readFileSync(f.destination)), saved);
  assert.equal(result.possibleStarts, 1);
});

test('same run previous attempt is inspected and recovered on restart', async t => {
  const f = fixture(t, [{ runId: 20, attempt: 1 }], 2);
  const result = await recover(sourceSha, f.destination, f.deps);
  assert.equal(result.recoveredRunId, 20);
  assert.equal(result.recoveredAttempt, 1);
  assert.equal(f.calls.some(call => call.path.includes('/attempts/2/')), false);
});

test('same intent latest uncertain receipt is retained even when an older receipt selected an analysis', async t => {
  const latest = receipt({ phase: 'uncertain', analysisId: null, postIssued: true, idempotencyKey: 'synthetic-stable-key-retry-1' });
  const f = fixture(t, [{ runId: 10, attempt: 1, createdAt: '2026-09-09T12:01:00Z' },
    { runId: 10, attempt: 2, receipt: latest, createdAt: '2026-09-09T12:02:00Z' }]);
  await recover(sourceSha, f.destination, f.deps);
  assert.deepEqual(JSON.parse(readFileSync(f.destination)), latest);
});

test('expired, missing and digest-mismatched possible-start artifacts fail closed', async t => {
  for (const changes of [{ missingArtifact: true }, { artifactChanges: { expired: true } }, { artifactChanges: { digest: `sha256:${'0'.repeat(64)}` } }, { artifactChanges: { workflow_run: { id: 99, head_sha: sourceSha } } }]) {
    const f = fixture(t, [changes]);
    await assert.rejects(recover(sourceSha, f.destination, f.deps));
    assert.equal(existsSync(f.destination), false);
  }
});

test('missing receipt, malformed receipt and SHA mismatch cannot authorize a fresh start', async t => {
  const missing = fixture(t, [{}]);
  await assert.rejects(recover(sourceSha, missing.destination, { ...missing.deps, extract: () => { throw new Error('missing assessment-intent.json'); } }));
  assert.equal(existsSync(missing.destination), false);
  for (const invalid of [receipt({ sourceSha: 'b'.repeat(40) }), receipt({ intentId: '' }), receipt({ format: 'other' })]) {
    const f = fixture(t, [{ receipt: invalid }]);
    await assert.rejects(recover(sourceSha, f.destination, f.deps));
    assert.equal(existsSync(f.destination), false);
  }
});

test('historical pre-start failure and skipped start do not require an artifact or create a receipt', async t => {
  for (const changes of [{ prestart: true }, { skipped: true }]) {
    const f = fixture(t, [{ ...changes, missingArtifact: true }]);
    assert.equal((await recover(sourceSha, f.destination, f.deps)).status, 'no_prior_start');
    assert.equal(existsSync(f.destination), false);
    assert.equal(f.calls.some(call => call.path.includes('/artifacts')), false);
  }
});

test('an earlier unknown POST is not hidden by a later valid receipt', async t => {
  const f = fixture(t, [{ attempt: 1, missingArtifact: true }, { attempt: 2 }]);
  await assert.rejects(recover(sourceSha, f.destination, f.deps), /missing, expired/);
  assert.equal(existsSync(f.destination), false);
});

test('different stable intents across history cannot silently choose one assessment', async t => {
  const f = fixture(t, [{ attempt: 1 }, { attempt: 2, receipt: receipt({ intentId: '22222222-2222-4222-8222-222222222222' }) }]);
  await assert.rejects(recover(sourceSha, f.destination, f.deps), /intent identities conflict/);
  assert.equal(existsSync(f.destination), false);
});

test('unresolved attempts, incomplete inventories and foreign run identities fail closed', async t => {
  for (const change of [{ status: 'in_progress' }, { head_sha: 'b'.repeat(40) }, { repository: { full_name: 'other/ghfind' } }]) {
    const f = fixture(t, [{ runChanges: change }]);
    await assert.rejects(recover(sourceSha, f.destination, f.deps));
    assert.equal(existsSync(f.destination), false);
  }
  assert.throws(() => mayHaveStarted({ total_count: 2, jobs: [] }), /complete/);
  assert.throws(() => mayHaveStarted({ total_count: 1, jobs: [{ steps: [{ name: startStep }, { name: startStep }] }] }), /ambiguous/);
});

function zip(entries) {
  return execFileSync('python3', ['-c', 'import io,json,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z:\n for n,v in json.load(sys.stdin).items(): z.writestr(n,v)\nsys.stdout.buffer.write(b.getvalue())'], { input: JSON.stringify(entries), maxBuffer: 1024 * 1024 });
}
test('actual ZIP extraction reads one exact file and rejects path traversal or a missing receipt', () => {
  const text = JSON.stringify(receipt());
  assert.equal(extractReceipt(zip({ 'assessment-intent.json': text, 'other-evidence.json': '{}' })).toString(), text);
  for (const files of [{ '../assessment-intent.json': text }, { 'assessment-intent.json': text, '../escape': 'never execute' }, { 'assessment-intent.json': text, '/absolute': 'never execute' }, { 'subdir/assessment-intent.json': text }])
    assert.throws(() => extractReceipt(zip(files)));
});

test('artifact redirect uses GET without forwarding GH_TOKEN and a denied API response is not retried', async () => {
  const calls = [], token = 'synthetic-github-token';
  const reader = githubReader(token, async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://example.blob.core.windows.net/artifact?synthetic-signed-query=1' } });
    return new Response('zip bytes');
  });
  assert.equal((await reader(`/repos/${repository}/actions/artifacts/1/zip`, true)).toString(), 'zip bytes');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.headers, undefined);
  let denied = 0;
  await assert.rejects(githubReader(token, async () => { denied++; return new Response(null, { status: 403 }); })(`/repos/${repository}/actions/runs/1`), /403/);
  assert.equal(denied, 1);
});


const oldSha = 'b'.repeat(40);
const paidId = '22222222-2222-4222-8222-222222222222';
const carryover = { format: 'ghfind-production-assessment-carryover-v1', runId: 10, attempt: 1,
  sourceSha: oldSha, intentId, analysisId: paidId };
const paidReceipt = changes => receipt({ sourceSha: oldSha, analysisId: paidId, ...changes });
function withCarryover(f, manifest = carryover) {
  const path = join(f.destination, '..', 'carryover.json');
  writeFileSync(path, JSON.stringify(manifest));
  return { ...f.deps, env: { ...f.deps.env, FEED_ASSESSMENT_CARRYOVER: path } };
}
test('explicit predecessor restores original assessed SHA without relabeling its receipt', async t => {
  const saved = paidReceipt();
  const f = fixture(t, [{ headSha: oldSha, receipt: saved }]);
  const result = await recover(sourceSha, f.destination, withCarryover(f));
  assert.equal(result.status, 'recovered');
  assert.equal(result.releaseSha, sourceSha);
  assert.equal(result.assessmentSourceSha, oldSha);
  assert.deepEqual(JSON.parse(readFileSync(f.destination)), saved);
});
test('current-release rerun preserves newer predecessor receipt counters and anchors', async t => {
  const latest = paidReceipt({ phase: 'waiting', polls: 12, projectionPolls: 2, projectionStartedAt: 100000, waitStartedAt: 1000 });
  const f = fixture(t, [{ headSha: oldSha, receipt: paidReceipt(), createdAt: '2026-09-14T01:00:00Z' },
    { runId: 20, receipt: latest, createdAt: '2026-09-14T02:00:00Z' }], 2);
  await recover(sourceSha, f.destination, withCarryover(f));
  assert.deepEqual(JSON.parse(readFileSync(f.destination)), latest);
});
test('carryover rejects uncertain, changed analysis, relabeled source and missing predecessor evidence', async t => {
  for (const change of [{ receipt: paidReceipt({ phase: 'uncertain', analysisId: null }) },
    { receipt: paidReceipt({ analysisId: '33333333-3333-4333-8333-333333333333' }) },
    { receipt: paidReceipt({ sourceSha }) }, { missingArtifact: true }, { skipped: true },
    { artifactChanges: { expired: true } }, { runChanges: { status: 'in_progress' } }]) {
    const f = fixture(t, [{ headSha: oldSha, receipt: paidReceipt(), ...change }]);
    await assert.rejects(recover(sourceSha, f.destination, withCarryover(f)));
    assert.equal(existsSync(f.destination), false);
  }
});
test('carryover cannot hide a second current-release assessment behind its pinned predecessor', async t => {
  const f = fixture(t, [{ headSha: oldSha, receipt: paidReceipt() },
    { runId: 20, receipt: receipt() }], 2);
  await assert.rejects(recover(sourceSha, f.destination, withCarryover(f)));
  assert.equal(existsSync(f.destination), false);
});
test('all predecessor attempts are reconciled and the pinned attempt must actually have selected its receipt', async t => {
  const newest = paidReceipt({ polls: 20, phase: 'waiting' });
  const f = fixture(t, [{ headSha: oldSha, receipt: paidReceipt() },
    { headSha: oldSha, attempt: 2, receipt: newest }]);
  await recover(sourceSha, f.destination, withCarryover(f));
  assert.deepEqual(JSON.parse(readFileSync(f.destination)), newest);
  const missing = fixture(t, [{ headSha: oldSha, receipt: paidReceipt() }]);
  await assert.rejects(recover(sourceSha, missing.destination, withCarryover(missing, { ...carryover, attempt: 2 })));
});


test('intervening release receipts preserve consumed quotas across a third release', async t => {
  const latest = paidReceipt({ phase: 'waiting', polls: 59, projectionPolls: 5, terminalRevalidations: 2 });
  const f = fixture(t, [{ headSha: oldSha, receipt: paidReceipt(), createdAt: '2026-09-14T01:00:00Z' },
    { runId: 15, headSha: 'c'.repeat(40), receipt: latest, createdAt: '2026-09-14T02:00:00Z' }]);
  const result = await recover(sourceSha, f.destination, withCarryover(f));
  assert.equal(result.recoveredRunId, 15);
  assert.deepEqual(JSON.parse(readFileSync(f.destination)), latest);
});
test('an intervening unknown paid start or truncated interval fails without resetting intent', async t => {
  for (const missing of [true, false]) {
    const f = fixture(t, [{ headSha: oldSha, receipt: paidReceipt() },
      { runId: 15, headSha: 'c'.repeat(40), receipt: paidReceipt(), missingArtifact: missing }]);
    if (!missing) {
      const key = [...f.responses.keys()].find(key => key.includes('created='));
      f.responses.get(key).total_count++;
    }
    await assert.rejects(recover(sourceSha, f.destination, withCarryover(f)));
    assert.equal(existsSync(f.destination), false);
  }
});

const reviewedHistory = JSON.parse(readFileSync(new URL('../ops/feed-production-assessment-history-evidence.json', import.meta.url)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function readonlyFixture(t, changes = {}) {
  const archive = zip({ 'read-only-evidence.json': '{}' }), logs = Buffer.from('possible previous assessment POST lacks a unique intent receipt\nProcess completed with exit code 1.');
  const f = fixture(t, [{}]);
  const jobs = f.responses.get(`/repos/${repository}/actions/runs/10/attempts/1/jobs?per_page=100`); jobs.jobs[0].id = 500;
  const artifact = f.responses.get(`/repos/${repository}/actions/runs/10/artifacts?per_page=100`).artifacts[0];
  artifact.digest = `sha256:${digest(archive)}`;
  f.responses.set(`/repos/${repository}/actions/artifacts/${artifact.id}/zip`, archive);
  f.responses.set(`/repos/${repository}/actions/jobs/500/logs`, logs);
  const item = { ...reviewedHistory.entries[0], runId: 10, attempt: 1, sourceSha, jobId: 500, artifactId: artifact.id,
    artifactSHA256: digest(archive), logsSHA256: digest(logs), ...changes };
  f.deps = { ...f.deps, extract: extractReceipt, historyEvidence: { format: reviewedHistory.format, entries: [item], archivedReceipts: [] } };
  return f;
}
test('only hash-pinned readonly first-command failures may lack an intent', async t => {
  const f = readonlyFixture(t);
  const result = await recover(sourceSha, f.destination, f.deps);
  assert.equal(result.readonlyFailures, 1); assert.equal(existsSync(f.destination), false);
  for (const changes of [{ sourceSha: oldSha }, { attempt: 2 }, { runId: 11 }, { jobId: 501 },
    { artifactId: 102 }, { artifactSHA256: '0'.repeat(64) }, { logsSHA256: '0'.repeat(64) },
    { failureReason: 'possible previous assessment POST has missing, expired or mismatched evidence artifact' }]) {
    const bad = readonlyFixture(t, changes);
    await assert.rejects(recover(sourceSha, bad.destination, bad.deps)); assert.equal(existsSync(bad.destination), false);
  }
});
test('reviewed readonly entry never conceals an existing receipt or an unsafe ZIP', async t => {
  for (const entries of [{ 'assessment-intent.json': JSON.stringify(receipt({ polls: 19 })) }, { '../escape': 'bad' }]) {
    const f = readonlyFixture(t), archive = zip(entries), item = f.deps.historyEvidence.entries[0];
    item.artifactSHA256 = digest(archive);
    f.responses.get(`/repos/${repository}/actions/runs/10/artifacts?per_page=100`).artifacts[0].digest = `sha256:${digest(archive)}`;
    f.responses.set(`/repos/${repository}/actions/artifacts/101/zip`, archive);
    if (entries['../escape']) await assert.rejects(recover(sourceSha, f.destination, f.deps), /unsafe/);
    else { assert.equal((await recover(sourceSha, f.destination, f.deps)).readonlyFailures, 0); assert.equal(JSON.parse(readFileSync(f.destination)).polls, 19); }
  }
});

// The unavailable retry-1 ZIP is an explicit manual recovery, not a claim that
// its digest can still be verified against GitHub. Preserve every budget field.
import { archivedReceiptBytes, validateHistoryEvidence } from './feed-production-assessment-recovery.mjs';
const archived = reviewedHistory.archivedReceipts[0];
const realCarryover = JSON.parse(readFileSync(new URL('../ops/feed-production-assessment-carryover.json', import.meta.url)));
function archiveAudit(t, value = [archived.databaseAudit]) {
  const f = fixture(t), path = join(f.destination, '..', 'fresh-d1-audit.json');
  writeFileSync(path, JSON.stringify(value)); return { FEED_ASSESSMENT_RECOVERY_AUDIT: path };
}
test('reviewed retry1 archive preserves complete nested journal and requires exact fresh D1 audit', t => {
  for (const rows of [[archived.databaseAudit], [{ success: true, results: [archived.databaseAudit], meta: {} }]]) {
    const restored = JSON.parse(archivedReceiptBytes(archived, realCarryover, archiveAudit(t, rows)));
    assert.deepEqual(restored, archived.receipt);
    assert.equal(restored.polls, 5); assert.equal(restored.providerRunRetries, 1);
    assert.equal(restored.waitStartedAt, 1789360927994);
    assert.equal(restored.operatorRecovery.previousAttempt.polls, 1);
  }
  assert.throws(() => archivedReceiptBytes(archived, realCarryover, {}), /fresh/);
  for (const rows of [[], [archived.databaseAudit, archived.databaseAudit], [{ ...archived.databaseAudit, requested_at: 1 }],
    [{ ...archived.databaseAudit, extra: 'unreviewed' }], [{ success: false, results: [archived.databaseAudit] }]])
    assert.throws(() => archivedReceiptBytes(archived, realCarryover, archiveAudit(t, rows)), /differs/);
  for (const item of [{ ...archived, receiptSHA256: '0'.repeat(64) }, { ...archived, operatorSHA256: '0'.repeat(64) },
    { ...archived, sourceSha }, { ...archived, runId: 11 }])
    assert.throws(() => archivedReceiptBytes(item, realCarryover, archiveAudit(t)));
});
test('history evidence rejects duplicate identities and unknown reason exemptions', () => {
  validateHistoryEvidence(reviewedHistory);
  assert.throws(() => validateHistoryEvidence({ ...reviewedHistory, entries: [...reviewedHistory.entries, reviewedHistory.entries[0]] }), /duplicate/);
  assert.throws(() => validateHistoryEvidence({ ...reviewedHistory, entries: [{ ...reviewedHistory.entries[0], failureReason: 'any failure' }] }), /failure/);
});

test('whole carryover recovery crosses a missing reviewed retry1 artifact and preserves newer budgets', async t => {
  for (const newer of [false, true]) {
    const item = structuredClone(archived), middleSha = 'c'.repeat(40), log = Buffer.from('reviewed original upload log');
    Object.assign(item, { runId: 11, sourceSha: middleSha, jobId: 501, logsSHA256: digest(log), createdAt: '2026-09-14T02:00:00Z' });
    item.operator.releaseSha = middleSha; item.operator.request.operatorRef = 'github-actions:11:1';
    item.operatorSHA256 = digest(JSON.stringify(item.operator)); item.databaseAudit.operator_ref = 'github-actions:11:1';
    const latest = { ...item.receipt, polls: 17 };
    const histories = [{ headSha: realCarryover.sourceSha, receipt: item.receipt.operatorRecovery.previousAttempt, createdAt: '2026-09-14T01:00:00Z' },
      { runId: 11, headSha: middleSha, missingArtifact: true }];
    if (newer) histories.push({ runId: 12, headSha: 'd'.repeat(40), receipt: latest, createdAt: '2026-09-14T03:00:00Z' });
    const f = fixture(t, histories), deps = withCarryover(f, { ...realCarryover, runId: 10 });
    const job = f.responses.get(`/repos/${repository}/actions/runs/11/attempts/1/jobs?per_page=100`).jobs[0];
    job.id = 501; job.steps[0].conclusion = 'success';
    f.responses.set(`/repos/${repository}/actions/jobs/501/logs`, log);
    deps.historyEvidence = { format: reviewedHistory.format, entries: [], archivedReceipts: [item] };
    deps.env = { ...deps.env, ...archiveAudit(t, [item.databaseAudit]) };
    const result = await recover(sourceSha, f.destination, deps);
    assert.equal(result.archivedRecoveries, 1);
    assert.equal(result.recoveredRunId, newer ? 12 : 11);
    assert.deepEqual(JSON.parse(readFileSync(f.destination)), newer ? latest : item.receipt);
  }
});

test('archive cannot rehash altered lineage or consume another operator attempt', t => {
  for (const change of [item => { item.receipt.operatorRecovery.previousAttempt.polls = 0; },
    item => { item.receipt.providerRunRetries = 0; }, item => { item.operator.request.expectedRunId = 'different'; },
    item => { item.operator.result.recovery.executionDeadlineAt++; }, item => { item.operator.result.idempotencyKey += '-retry-2'; }]) {
    const item = structuredClone(archived); change(item);
    item.receiptSHA256 = digest(JSON.stringify(item.receipt)); item.operatorSHA256 = digest(JSON.stringify(item.operator));
    assert.throws(() => archivedReceiptBytes(item, realCarryover, archiveAudit(t)), /lineage/);
  }
});
