import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ACCOUNT} from './feed-production-release.mjs';
import {inspectRollout,waitForRollouts,rolloutReader,limits,retryableHttpStatuses} from './feed-production-rollout.mjs';
const manifest=JSON.parse(readFileSync(new URL('../ops/feed-production-manifest.json',import.meta.url)));
const img=n=>`registry.cloudflare.com/${ACCOUNT}/ghfind-feed@sha256:${n.repeat(64)}`;
const image=img('b'),before=img('a');
const previous=['feedapi','feedexecutor'].map((suffix,i)=>({id:`12345678-1234-1234-1234-123456789ab${i}`,name:`${manifest.runtimeWorker}-${suffix}`,version:95,image:before}));
const rollout=(status='completed',extra={})=>({id:'12345678-1234-1234-1234-123456789abc',created_at:'2026-10-15T22:20:26.155Z',
  status,strategy:'rolling',kind:'full_auto',health:{errors:[]},current_configuration:{image:before},target_configuration:{image},current_version:95,target_version:96,
  steps:[{id:1,status,step_size:{percentage:100},completed_at:'2026-10-15T22:23:17.842Z'}],
  progress:{total_steps:1,current_step:1,updated_instances:1,total_instances:1,version_distribution:{target_version_instances:1,current_version_instances:0,target_version_percentage:100}},...extra});
const app=p=>({...p,account_id:ACCOUNT,scheduling_policy:'default',version:96,configuration:{image}});
const get=async path=>{const p=previous.find(p=>path.includes(p.id));return path.endsWith('/rollouts')?[rollout()]:app(p);};
test('waits for actual completed rollout instead of a 130-second delay and records platform completion time',async()=>{
  let clock=Date.parse('2026-10-15T22:22:45.535Z'),reads=0;const records=[];
  const result=await waitForRollouts(manifest,image,previous,{now:()=>clock,sleep:async ms=>{clock+=ms;},record:v=>records.push(structuredClone(v)),get:async path=>{
    reads++;if(path.endsWith('/rollouts'))return [rollout(clock<Date.parse('2026-10-15T22:23:17.842Z')?'progressing':'completed')];return get(path);
  }});
  assert.equal(result.status,'passed');assert.equal(result.applications.length,2);assert.ok(clock>=Date.parse('2026-10-15T22:23:17.842Z'));
  assert.equal(result.applications[1].completedAt,'2026-10-15T22:23:17.842Z');assert.equal(result.requests,reads);
  assert.ok(records.some(r=>r.status==='attempted_unverified'));assert.equal(reads,20);
});
test('historical replaced rollouts are allowed but newest wrong image, replacement, unknown status or inconsistent completion fail',()=>{
  const old=rollout('replaced',{id:'12345678-1234-1234-1234-123456789abd',created_at:'2026-10-14T22:20:26Z',target_configuration:{image:before}});
  assert.equal(inspectRollout(app(previous[0]),[old,rollout()],previous[0],image).status,'passed');
  for(const patch of [{status:'replaced'},{status:'reverted'},{status:'unknown'},{target_configuration:{image:img('c')}},{current_version:94},
    {health:{errors:[{message:'private error'}]}},{progress:{...rollout().progress,version_distribution:{target_version_percentage:99}}},
    {steps:[{...rollout().steps[0],status:'pending'}]}])assert.throws(()=>inspectRollout(app(previous[0]),[rollout('completed',patch)],previous[0],image));
  for(const patch of [{id:previous[1].id},{name:'foreign'},{account_id:'foreign'},{configuration:{image:img('c')}},{version:97}])
    assert.throws(()=>inspectRollout({...app(previous[0]),...patch},[rollout()],previous[0],image));
});
test('only exact previous metadata may converge; anchored rollouts cannot disappear or be superseded',()=>{
  const old=rollout('completed',{target_configuration:{image:before},target_version:95});
  assert.equal(inspectRollout({...app(previous[0]),version:95,configuration:{image:before}},[old],previous[0],image).status,'pending');
  const anchor=inspectRollout(app(previous[0]),[rollout('progressing')],previous[0],image);
  assert.throws(()=>inspectRollout(app(previous[0]),[old],previous[0],image,anchor));
  assert.throws(()=>inspectRollout(app(previous[0]),[rollout('completed',{id:'12345678-1234-1234-1234-123456789abf'})],previous[0],image,anchor),/superseded/);
  assert.throws(()=>inspectRollout(app(previous[0]),[],previous[0],image));
});
test('pending rollout exhausts bounded reads/time with failed safe receipt and no mutation capability',async()=>{
  let clock=0,last,calls=0;
  await assert.rejects(waitForRollouts(manifest,image,previous,{now:()=>clock,sleep:async ms=>{clock+=ms;},record:v=>{last=structuredClone(v);},get:async path=>{
    calls++;return path.endsWith('/rollouts')?[rollout('pending')]:get(path);
  }}),/budget/);
  assert.equal(last.status,'failed');assert.ok(calls<=limits.requests);assert.ok(clock<=limits.durationMs);
  await assert.rejects(waitForRollouts(manifest,image,[previous[0]],{get}),/two_previous/);
});
test('read failures and deadline crossings never produce success receipts or expose raw errors',async()=>{
  let last,clock=0;
  await assert.rejects(waitForRollouts(manifest,image,previous,{record:v=>{last=structuredClone(v);},get:async()=>{throw Error('private token detail');}}));
  assert.equal(last.failureCode,'rollout_read_failed');assert.equal(JSON.stringify(last).includes('private token'),false);
  await assert.rejects(waitForRollouts(manifest,image,previous,{now:()=>clock,record:v=>{last=structuredClone(v);},get:async path=>{clock=300001;return get(path);}}),/deadline/);
  assert.equal(last.status,'failed');
});
test('reader only permits fixed application GETs, bounds responses and rejects error envelopes',async()=>{
  const calls=[];
  const reader=rolloutReader('private',async(url,options)=>{calls.push({url,options});return Response.json({success:true,result:[]});});
  await reader(`/containers/applications/${previous[0].id}/rollouts`,AbortSignal.timeout(1000));
  assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.redirect,'error');
  await assert.rejects(reader('/containers/applications/foreign/restart'),/path/);
  for(const response of [new Response('',{status:403}),new Response('invalid'),Response.json({success:false,result:[]}),new Response('x'.repeat(limits.responseBytes+1))])
    await assert.rejects(rolloutReader('private',async()=>response)(`/containers/applications/${previous[0].id}`));
});
test('rate-limited Containers reads retry inside the budget and 403 still fails closed',async()=>{
  assert.deepEqual(retryableHttpStatuses,[408,429,500,502,503,504]);
  let clock=Date.parse('2026-10-16T16:35:36.188Z'),reads=0;const records=[];
  const retry=status=>{const error=new Error('rollout_http_retryable');error.httpStatus=status;error.retryAfterMs=15000;throw error;};
  const result=await waitForRollouts(manifest,image,previous,{now:()=>clock,sleep:async ms=>{clock+=ms;},record:v=>records.push(structuredClone(v)),get:async path=>{
    reads++;if(reads===8)retry(429);if(path.endsWith('/rollouts'))return [rollout(clock<Date.parse('2026-10-16T16:36:10Z')?'progressing':'completed')];return get(path);
  }});
  assert.equal(result.status,'passed');assert.ok(clock>=Date.parse('2026-10-16T16:36:10Z'));
  assert.ok(records.some(r=>r.observations.some(o=>o.reason==='http_retryable'&&o.httpStatus===429&&o.status==='pending')));
  assert.equal(JSON.stringify(result).includes('private'),false);
  const reader=rolloutReader('private',async()=>new Response('private token detail',{status:429,headers:{'retry-after':'12'}}));
  await assert.rejects(reader(`/containers/applications/${previous[0].id}/rollouts`),error=>{
    assert.equal(error.message,'rollout_http_retryable');assert.equal(error.httpStatus,429);assert.equal(error.retryAfterMs,12000);
    assert.equal(error.message.includes('private'),false);return true;
  });
  await assert.rejects(rolloutReader('private',async()=>new Response('',{status:403}))(`/containers/applications/${previous[0].id}`),/rollout_http_read_failed/);
  let last,denied=0;
  await assert.rejects(waitForRollouts(manifest,image,previous,{record:v=>{last=structuredClone(v);},get:async()=>{denied++;const error=new Error('rollout_http_read_failed');error.httpStatus=403;throw error;}}),/rollout_http_read_failed/);
  assert.equal(last.status,'failed');assert.equal(last.failureCode,'rollout_http_read_failed');assert.equal(last.httpStatus,403);assert.equal(denied,1);
});
test('retryable HTTP still fails closed when the wait budget is spent',async()=>{
  let clock=0,last,hits=0;
  await assert.rejects(waitForRollouts(manifest,image,previous,{now:()=>clock,sleep:async ms=>{clock+=ms;},record:v=>{last=structuredClone(v);},get:async()=>{
    hits++;const error=new Error('rollout_http_retryable');error.httpStatus=429;throw error;
  }}),/budget/);
  assert.equal(last.status,'failed');assert.equal(last.failureCode,'rollout_wait_budget_exhausted');assert.equal(last.httpStatus,429);
  assert.ok(hits<=limits.requests);assert.ok(clock<=limits.durationMs);assert.ok(last.observations.every(o=>o.status!=='passed'));
});
