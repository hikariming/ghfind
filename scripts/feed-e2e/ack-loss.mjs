import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Verify the real executor result and the persisted facts on both deliveries. */
export async function verifyAckLoss({ deliver, readSnapshot, event }) {
  const first = await deliver(1);
  assert.equal(first.eventId, event.eventId);
  assert.equal(first.status, 'completed', 'initial delivery must execute the fresh assessment');
  const before = await readSnapshot();
  const job = before.jobs.find(row => row.event_id === event.eventId);
  assert.equal(job?.status, 'completed', 'ack preceded durable job completion');
  assert.equal(job?.attempts, 1, 'fresh fixture must execute exactly once');
  const payload = job.payload ?? JSON.parse(job.envelope_json);
  assert.equal(payload.sourceHash, event.sourceHash, 'persisted job changed the assessment artifact hash');
  const project = before.projects.find(row => row.repo_key === event.aggregateKey);
  assert.equal(project?.analysis_id, event.analysisId);
  // Catalog source_hash is the derived projection digest; the outbox hash is
  // the raw assessment JSON digest. They belong to different hash domains.
  assert.match(project?.source_hash ?? '', /^[a-f0-9]{64}$/);
  const evidence = before.evidence.find(row => row.repo_key === event.aggregateKey);
  assert.equal(evidence?.analysis_id, event.analysisId);
  assert.equal(evidence?.source_version, event.sourceVersion);
  assert.equal(evidence?.source_event_id ?? evidence?.event_id, event.eventId);
  if ('source_hash' in evidence) assert.equal(evidence.source_hash, project.source_hash);
  const second = await deliver(2);
  assert.equal(second.eventId, event.eventId);
  assert.equal(second.status, 'duplicate', 'ack-loss redelivery executed the job again');
  const after = await readSnapshot();
  assert.equal(digest(after), digest(before), 'ack-loss redelivery mutated durable jobs or projections');
  return { first: first.status, second: second.status, snapshotHash: digest(after) };
}
