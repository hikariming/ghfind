import assert from 'node:assert/strict';
import test from 'node:test';
import { installProviders } from './provider-fixtures.mjs';

for (const interruptedAttempts of [1, 2]) test(`interrupted fixture preserves one analysis across ${interruptedAttempts} idempotent retries`, async () => {
  const fixture = installProviders({ interruptedRepository: 'e2e-owner-one/tool-one', interruptedAttempts });
  const base = 'https://feed-e2e-provider.invalid/api/v1';
  const create = async key => (await fetch(`${base}/agents/local-e2e-agent/threads`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ userId: 'fixture', input: { type: 'user.message', content: [{ type: 'text', text: 'repository_url: https://github.com/e2e-owner-one/tool-one\nanalysis_id: analysis-1' }] } }),
  })).json();
  try {
    const original = await create('original');
    assert.equal(original.run.status, 'running');
    assert.equal((await create('original')).thread.id, original.thread.id);
    assert.equal(fixture.counts.assessmentCreate, 1);
    fixture.interrupt('analysis-1');
    const failed = await (await fetch(`${base}/threads/${original.thread.id}`)).json();
    assert.equal(failed.run.status, 'failed');
    assert.equal(failed.run.error.code, 'runtime.turn_interrupted');
    assert.throws(() => fixture.interrupt('analysis-1'));
    let retry;
    for (let attempt = 1; attempt <= interruptedAttempts; attempt++) {
      retry = await create(`original-retry-${attempt}`);
      assert.equal(retry.run.status, attempt < interruptedAttempts ? 'running' : 'completed');
      assert.notEqual(retry.thread.id, original.thread.id);
      assert.equal((await create(`original-retry-${attempt}`)).thread.id, retry.thread.id);
      assert.equal(fixture.counts.assessmentCreate, attempt + 1);
      if (attempt < interruptedAttempts) {
        fixture.interrupt(retry.thread.id);
        const failedRetry = await (await fetch(`${base}/threads/${retry.thread.id}`)).json();
        assert.equal(failedRetry.run.status, 'failed');
        assert.equal(failedRetry.run.error.code, 'runtime.turn_interrupted');
        assert.equal((await create(`original-retry-${attempt}`)).run.status, 'failed');
        assert.equal(fixture.counts.assessmentCreate, attempt + 1);
      }
    }
    const files = await (await fetch(`${base}/threads/${retry.thread.id}/files`)).json();
    const file = files.files.find(file => file.name === 'project-analysis-analysis-1.json');
    assert(file);
    const artifact = await (await fetch(`${base}/files/${file.id}/content`)).json();
    assert.equal(artifact.analysis_id, 'analysis-1');
    assert.equal(artifact.repository.repo_key, 'e2e-owner-one/tool-one');
  } finally { fixture.restore(); }
});
