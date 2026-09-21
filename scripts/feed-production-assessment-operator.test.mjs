import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverInterrupted, operatorSender, limits } from './feed-production-assessment-operator.mjs';
const oldSha='a'.repeat(40),releaseSha='b'.repeat(40),analysisId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',intentId='33333333-3333-4333-8333-333333333333';
const manifest={format:'ghfind-production-assessment-operator-v1',requestId,analysisId,requestedRef:oldSha,expectedThreadId:'01M2EZ289XGFKNVH61YTXM8W5J',expectedRunId:'01M2EZ28DQ0Y9BDKVMT8N9BN73',agentId:'01M22PWZR0A7ZYCDKWTEA0YEHQ'};
const carryover={format:'ghfind-production-assessment-carryover-v1',runId:123,attempt:1,sourceSha:oldSha,intentId,analysisId};
const original={format:'ghfind-production-assessment-intent-v1',intentId,sourceSha:oldSha,analysisId,postIssued:true,phase:'waiting',repository:'hikariming/ghfind',origin:'https://ghfind.beiming1201.workers.dev',web:{agentId:manifest.agentId},idempotencyKey:`ghfind-project-${analysisId}`,createdAt:1000,polls:60,projectionPolls:5,providerRunRetries:0};
const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'hikariming/ghfind',GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_REF:'hikariming/ghfind/.github/workflows/deploy-cf-production.yml@refs/heads/main',GITHUB_RUN_ID:'456',GITHUB_RUN_ATTEMPT:'1',MOSOO_PROJECT_AGENT_ID:manifest.agentId};
const web={status:'passed',mode:'paused',sourceSha:releaseSha,backend:'go',store:'cf_d1_r2',workerVersionId:'44444444-4444-4444-8444-444444444444'};
function reply(status='running') {return {analysisId,requestedRef:oldSha,status,idempotencyKey:`${original.idempotencyKey}-retry-1`,threadId:status==='queued'?null:'01M2EZ289XGFKNVH61YTXM8W5K',runId:status==='queued'?null:'01M2EZ28DQ0Y9BDKVMT8N9BN74',startedAt:1000,createAttempts:2,secret:'must-not-output',recovery:{requestId,action:'retry_interrupted',executionDeadlineAt:1802000,createdAt:2000,priorThreadId:manifest.expectedThreadId,priorRunId:manifest.expectedRunId,nextIdempotencyKey:`${original.idempotencyKey}-retry-1`,secret:'must-not-output'}};}
function setup(overrides={}) {const evidence=[],posts=[],receipt=structuredClone(original);return {evidence,posts,receipt,deps:{env,paused:async()=>web,record:r=>evidence.push(structuredClone(r)),send:async body=>{posts.push(structuredClone(body));return {status:200,uncertain:false,value:reply()};},...overrides}};}
test('writes intent before the sole fixed request, whitelists server deadline and never mutates old quotas',async()=>{
  const f=setup(); const send=f.deps.send;
  f.deps.send=async body=>{assert.equal(f.evidence.at(-1).attempts[0].status,'attempted_unverified');return send(body);};
  const result=await recoverInterrupted(releaseSha,manifest,carryover,f.receipt,f.deps);
  assert.equal(result.status,'accepted');assert.equal(f.posts.length,1);assert.deepEqual(f.receipt,original);
  assert.deepEqual(Object.keys(f.posts[0]).sort(),['action','analysisId','requestedRef','expectedThreadId','expectedRunId','requestId','operatorRef'].sort());
  assert.equal(f.posts[0].operatorRef,'github-actions:456:1');assert.equal(f.posts[0].requestedRef,oldSha);
  assert.equal(result.result.recovery.executionDeadlineAt,1802000);assert.equal(JSON.stringify(result).includes('must-not-output'),false);
});
test('uncertain transport replays identical request ID at most twice',async()=>{
  const f=setup();f.deps.send=async body=>{f.posts.push(structuredClone(body));return f.posts.length===1?{status:null,uncertain:true}:{status:200,uncertain:false,value:reply('queued')};};
  const result=await recoverInterrupted(releaseSha,manifest,carryover,f.receipt,f.deps);
  assert.equal(result.status,'accepted');assert.equal(result.result.status,'queued');assert.deepEqual(f.posts[0],f.posts[1]);assert.equal(result.attempts[0].status,'uncertain');
  const failed=setup({send:async()=>({status:503,uncertain:true})});
  await assert.rejects(recoverInterrupted(releaseSha,manifest,carryover,failed.receipt,failed.deps),/two identical requests/);
  assert.equal(failed.evidence.at(-1).attempts.length,2);assert.equal(failed.evidence.at(-1).status,'failed');
});
test('explicit rejection and wrong response identity never authorize another attempt',async()=>{
  for(const response of [{status:409,uncertain:false},{status:200,uncertain:false,value:{...reply(),analysisId:requestId}},
    {status:200,uncertain:false,value:{...reply(),recovery:{...reply().recovery,createdAt:2001}}},
    {status:200,uncertain:false,value:{...reply(),threadId:manifest.expectedThreadId}},
    {status:200,uncertain:false,value:{...reply(),idempotencyKey:original.idempotencyKey}}]) {
    const f=setup({send:async()=>response});
    await assert.rejects(recoverInterrupted(releaseSha,manifest,carryover,f.receipt,f.deps));
    assert.equal(f.evidence.at(-1).attempts.length,1);assert.deepEqual(f.receipt,original);
  }
});
test('wrong carryover, execution context or unpaused current Web prevents any POST',async()=>{
  for(const patch of [{env:{...env,GITHUB_ACTIONS:'false'}},{env:{...env,MOSOO_PROJECT_AGENT_ID:'WRONG'}},
    {paused:async()=>({...web,mode:'all'})},{paused:async()=>({...web,sourceSha:oldSha})}]) {
    const f=setup(patch);await assert.rejects(recoverInterrupted(releaseSha,manifest,carryover,f.receipt,f.deps));assert.equal(f.posts.length,0);
  }
  const f=setup();await assert.rejects(recoverInterrupted(releaseSha,{...manifest,analysisId:requestId},carryover,f.receipt,f.deps));assert.equal(f.posts.length,0);
});
test('Web changes between uncertain requests stop replay, and after acceptance prevent passed receipt',async()=>{
  for(const uncertain of [true,false]) {
    let reads=0;const f=setup({paused:async()=>({...web,workerVersionId:++reads===1?web.workerVersionId:requestId}),send:async()=>uncertain?{status:null,uncertain:true}:{status:200,uncertain:false,value:reply()}});
    await assert.rejects(recoverInterrupted(releaseSha,manifest,carryover,f.receipt,f.deps),/paused Web changed/);
    assert.equal(f.evidence.at(-1).attempts.length,1);assert.equal(f.evidence.at(-1).status,'failed');
  }
});
test('sender uses only fixed protected route and Bearer, bounds and sanitizes all responses',async()=>{
  const secret='s'.repeat(32);let calls=0;
  const sender=operatorSender(secret,async(url,options)=>{
    calls++;assert.equal(url,'https://ghfind.beiming1201.workers.dev/api/internal/project-analyses/reconcile');
    assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,`Bearer ${secret}`);assert.ok(options.signal instanceof AbortSignal);
    return Response.json(reply());
  });
  assert.equal((await sender({requestId})).status,200);assert.equal(calls,1);assert.equal(limits.requests,2);assert.equal(limits.requestMs,15000);
  for(const [response,uncertain] of [[new Response('private',{status:401}),false],[new Response('private',{status:503}),true],[new Response('{',{status:200}),true],[new Response('x'.repeat(4097),{status:200}),true]]) {
    const result=await operatorSender(secret,async()=>response)({requestId});assert.equal(result.uncertain,uncertain);assert.equal(JSON.stringify(result).includes('private'),false);
  }
  const result=await operatorSender(secret,async()=>{throw new Error('private transport credentials');})({requestId});assert.deepEqual(result,{uncertain:true,status:null});
});
test('a transport ignoring abort still returns uncertain at the exact request deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let signal;
  const pending=operatorSender('s'.repeat(32),async(_url,options)=>{signal=options.signal;return new Promise(()=>{});})({requestId});
  t.mock.timers.tick(15000);
  assert.deepEqual(await pending,{uncertain:true,status:null});assert.equal(signal.aborted,true);
});
test('failure to persist pre-POST intent prevents the mutation',async()=>{
  const f=setup({record:r=>{if(r.attempts.length)throw new Error('disk full');}});
  await assert.rejects(recoverInterrupted(releaseSha,manifest,carryover,f.receipt,f.deps),/disk full/);assert.equal(f.posts.length,0);
});
test('lost acknowledgement and later Actions resume retain one server audit, retry key and deadline through finalizing',async()=>{
  const server=reply('finalizing');
  const lost=setup({send:async()=>({status:null,uncertain:true})});
  await assert.rejects(recoverInterrupted(releaseSha,manifest,carryover,lost.receipt,lost.deps),/two identical requests/);
  const recovered=setup({env:{...env,GITHUB_RUN_ID:'457'},send:async()=>({status:200,uncertain:false,value:server})});
  const accepted=await recoverInterrupted(releaseSha,manifest,carryover,recovered.receipt,recovered.deps);
  assert.equal(accepted.result.status,'finalizing');
  const resumed={...structuredClone(original),idempotencyKey:server.idempotencyKey,polls:17,waitStartedAt:server.recovery.createdAt,
    operatorRecovery:{...server.recovery,priorReceiptSHA256:accepted.originalReceiptSHA256,previousAttempt:structuredClone(original)}};
  const before=structuredClone(resumed);
  const deps=setup({env:{...env,GITHUB_RUN_ID:'458'},send:async()=>({status:200,uncertain:false,value:server})}).deps;
  const result=await recoverInterrupted(releaseSha,manifest,carryover,resumed,deps);
  assert.equal(result.result.recovery.executionDeadlineAt,accepted.result.recovery.executionDeadlineAt);
  assert.equal(result.result.idempotencyKey,`ghfind-project-${analysisId}-retry-1`);assert.deepEqual(resumed,before);
  assert.equal(resumed.polls,17);assert.equal(result.request.operatorRef,'github-actions:458:1');
  for(const patch of [{createdAt:3000,executionDeadlineAt:1803000},{requestId:intentId}]) {
    const bad=setup({send:async()=>({status:200,uncertain:false,value:{...server,recovery:{...server.recovery,...patch}}})});
    await assert.rejects(recoverInterrupted(releaseSha,manifest,carryover,resumed,bad.deps));
  }
});
test('same retry key without matching operator audit and any retry-2 key are refused before POST',async()=>{
  for(const receipt of [{...original,idempotencyKey:`ghfind-project-${analysisId}-retry-1`},
    {...original,idempotencyKey:`ghfind-project-${analysisId}-retry-2`},
    {...original,idempotencyKey:`ghfind-project-${analysisId}-retry-1`,operatorRecovery:{...reply().recovery,requestId:intentId}}]) {
    const f=setup();await assert.rejects(recoverInterrupted(releaseSha,manifest,carryover,receipt,f.deps));assert.equal(f.posts.length,0);
  }
  const f=setup({send:async()=>({status:200,uncertain:false,value:{...reply(),idempotencyKey:`ghfind-project-${analysisId}-retry-2`,recovery:{...reply().recovery,nextIdempotencyKey:`ghfind-project-${analysisId}-retry-2`}}})});
  await assert.rejects(recoverInterrupted(releaseSha,manifest,carryover,f.receipt,f.deps));
});
test('final retry retains first audit and allows only one new distinct bounded operation',async()=>{
  const first=reply();
  const receipt={...structuredClone(original),idempotencyKey:first.idempotencyKey,providerRunRetries:1,
    operatorRecovery:{...first.recovery,priorReceiptSHA256:createHash('sha256').update(JSON.stringify(original)).digest('hex'),previousAttempt:structuredClone(original)}};
  const finalManifest={...manifest,format:'ghfind-production-assessment-operator-v2',retryNumber:2,
    predecessorRequestId:requestId,requestId:intentId,expectedThreadId:first.threadId,expectedRunId:first.runId};
  const finalReply={...first,idempotencyKey:`${original.idempotencyKey}-retry-2`,threadId:manifest.expectedThreadId,runId:manifest.expectedRunId,
    recovery:{...first.recovery,action:'retry_interrupted_final',requestId:intentId,createdAt:4000000,executionDeadlineAt:5800000,
      priorThreadId:first.threadId,priorRunId:first.runId,nextIdempotencyKey:`${original.idempotencyKey}-retry-2`}};
  const f=setup({send:async body=>{assert.equal(body.action,'retry_interrupted_final');return {status:200,uncertain:false,value:finalReply};}});
  const before=structuredClone(receipt);
  const accepted=await recoverInterrupted(releaseSha,finalManifest,carryover,receipt,f.deps);
  assert.equal(accepted.result.idempotencyKey,finalReply.idempotencyKey);assert.deepEqual(receipt,before);
  const resumed={...receipt,idempotencyKey:finalReply.idempotencyKey,operatorRecovery:{...finalReply.recovery,priorReceiptSHA256:createHash('sha256').update(JSON.stringify(before)).digest('hex'),previousAttempt:before},polls:29};
  await recoverInterrupted(releaseSha,finalManifest,carryover,resumed,f.deps);assert.equal(resumed.polls,29);
  const broken=structuredClone(resumed);delete broken.operatorRecovery.previousAttempt;
  await assert.rejects(recoverInterrupted(releaseSha,finalManifest,carryover,broken,f.deps));
  await assert.rejects(recoverInterrupted(releaseSha,{...finalManifest,predecessorRequestId:analysisId},carryover,resumed,f.deps));
  for(const patch of [{retryNumber:3},{requestId},{predecessorRequestId:analysisId}])
    await assert.rejects(recoverInterrupted(releaseSha,{...finalManifest,...patch},carryover,receipt,f.deps));
  await assert.rejects(recoverInterrupted(releaseSha,finalManifest,carryover,original,f.deps));
  await assert.rejects(recoverInterrupted(releaseSha,finalManifest,carryover,{...receipt,operatorRecovery:undefined},f.deps));
});
