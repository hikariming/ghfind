import test from 'node:test';
import assert from 'node:assert/strict';
import { REPO, sourceIdentity } from './feed-production-assessment.mjs';
import { checkpointHash, validateCheckpoint, verifyCheckpoint, checkpointReader } from './feed-production-assessment-checkpoint.mjs';
const SHA = "a".repeat(40),
  RAW = "b".repeat(64),
  COMPOSITE = "c".repeat(64);
const ID = "ad370caa-0000-4000-8000-000000000001";
const AGENT = "01ABCDEFGHIJKLMNOPQRSTUVWX";
const TOKEN = "private-cloudflare-token-never-public";
const versions = {
  schema_version: "ghfind.project-analysis.v3",
  rubric_version: "project-value-v1",
  agent_version: "project-evaluator-v3",
  skill_version: "ghfind-project-evaluator-v5",
};
const run = (extra = {}) => ({
  id: ID,
  repo_key: REPO,
  requested_ref: SHA,
  status: "running",
  idempotency_key: `ghfind-project-${ID}`,
  create_attempts: 1,
  created_at: 1000,
  ...versions,
  ...extra,
});
const source = (extra = {}) => ({
  ...run({ status: "completed" }),
  resolved_commit_sha: SHA,
  current_commit_sha: SHA,
  latest_analysis_id: ID,
  completed_at: 2000,
  mosoo_agent_id: AGENT,
  mosoo_thread_id: "thread-actual",
  mosoo_run_id: "run-actual",
  analysis_sha256: RAW,
  report_sha256: "d".repeat(64),
  evidence_sha256: "e".repeat(64),
  source_hash: RAW,
  receipt_id: "submission-actual",
  requested_repo_key: REPO,
  source_kind: "app_submission",
  aggregate_key: REPO,
  contract_version: 1,
  sequence: 88,
  event_id: "event-actual",
  outbox_status: "delivered",
  ...extra,
});
const projection = (extra = {}) => ({
  analysis_id: ID,
  version_analysis_id: ID,
  event_analysis_id: ID,
  event_id: "event-actual",
  job_event_id: "event-actual",
  source_version: 88,
  job_source_version: 88,
  event_source_version: 88,
  receipt_id: "submission-actual",
  event_receipt_id: "submission-actual",
  event_source_hash: RAW,
  event_contract_version: 1,
  job_repo: REPO,
  resolved_commit_sha: SHA,
  source_kind: "app_submission",
  source_hash: COMPOSITE,
  version_source_hash: COMPOSITE,
  job_status: "completed",
  revoked_at: null,
  blocked_reason: "",
  removed: 0,
  published: 1,
  ...extra,
});

const carryover = {format:'ghfind-production-assessment-carryover-v1',runId:1,attempt:1,sourceSha:SHA,intentId:ID,analysisId:ID};
function checkpoint() {
  const receipt = {format:'ghfind-production-assessment-intent-v1',sourceSha:SHA,intentId:ID,analysisId:ID,
    origin:'https://ghfind.beiming1201.workers.dev',repository:REPO,postIssued:true,phase:'completed',status:'completed',
    idempotencyKey:`ghfind-project-${ID}`,providerRunRetries:0,web:{agentId:AGENT}};
  return {format:'ghfind-production-assessment-checkpoint-v1',receipt,receiptSHA256:checkpointHash(receipt),source:sourceIdentity(source(),SHA,ID,AGENT)};
}
const query = async kind => ({runs:[run({status:'completed'})],source:[source()],projection:[projection()]})[kind];
test('completed checkpoint is freshly verified without mutating receipt or provider calls', async()=>{
  const m=checkpoint(), before=JSON.stringify(m), calls=[];
  const result=await verifyCheckpoint('b'.repeat(40),m,carryover,{query:async(k,p)=>{calls.push([k,p]);return query(k);},now:()=>123});
  assert.equal(result.status,'passed'); assert.equal(result.providerRequests,0); assert.equal(result.observedAt,123);
  assert.deepEqual(calls.map(([k])=>k),['runs','source','projection']); assert.equal(JSON.stringify(m),before);
});
test('tampering, mismatched carryover, and nonterminal checkpoints fail before reads',async()=>{
  for(const mutate of [m=>m.receipt.polls=1,m=>m.receipt.analysisId='other',m=>{m.receipt.phase='waiting';m.receiptSHA256=checkpointHash(m.receipt);},m=>delete m.source.providerThreadId]){
    const m=checkpoint(); mutate(m); let reads=0;
    await assert.rejects(verifyCheckpoint('b'.repeat(40),m,carryover,{query:()=>{reads++;}})); assert.equal(reads,0);
  }
  assert.throws(()=>validateCheckpoint(checkpoint(),{...carryover,intentId:'ad370caa-0000-4000-8000-000000000099'}));
});
test('missing, duplicated, changed and undelivered live state cannot pass', async()=>{
  for(const [kind,rows] of [ ['runs',[]],['runs',[run(),run()]],['runs',[run()]],
    ['source',[source({mosoo_run_id:'changed'})]],['source',[source({analysis_sha256:'f'.repeat(64),source_hash:'f'.repeat(64)})]],
    ['source',[source({outbox_status:'pending'})]], ['projection',[]],['projection',[projection({job_status:'pending'})]],
    ['projection',[projection({published:0})]],['projection',[projection({event_analysis_id:'wrong'})]] ]) {
    await assert.rejects(verifyCheckpoint('b'.repeat(40),checkpoint(),carryover,{query:async k=>k===kind?rows:query(k)}));
  }
});
test('reader permits only fixed SELECTs on fixed databases with strict budget',async()=>{
  const calls=[];
  const reader=checkpointReader(TOKEN,async(url,options)=>{
    calls.push({url,options}); return new Response(JSON.stringify({success:true,result:[{success:true,results:[]}]}));
  });
  for(const k of ['runs','source','projection']) await reader(k,[]);
  await assert.rejects(reader('runs',[]),/budget/);
  assert.equal(calls.length,3); for(const c of calls){ assert.match(c.url,/^https:\/\/api.cloudflare.com\/client\/v4\/accounts\//); assert.match(JSON.parse(c.options.body).sql,/^SELECT /); assert.equal(c.options.redirect,'error'); }
  await assert.rejects(checkpointReader(TOKEN,()=>{throw Error('should not fetch');})('delete',[]),/budget/);
});
test('reader rejects HTTP errors, malformed API results and oversize responses',async()=>{
  for(const response of [new Response('',{status:500}),new Response('not json'),new Response(JSON.stringify({success:false,result:[]})),new Response('x'.repeat(65537))]){
    await assert.rejects(checkpointReader(TOKEN,async()=>response)('runs',[]));
  }
});
test('source-only preflight makes no projection claim or query', async()=>{
  const calls=[];
  const result=await verifyCheckpoint('b'.repeat(40),checkpoint(),carryover,{stage:'source',query:async k=>{calls.push(k);return query(k);}});
  assert.equal(result.status,'source_verified'); assert.equal(result.projection,null);
  assert.equal(result.verification,'fresh_readonly_source_only'); assert.equal(result.managementRequests,2);
  assert.deepEqual(calls,['runs','source']);
  await assert.rejects(verifyCheckpoint('b'.repeat(40),checkpoint(),carryover,{stage:'skip',query}));
});

test('run/source races, a different carryover SHA, and revoked or moderated projects fail closed',async()=>{
  await assert.rejects(verifyCheckpoint('b'.repeat(40),checkpoint(),{...carryover,sourceSha:'c'.repeat(40)},{query}),/carryover/);
  for(const [kind,rows] of [
    ['source',[source({created_at:1001})]],
    ['projection',[projection({revoked_at:2000})]],
    ['projection',[projection({removed:1})]],
    ['projection',[projection({blocked_reason:'review'})]],
  ]) await assert.rejects(verifyCheckpoint('b'.repeat(40),checkpoint(),carryover,{query:async k=>k===kind?rows:query(k)}));
  const result=await verifyCheckpoint('b'.repeat(40),checkpoint(),carryover,{query,stage:'source'});
  assert.equal(JSON.stringify(result).includes('passed'),false);
});
