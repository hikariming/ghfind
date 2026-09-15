import assert from 'node:assert/strict';
import test from 'node:test';
import { installProviders } from './provider-fixtures.mjs';

test('interrupted external fixture preserves one analysis across idempotent provider retry', async () => {
  const fixture = installProviders({ interruptedRepository: 'e2e-owner-one/tool-one' });
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
    const retry = await create('original-retry-1');
    assert.equal(retry.run.status, 'completed');
    assert.notEqual(retry.thread.id, original.thread.id);
    assert.equal((await create('original-retry-1')).thread.id, retry.thread.id);
    assert.equal(fixture.counts.assessmentCreate, 2);
    const files = await (await fetch(`${base}/threads/${retry.thread.id}/files`)).json();
    const file = files.files.find(file => file.name === 'project-analysis-analysis-1.json');
    assert(file);
    const artifact = await (await fetch(`${base}/files/${file.id}/content`)).json();
    assert.equal(artifact.analysis_id, 'analysis-1');
    assert.equal(artifact.repository.repo_key, 'e2e-owner-one/tool-one');
  } finally { fixture.restore(); }
});
