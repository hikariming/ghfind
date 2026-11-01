#!/usr/bin/env node
// Completed paid work is a durable checkpoint, not an expiring Actions artifact.
// This module can only read three fixed SQL queries. It never starts or resumes
// a provider operation, resets a journal deadline, or grants a new retry.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT, CORE, FEED, SQL, REPO, sourceIdentity, projectionIdentity } from './feed-production-assessment.mjs';
import { validateCarryoverReceipt, validateContext } from './feed-production-assessment-recovery.mjs';

const check = (ok, message) => { if (!ok) throw new Error(message); };
export const checkpointHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const checkpointLimits = Object.freeze({ requests: 3, requestMs: 20000, responseBytes: 65536, manifestBytes: 32768 });
const fields = ['analysisId', 'idempotencyKey', 'providerAgentId', 'providerThreadId', 'providerRunId',
  'analysisSHA256', 'reportSHA256', 'evidenceSHA256', 'receiptId', 'eventId', 'sourceVersion', 'sourceHash'];

export function validateCheckpoint(manifest, carryover) {
  check(manifest?.format === 'ghfind-production-assessment-checkpoint-v1' &&
    /^[a-f0-9]{64}$/.test(manifest.receiptSHA256 ?? '') &&
    checkpointHash(manifest.receipt) === manifest.receiptSHA256, 'checkpoint_receipt_digest_mismatch');
  const receipt = validateCarryoverReceipt(manifest.receipt, carryover);
  check(receipt.format === 'ghfind-production-assessment-intent-v1' && receipt.phase === 'completed' &&
    receipt.status === 'completed', 'checkpoint_requires_completed_assessment');
  check(manifest.source && fields.every(key => Object.hasOwn(manifest.source, key)) &&
    manifest.source.analysisId === receipt.analysisId && manifest.source.idempotencyKey === receipt.idempotencyKey &&
    manifest.source.providerAgentId === receipt.web?.agentId &&
    Number.isInteger(receipt.providerRunRetries) && receipt.providerRunRetries >= 0 && receipt.providerRunRetries <= 2 &&
    receipt.idempotencyKey === `ghfind-project-${receipt.analysisId}${receipt.providerRunRetries ? `-retry-${receipt.providerRunRetries}` : ''}`,
  'checkpoint_source_identity_mismatch');
  return receipt;
}

export async function verifyCheckpoint(releaseSha, manifest, carryover, { query, now = Date.now, stage = 'projection' } = {}) {
  check(/^[a-f0-9]{40}$/.test(releaseSha ?? ''), 'checkpoint_release_sha_required');
  check(['source', 'projection'].includes(stage), 'checkpoint_invalid_stage');
  const receipt = validateCheckpoint(manifest, carryover);
  check(typeof query === 'function', 'checkpoint_read_query_required');
  const one = async (kind, params) => {
    const rows = await query(kind, params);
    check(Array.isArray(rows) && rows.length === 1, `checkpoint_${kind}_not_unique`);
    return rows[0];
  };
  const run = await one('runs', [REPO, receipt.sourceSha]);
  check(run.id === receipt.analysisId && run.status === 'completed' && run.idempotency_key === receipt.idempotencyKey,
    'checkpoint_live_run_identity_mismatch');
  const row = await one('source', [receipt.analysisId, REPO]);
  check(Object.entries(run).every(([key, value]) => row[key] === value), 'checkpoint_live_run_changed');
  const source = sourceIdentity(row, receipt.sourceSha, receipt.analysisId, receipt.web.agentId);
  check(Object.entries(manifest.source).every(([key, value]) => Object.hasOwn(source, key) && source[key] === value),
    'checkpoint_live_source_changed');
  const projection = stage === 'projection' ? projectionIdentity(await one('projection', [REPO]), source, receipt.sourceSha) : null;
  check(stage === 'source' || projection, 'checkpoint_projection_not_ready');
  return { format: 'ghfind-production-assessment-checkpoint-result-v1', status: stage === 'source' ? 'source_verified' : 'passed', releaseSha,
    sourceSha: receipt.sourceSha, intentId: receipt.intentId, receiptSHA256: manifest.receiptSHA256,
    verification: stage === 'source' ? 'fresh_readonly_source_only' : 'fresh_readonly_completed_checkpoint', providerRequests: 0, managementRequests: stage === 'source' ? 2 : 3,
    newProviderExecutionClaimed: false, source, projection, observedAt: now() };
}

export function checkpointReader(token, fetcher = fetch) {
  check(typeof token === 'string' && token.length > 0 && !/[\x00-\x20\x7f]/.test(token), 'checkpoint_read_token_required');
  let reads = 0;
  return async (kind, params) => {
    check(['runs', 'source', 'projection'].includes(kind) && ++reads <= checkpointLimits.requests, 'checkpoint_read_budget_exceeded');
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${kind === 'projection' ? FEED : CORE}/query`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(checkpointLimits.requestMs),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sql: SQL[kind], params }),
    });
    check(response.ok, `checkpoint_d1_read_failed_${response.status}`);
    let size = 0; const chunks = [];
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength; check(size <= checkpointLimits.responseBytes, 'checkpoint_response_too_large'); chunks.push(chunk);
    }
    let data; try { data = JSON.parse(Buffer.concat(chunks)); } catch { throw new Error('checkpoint_invalid_d1_json'); }
    check(data.success === true && data.result?.length === 1 && data.result[0].success === true &&
      Array.isArray(data.result[0].results) && data.result[0].results.length <= 2, 'checkpoint_invalid_d1_result');
    return data.result[0].results;
  };
}

async function main() {
  const [releaseSha, manifestPath, carryoverPath, output, mode] = process.argv.slice(2);
  check((process.argv.length === 6 || (process.argv.length === 7 && mode === '--source-only')) && output && isAbsolute(output), 'usage: checkpoint RELEASE_SHA MANIFEST CARRYOVER ABS_RESULT [--source-only]');
  validateContext(releaseSha);
  const load = path => { const bytes = readFileSync(path); check(bytes.length <= checkpointLimits.manifestBytes, 'checkpoint_file_too_large'); return JSON.parse(bytes); };
  const result = await verifyCheckpoint(releaseSha, load(manifestPath), load(carryoverPath), { query: checkpointReader(process.env.CLOUDFLARE_API_TOKEN), stage: mode ? 'source' : 'projection' });
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: result.status, verification: result.verification, providerRequests: 0 }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
