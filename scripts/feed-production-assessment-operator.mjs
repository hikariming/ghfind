#!/usr/bin/env node
// Explicit, Actions-only recovery of one pinned interrupted provider attempt.
// The predecessor receipt is read-only; server recovery has its own deadline.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyWeb } from './feed-production-release.mjs';
import { validateContext, validateCarryoverReceipt } from './feed-production-assessment-recovery.mjs';
const origin = 'https://ghfind.beiming1201.workers.dev';
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const ulid = value => typeof value === 'string' && /^[0-9A-Z]{26}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const limits = Object.freeze({ requests: 2, requestMs: 15000, responseBytes: 4096 });
export function operatorPolicy(manifest) {
  if (manifest?.format === 'ghfind-production-assessment-operator-v1')
    return { number: 1, action: 'retry_interrupted' };
  requireThat(manifest?.format === 'ghfind-production-assessment-operator-v2' && manifest.retryNumber === 2 &&
    uuid(manifest.predecessorRequestId) && manifest.predecessorRequestId !== manifest.requestId,
    'final operator retry requires a distinct request and exact predecessor');
  return { number: 2, action: 'retry_interrupted_final' };
}
export function validateOperator(manifest, carryover, receipt) {
  const policy = operatorPolicy(manifest);
  validateCarryoverReceipt(receipt, carryover);
  requireThat(uuid(manifest.requestId) &&
    uuid(manifest.analysisId) && sha(manifest.requestedRef) && ulid(manifest.expectedThreadId) && ulid(manifest.expectedRunId) && ulid(manifest.agentId) &&
    manifest.analysisId === carryover.analysisId && manifest.requestedRef === carryover.sourceSha &&
    receipt.web?.agentId === manifest.agentId && typeof receipt.idempotencyKey === 'string' && receipt.idempotencyKey.length > 0,
    'operator manifest must identify the pinned paid assessment and provider');
  const baseKey = `ghfind-project-${manifest.analysisId}`, nextKey = `${baseKey}-retry-${policy.number}`;
  const priorKey = policy.number === 1 ? baseKey : `${baseKey}-retry-1`;
  requireThat(receipt.idempotencyKey === priorKey || receipt.idempotencyKey === nextKey,
    'operator recovery must retain the original or first retry provider key');
  if (policy.number === 2 && receipt.idempotencyKey === priorKey) {
    const prior = receipt.operatorRecovery;
    requireThat(prior?.requestId === manifest.predecessorRequestId && prior.action === 'retry_interrupted' &&
      prior.nextIdempotencyKey === priorKey && prior.previousAttempt?.idempotencyKey === baseKey &&
      prior.previousAttempt.analysisId === manifest.analysisId && Number.isSafeInteger(prior.createdAt) &&
      prior.executionDeadlineAt - prior.createdAt === 1800000, 'final retry requires the complete first recovery audit');
  }
  if (receipt.idempotencyKey === nextKey || (policy.number === 1 && receipt.operatorRecovery)) {
    const audit = receipt.operatorRecovery;
    requireThat(audit?.requestId === manifest.requestId && audit.action === policy.action &&
      audit.priorThreadId === manifest.expectedThreadId && audit.priorRunId === manifest.expectedRunId &&
      audit.nextIdempotencyKey === nextKey && Number.isSafeInteger(audit.createdAt) && audit.createdAt > 0 &&
      Number.isSafeInteger(audit.executionDeadlineAt) && audit.executionDeadlineAt - audit.createdAt === 1800000,
      'resumed operator receipt must retain the same persisted recovery audit');
  }
  return manifest;
}
function validateResult(value, manifest, receipt) {
  const policy = operatorPolicy(manifest);
  const recovery = value?.recovery;
  requireThat(value?.analysisId === manifest.analysisId && value.requestedRef === manifest.requestedRef &&
    ['queued','creating_thread','running','finalizing','completed'].includes(value.status) &&
    typeof value.idempotencyKey === 'string' && value.idempotencyKey.length > 0 && value.idempotencyKey.length <= 200 &&
    value.idempotencyKey === `ghfind-project-${manifest.analysisId}-retry-${policy.number}` &&
    recovery?.requestId === manifest.requestId && recovery.action === policy.action &&
    recovery.priorThreadId === manifest.expectedThreadId && recovery.priorRunId === manifest.expectedRunId &&
    recovery.nextIdempotencyKey === value.idempotencyKey &&
    Number.isSafeInteger(recovery.createdAt) && recovery.createdAt > 0 &&
    Number.isSafeInteger(recovery.executionDeadlineAt) && recovery.executionDeadlineAt > recovery.createdAt &&
    recovery.executionDeadlineAt - recovery.createdAt === 30 * 60 * 1000 &&
    Number.isSafeInteger(value.createAttempts) && value.createAttempts >= 0 && value.createAttempts <= 3 &&
    (value.threadId === null || ulid(value.threadId)) && (value.runId === null || ulid(value.runId)) &&
    (value.startedAt === null || (Number.isSafeInteger(value.startedAt) && value.startedAt > 0)),
    'operator recovery response identity or independent deadline differs');
  if (['running','finalizing','completed'].includes(value.status)) requireThat(ulid(value.threadId) && ulid(value.runId), 'active recovery must have actual provider identity');
  if (value.threadId !== null) requireThat(value.threadId !== manifest.expectedThreadId, 'recovery must not reuse interrupted provider thread');
  if (value.runId !== null) requireThat(value.runId !== manifest.expectedRunId, 'recovery must not reuse interrupted provider run');
  if (receipt.operatorRecovery?.requestId === manifest.requestId) {
    const audit = receipt.operatorRecovery;
    requireThat(['requestId','action','createdAt','executionDeadlineAt','priorThreadId','priorRunId','nextIdempotencyKey']
      .every(key => audit[key] === recovery[key]), 'resumed recovery audit or deadline changed');
  }
  return { analysisId:value.analysisId, requestedRef:value.requestedRef, status:value.status,
    idempotencyKey:value.idempotencyKey, threadId:value.threadId, runId:value.runId, startedAt:value.startedAt, createAttempts:value.createAttempts,
    recovery:{requestId:recovery.requestId, action:recovery.action, executionDeadlineAt:recovery.executionDeadlineAt,
      createdAt:recovery.createdAt, priorThreadId:recovery.priorThreadId, priorRunId:recovery.priorRunId, nextIdempotencyKey:recovery.nextIdempotencyKey} };
}
// Network, 5xx and unparseable 2xx may conceal a committed operation. Replay only
// its same stable request ID, never generate a new request or analysis identity.
export function operatorSender(secret, fetcher = fetch) {
  requireThat(typeof secret === 'string' && secret.length >= 32 && !/[\x00-\x20\x7f]/.test(secret), 'operator reconcile credential absent');
  return async body => {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer=setTimeout(()=>{controller.abort();reject(new Error('operator response uncertain'));},limits.requestMs); });
    try {
      return await Promise.race([(async()=>{
        let response;
        try { response = await fetcher(`${origin}/api/internal/project-analyses/reconcile`, {method:'POST',redirect:'error',signal:controller.signal,
          headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify(body)}); }
        catch { return { uncertain:true, status:null }; }
        if (response.status !== 200) return {uncertain:[500,502,503,504].includes(response.status),status:response.status};
        try {
          const reader=response.body?.getReader(); let size=0; const chunks=[];
          if(reader) {try { for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limits.responseBytes)throw new Error();chunks.push(value);} }
            finally {await reader.cancel().catch(()=>{});} }
          return {status:200,uncertain:false,value:JSON.parse(Buffer.concat(chunks).toString('utf8'))};
        } catch { return {status:200,uncertain:true}; }
      })(),timeout]);
    } catch { return {uncertain:true,status:null}; }
    finally {clearTimeout(timer);controller.abort();}
  };
}
export async function recoverInterrupted(releaseSha, manifest, carryover, receipt, {env=process.env, paused, send, record=()=>{}}) {
  const context=validateContext(releaseSha,env);
  validateOperator(manifest,carryover,receipt);
  requireThat(env.MOSOO_PROJECT_AGENT_ID === manifest.agentId, 'operator provider must match current production configuration');
  // Hash the canonical parsed journal, not indentation/trailing newlines of its file.
  const original=JSON.stringify(receipt), receiptSHA256=createHash('sha256').update(original).digest('hex');
  const body={action:operatorPolicy(manifest).action,analysisId:manifest.analysisId,requestedRef:manifest.requestedRef,
    expectedThreadId:manifest.expectedThreadId,expectedRunId:manifest.expectedRunId,requestId:manifest.requestId,
    operatorRef:`github-actions:${context.currentRunId}:${context.currentAttempt}`};
  const evidence={format:'ghfind-production-assessment-operator-result-v1',status:'attempted_unverified',releaseSha,
    request:body,originalReceiptSHA256:receiptSHA256,attempts:[]};
  let anchor;
  const checkPaused=async()=>{
    const current=await paused();
    requireThat(current?.status==='passed' && current.mode==='paused' && current.sourceSha===releaseSha && current.backend==='go' &&
      current.store==='cf_d1_r2' && uuid(current.workerVersionId),
      'operator recovery requires the current exact paused Web and pinned provider');
    requireThat(!anchor || anchor===current.workerVersionId,'paused Web changed during operator recovery');
    anchor=current.workerVersionId;evidence.pausedVersion=anchor;
  };
  record(evidence);
  try {
    for(let attempt=1;attempt<=limits.requests;attempt++) {
      await checkPaused();
      const item={attempt,status:'attempted_unverified'};evidence.attempts.push(item);record(evidence);
      const response=await send(body);
      item.httpStatus=response.status ?? null;
      if(response.uncertain) {item.status='uncertain';record(evidence);continue;}
      requireThat(response.status===200,'operator recovery explicitly rejected');
      evidence.result=validateResult(response.value,manifest,receipt);
      item.status='accepted';record(evidence);
      await checkPaused();
      requireThat(JSON.stringify(receipt)===original,'original assessment receipt was mutated');
      evidence.status='accepted';record(evidence);return evidence;
    }
    throw new Error('operator recovery remained uncertain after two identical requests');
  } catch(error) {evidence.status='failed';record(evidence);throw error;}
}
async function main() {
  const [releaseSha, manifestPath,carryoverPath,receiptPath,output]=process.argv.slice(2);
  validateContext(releaseSha);
  requireThat(process.argv.length===7 && output && resolve(output)===output,'usage: feed-production-assessment-operator.mjs RELEASE_SHA OPERATOR_MANIFEST CARRYOVER_MANIFEST RECEIPT ABSOLUTE_OUTPUT');
  const load=path=>{const bytes=readFileSync(path);requireThat(bytes.length<=32768,'operator input exceeds bound');return JSON.parse(bytes);};
  const manifest=load(manifestPath),carryover=load(carryoverPath),receipt=load(receiptPath);
  let first=true;
  await recoverInterrupted(releaseSha,manifest,carryover,receipt,{
    paused:()=>verifyWeb(releaseSha,'paused',process.env),send:operatorSender(process.env.PROJECT_ANALYSIS_RECONCILE_SECRET),
    record:evidence=>{writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{mode:0o600,flag:first?'wx':'w'});first=false;},
  });
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(error.message);process.exitCode=1;});
