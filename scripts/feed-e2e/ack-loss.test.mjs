import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyAckLoss } from './ack-loss.mjs';

const event = { eventId: 'source-1', analysisId: 'analysis-1', aggregateKey: 'fixture/tool', sourceVersion: 1, sourceHash: 'a'.repeat(64) };
function fixture() {
  const snapshot = {
    jobs: [{ event_id: event.eventId, status: 'completed', attempts: 1, payload: event }],
    projects: [{ repo_key: event.aggregateKey, analysis_id: event.analysisId, source_hash: 'b'.repeat(64) }],
    evidence: [{ repo_key: event.aggregateKey, analysis_id: event.analysisId, source_version: 1, source_event_id: event.eventId }],
    tags: [], proposals: [],
  };
  return { event, snapshot, readSnapshot: async () => structuredClone(snapshot), deliver: async attempt => ({ eventId: event.eventId, status: attempt === 1 ? 'completed' : 'duplicate' }) };
}
test('fresh completion followed by unchanged durable duplicate passes', async () => {
  const result = await verifyAckLoss(fixture());
  assert.deepEqual([result.first, result.second], ['completed', 'duplicate']);
});
test('a second successful execution cannot masquerade as ack-loss recovery', async () => {
  const inputs = fixture();
  inputs.deliver = async () => ({ eventId: event.eventId, status: 'completed' });
  await assert.rejects(verifyAckLoss(inputs), /redelivery executed the job again/);
});
test('duplicate response cannot hide durable state mutation', async () => {
  const inputs = fixture();
  inputs.deliver = async attempt => {
    if (attempt === 2) inputs.snapshot.jobs[0].attempts++;
    return { eventId: event.eventId, status: attempt === 1 ? 'completed' : 'duplicate' };
  };
  await assert.rejects(verifyAckLoss(inputs), /redelivery mutated durable jobs or projections/);
});
test('ack without a durable matching projection cannot pass', async () => {
  const inputs = fixture();
  inputs.snapshot.projects[0].analysis_id = 'prior-analysis';
  await assert.rejects(verifyAckLoss(inputs));
});
