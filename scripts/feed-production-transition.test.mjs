import test from 'node:test';
import assert from 'node:assert/strict';
import { readTransitionResponse, transitionActors } from './feed-production-transition.mjs';
const identity = {sourceSha:'a'.repeat(40),imageBuildId:'b'.repeat(64),mode:'baseline',writerEpoch:1};
const anchor = {status:'passed',mode:'paused',sourceSha:identity.sourceSha,backend:'go',store:'cf_d1_r2',workerVersionId:'12345678-1234-4234-8234-123456789abc'};
test('fixed actor transitions are sequential and recheck paused Web through final readback',async()=>{
 const calls=[],states=[];
 const result=await transitionActors(identity,{paused:async()=>{calls.push('paused');return anchor;},send:async(target,body)=>{calls.push(target);return {restarted:true,target,...body};},record:e=>states.push(JSON.parse(JSON.stringify(e)))});
 assert.deepEqual(calls,['paused','api-0','paused','api-1','paused','executor-0','paused']);assert.equal(result.status,'passed');
 assert.equal(states[1].targets[0].status,'attempted_unverified');assert.equal(states.at(-1).targets.length,3);
});
test('changed or unpaused Web prevents the next mutation, including changes after final actor',async()=>{
 for(const changeAt of [1,2,4]){let reads=0,sends=0;await assert.rejects(transitionActors(identity,{paused:async()=>++reads===changeAt?{...anchor,workerVersionId:'12345678-1234-4234-8234-123456789def',mode:changeAt===1?'all':'paused'}:anchor,send:async(target,body)=>{sends++;return {restarted:true,target,...body};}}));assert.equal(sends,changeAt-1);}
});
test('lost acknowledgements are recorded as failed and never replayed blindly',async()=>{
 let sends=0,final;await assert.rejects(transitionActors(identity,{paused:async()=>anchor,send:async()=>{sends++;throw Error('lost reply');},record:e=>final=JSON.parse(JSON.stringify(e))}),/lost reply/);assert.equal(sends,1);assert.equal(final.status,'failed');assert.equal(final.targets[0].status,'attempted_unverified');
});
test('wrong identity, targets, extra fields or an incomplete restart cannot advance',async()=>{
 for(const patch of [{sourceSha:'c'.repeat(40)},{imageBuildId:'c'.repeat(64)},{target:'api-1'},{mode:'off'},{writerEpoch:2},{restarted:false},{extra:'untrusted'}]){let sends=0;await assert.rejects(transitionActors(identity,{paused:async()=>anchor,send:async(target,body)=>{sends++;return {restarted:true,target,...body,...patch};}}));assert.equal(sends,1);}
});

import { edgePreflight, configurationLimits } from './feed-production-transition.mjs';
const offVersion='12345678-1234-4234-8234-123456789001', baselineVersion='12345678-1234-4234-8234-123456789002';
const off={runtime:{versionId:offVersion},image:'image@sha256:exact'};
const configuration=(mode='baseline')=>({service:'feed-runtime',version:identity.sourceSha,contractVersion:'1',workerVersionId:mode==='off'?offVersion:baselineVersion,configuredImage:off.image,imageBuildId:identity.imageBuildId,mode,writerEpoch:1});
test('known off propagates to exact baseline before each mutation',async()=>{
 let reads=0,clock=0;const observations=[];
 const preflight=edgePreflight(identity,off,{now:()=>clock,sleep:async ms=>{clock+=ms;},read:async()=>configuration(++reads===1?'off':'baseline')});
 const result=await transitionActors(identity,{paused:async()=>anchor,preflight,send:async(target,body)=>({restarted:true,target,...body}),record:e=>observations.push(JSON.parse(JSON.stringify(e)))});
 assert.equal(reads,4);assert.equal(clock,configurationLimits.intervalMs);assert.equal(result.status,'passed');assert.equal(result.edgePreflight[1].status,'known_off');
});
test('bounded stale off and invalid identities fail without mutation',async()=>{
 for(const patch of [null,{version:'c'.repeat(40)},{imageBuildId:'c'.repeat(64)},{configuredImage:'wrong'},{writerEpoch:2},{extra:true},{workerVersionId:baselineVersion,mode:'off'}]){
 let reads=0,sends=0,clock=0;
 const preflight=edgePreflight(identity,off,{now:()=>clock,sleep:async ms=>{clock+=ms;},read:async()=>{reads++;return patch?{...configuration(),...patch}:configuration('off');}});
 await assert.rejects(transitionActors(identity,{paused:async()=>anchor,preflight,send:async()=>{sends++;}}));
 assert.equal(sends,0);assert.equal(reads,patch?1:36);assert.ok(clock<configurationLimits.durationMs);
 }
});
test('only explicit pre-dispatch rejection repeats preflight and preserves unknown outcomes',async()=>{
 for(const kind of ['rejected','transport','exhausted']){
 let reads=0,sends=0;
 const preflight=edgePreflight(identity,off,{read:async()=>{reads++;return configuration();}});
 const work=transitionActors(identity,{paused:async()=>anchor,preflight,send:async(target,body)=>{sends++;if(kind==='transport')throw Error('lost');if(kind==='exhausted'||sends===1)return {rejectedWithoutMutation:true};return {restarted:true,target,...body};}});
 if(kind==='rejected'){const result=await work;assert.equal(result.targets[0].rejectedWithoutMutation,1);assert.equal(sends,4);assert.equal(reads,4);}
 else {await assert.rejects(work);assert.equal(sends,kind==='transport'?1:3);}
 }
});
test('read transport error and overall deadline cannot reach restart',async()=>{
 for(const slow of [false,true]){let clock=0,sends=0;
 const preflight=edgePreflight(identity,off,{now:()=>clock,read:async()=>{if(!slow)throw Error('network');clock=configurationLimits.durationMs;return configuration();}});
 await assert.rejects(transitionActors(identity,{paused:async()=>anchor,preflight,send:async()=>{sends++;}}));assert.equal(sends,0);
 }
});

import { validatePreDispatchRejection } from './feed-production-transition.mjs';
test('rejection whitelist permits only known off version and exact pre-dispatch error',()=>{
 const valid={error:'transition_environment_not_ready',workerVersionId:offVersion};
 assert.doesNotThrow(()=>validatePreDispatchRejection(valid,offVersion));
 for(const value of [null,{}, {...valid,error:'transition_in_progress'},{...valid,workerVersionId:baselineVersion},{...valid,extra:true}])
 assert.throws(()=>validatePreDispatchRejection(value,offVersion));
});

test('successful lifecycle time between probes does not spend cumulative preflight allowance',async()=>{
 let clock=1000,reads=0;
 const preflight=edgePreflight(identity,off,{now:()=>clock,read:async()=>{reads++;clock+=100;return configuration();}});
 await preflight(()=>{});clock+=90000;await preflight(()=>{});clock+=90000;await preflight(()=>{});
 assert.equal(reads,3);
});
test('preflight wall time accumulates across calls and never gains a fresh allowance',async()=>{
 let clock=1000,reads=0;
 const preflight=edgePreflight(identity,off,{now:()=>clock,sleep:async ms=>{clock+=ms;},read:async()=>{reads++;clock+=configurationLimits.durationMs/3;return configuration(reads===2?'off':'baseline');}});
 await preflight(()=>{});clock+=90000;
 await assert.rejects(preflight(()=>{}),/deadline exceeded/);
 assert.equal(reads,3);
 await assert.rejects(preflight(()=>{}),/exhausted/);
 assert.equal(reads,3);
});

import { rejectionCode } from './feed-production-transition.mjs';
test('a rejected transition names only the runtime error code', async () => {
  const reply = (body) => new Response(body, { status: 503 });
  assert.equal(await rejectionCode(reply('{"error":"container_not_ready"}')), 'container_not_ready');
  assert.equal(await rejectionCode(reply('{"error":"Bearer secret value"}')), 'unrecognized_error_body');
  assert.equal(await rejectionCode(reply('<html>bad gateway</html>')), 'unreadable_error_body');
  assert.equal(await rejectionCode(reply('x'.repeat(4096))), 'unreadable_error_body');
});

test('HTTP 200 restart receipts are read once and reach every release identity check', async () => {
  const responses = [], calls = [];
  const result = await transitionActors(identity, {
    paused: async () => anchor,
    send: async (target, body) => {
      calls.push(target);
      const response = Response.json({ restarted: true, target, ...body });
      responses.push(response);
      return readTransitionResponse(response, target, offVersion);
    },
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(calls, ['api-0', 'api-1', 'executor-0']);
  assert.ok(responses.every(response => response.bodyUsed));
});

test('HTTP success does not bypass exact receipt identity or permit replay after malformed replies', async () => {
  for (const body of [
    { rejectedWithoutMutation: true },
    { restarted: true, target: 'api-0', ...identity, sourceSha: 'c'.repeat(40) },
    { restarted: true, target: 'api-0', ...identity, extra: true },
    { kind: 'http-error', code: 'invalid_transition', status: 400 },
    'invalid JSON', 'x'.repeat(4096),
  ]) {
    let calls = 0;
    await assert.rejects(transitionActors(identity, {
      paused: async () => anchor,
      preflight: async () => {},
      send: async target => {
        calls++;
        const response = typeof body === 'string' ? new Response(body) : Response.json(body);
        return readTransitionResponse(response, target, offVersion);
      },
    }));
    assert.equal(calls, 1);
  }
});

test('HTTP failures expose only bounded error codes and never retry an unknown mutation outcome', async () => {
  for (const [status, body, message] of [
    [400, { error: 'invalid_transition' }, /400; api-0; invalid_transition/],
    [503, { error: 'transition_timeout' }, /503; api-0; transition_timeout/],
    [503, { error: 'private provider message' }, /503; api-0; unrecognized_error_body/],
    [409, { error: 'transition_in_progress' }, /unproven transition rejection/],
    [409, { error: 'transition_environment_not_ready', workerVersionId: baselineVersion }, /unproven transition rejection/],
    [409, { error: 'transition_environment_not_ready', workerVersionId: offVersion, extra: true }, /unproven transition rejection/],
  ]) {
    let calls = 0;
    await assert.rejects(transitionActors(identity, {
      paused: async () => anchor,
      preflight: async () => {},
      send: async target => {
        calls++;
        return readTransitionResponse(Response.json(body, { status }), target, offVersion);
      },
    }), message);
    assert.equal(calls, 1);
  }
});

test('only a proven HTTP 409 from the known off edge can repeat preflight', async () => {
  let calls = 0, preflights = 0;
  const result = await transitionActors(identity, {
    paused: async () => anchor,
    preflight: async () => { preflights++; },
    send: async (target, body) => {
      const response = ++calls === 1
        ? Response.json({ error: 'transition_environment_not_ready', workerVersionId: offVersion }, { status: 409 })
        : Response.json({ restarted: true, target, ...body });
      return readTransitionResponse(response, target, offVersion);
    },
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.targets[0].rejectedWithoutMutation, 1);
  assert.equal(calls, 4);
  assert.equal(preflights, 4);
});

const actorIds = new Map(['api-0','api-1','executor-0'].map((target, index) => [target, String(index + 1).repeat(64)]));
const nativeOff = { ...off, readiness: [...actorIds].map(([target, actorId]) => ({ target, actorId })) };
const actorConfiguration = (target, mode = 'baseline') => ({
 target, actorId: actorIds.get(target), workerVersionId: mode === 'off' ? offVersion : baselineVersion,
 sourceSha: identity.sourceSha, configuredImage: off.image, imageBuildId: identity.imageBuildId, mode, writerEpoch: 1,
});
test('all three DO environments converge before first lifecycle mutation; each later actor is rechecked', async () => {
 let clock=0, actorReads=0;
 const seen=[], calls=[];
 const preflight=edgePreflight(identity,nativeOff,{
  now:()=>clock,sleep:async ms=>{clock+=ms;},read:async()=>configuration(),
  readActor:async target=>{actorReads++;calls.push(`read:${target}`);seen.push(target);return actorConfiguration(target,actorReads===1?'off':'baseline');},
 });
 await transitionActors(identity,{paused:async()=>anchor,preflight,send:async(target,body)=>{
  assert.deepEqual([...new Set(seen)],['api-0','api-1','executor-0']);calls.push(`post:${target}`);clock+=30000;return {restarted:true,target,...body};
 }});
 assert.deepEqual(calls,['read:api-0','read:api-0','read:api-1','read:executor-0','post:api-0','read:api-1','post:api-1','read:executor-0','post:executor-0']);
 assert.equal(clock,90000+configurationLimits.intervalMs);
});
test('foreign, malformed or unavailable DO configuration never grants a first lifecycle POST', async () => {
 for(const patch of [null,{}, {actorId:'f'.repeat(64)},{target:'api-1'}, {sourceSha:'c'.repeat(40)},
  {imageBuildId:'c'.repeat(64)},{configuredImage:'other'}, {writerEpoch:2}, {mode:'baseline',workerVersionId:offVersion},
  {mode:'off',workerVersionId:baselineVersion},{workerVersionId:'12345678-1234-4234-8234-123456789099'},{extra:true},'missing method']) {
  let sends=0,reads=0;
  const preflight=edgePreflight(identity,nativeOff,{read:async()=>configuration(),readActor:async target=>{
   reads++;if(patch==='missing method')throw Error('runtime configuration preflight rejected (503)');
   return patch===null?null:Object.keys(patch).length?{...actorConfiguration(target),...patch}:{};
  }});
  await assert.rejects(transitionActors(identity,{paused:async()=>anchor,preflight,send:async()=>{sends++;}}));
  assert.equal(sends,0);assert.equal(reads,1);
 }
});
test('edge and all actor reads share time and request budgets before first mutation', async () => {
 let clock=0,reads=0,sends=0;
 const preflight=edgePreflight(identity,nativeOff,{now:()=>clock,sleep:async ms=>{clock+=ms;},
  read:async()=>{reads++;clock+=120000;return configuration();},
  readActor:async target=>{reads++;clock+=30000;return actorConfiguration(target,'off');},
 });
 await assert.rejects(transitionActors(identity,{paused:async()=>anchor,preflight,send:async()=>{sends++;}}),/deadline exceeded/);
 assert.equal(reads,3);assert.equal(sends,0);
 await assert.rejects(preflight(()=>{}),/exhausted/);assert.equal(reads,3);
 let gets=0;
 const capped=edgePreflight(identity,nativeOff,{now:()=>0,sleep:async()=>{},read:async()=>{gets++;return configuration();},
  readActor:async target=>{gets++;return actorConfiguration(target,'off');},
 });
 await assert.rejects(capped(()=>{}),/exhausted/);assert.equal(gets,configurationLimits.reads);
});
test('configuration proof does not authorize replay if a POST races propagation or loses its reply', async () => {
 for(const response of [Response.json({error:'invalid_transition'},{status:400}),null]) {
  let sends=0;
  const preflight=edgePreflight(identity,nativeOff,{read:async()=>configuration(),readActor:async target=>actorConfiguration(target)});
  await assert.rejects(transitionActors(identity,{paused:async()=>anchor,preflight,send:async target=>{
   sends++;if(!response)throw Error('lost reply');return readTransitionResponse(response,target,offVersion);
  }}));assert.equal(sends,1);
 }
});


test('exact known-off DO may converge after 90 seconds without any lifecycle call before all actors match',async()=>{
 let clock=0,sends=0,gets=0;
 const seen=new Set();
 const preflight=edgePreflight(identity,nativeOff,{now:()=>clock,sleep:async ms=>{clock+=ms;},
  read:async()=>{gets++;return configuration();},readActor:async target=>{gets++;const mode=clock<90000?'off':'baseline';if(mode==='baseline')seen.add(target);return actorConfiguration(target,mode);}});
 const result=await transitionActors(identity,{paused:async()=>anchor,preflight,send:async(target,body)=>{
  assert.equal(clock,90000);assert.equal(seen.size,3);sends++;return {restarted:true,target,...body};}});
 assert.equal(result.status,'passed');assert.equal(sends,3);assert.ok(gets<configurationLimits.reads);
 assert.ok(result.edgePreflight.some(o=>o.elapsedMs===90000&&o.scope==='actor'&&o.status==='baseline_verified'));
 assert.ok(result.edgePreflight.every(o=>o.elapsedMs<=configurationLimits.durationMs));
});
test('slow actors share one three-minute allowance rather than each receiving a new window',async()=>{
 let clock=0,sends=0,gets=0;
 const preflight=edgePreflight(identity,nativeOff,{now:()=>clock,sleep:async ms=>{clock+=ms;},
  read:async()=>{gets++;return configuration();},readActor:async target=>{gets++;return actorConfiguration(target,
   clock>=({'api-0':90000,'api-1':190000,'executor-0':190000}[target])?'baseline':'off');}});
 await assert.rejects(transitionActors(identity,{paused:async()=>anchor,preflight,send:async()=>{sends++;}}),/exhausted/);
 assert.equal(sends,0);assert.ok(clock<configurationLimits.durationMs);assert.ok(gets<configurationLimits.reads);
});

test('controlled refresh is sent once per known-off actor; only exact GET proves readiness',async()=>{
 let clock=0,posts=0;const refreshed=new Set(),observations=[],verified=new Set();
 const preflight=edgePreflight(identity,nativeOff,{now:()=>clock,sleep:async ms=>{clock+=ms;},read:async()=>configuration(),
  readActor:async target=>{const mode=refreshed.has(target)?'baseline':'off';if(mode==='baseline')verified.add(target);return actorConfiguration(target,mode);},
  refresh:async(target,body,timeout)=>{
   assert.ok(observations.some(v=>v.scope==='refresh'&&v.actor===target&&v.status==='attempted_unverified'));
   assert.deepEqual(body,{...identity,offVersionId:offVersion,baselineVersionId:baselineVersion,actorId:actorConfiguration(target).actorId});
   assert.ok(timeout<=10000);assert.equal(refreshed.has(target),false);refreshed.add(target);clock+=1000;
   if(target==='api-0')throw Error('lost reply');return {status:'uncertain',httpStatus:503};
  }});
 const result=await transitionActors(identity,{paused:async()=>anchor,preflight,record:e=>{observations.splice(0,observations.length,...(e.edgePreflight??[]));},
  send:async(target,body)=>{assert.equal(verified.size,3);posts++;return {restarted:true,target,...body};}});
 assert.equal(result.status,'passed');assert.equal(refreshed.size,3);assert.equal(posts,3);
 assert.ok(result.edgePreflight.some(v=>v.scope==='refresh'&&v.httpStatus===null));
});
test('refresh of a persistently old actor cannot authorize restart or resend after a lost reply',async()=>{
 let clock=0,refreshes=0,restarts=0;
 const preflight=edgePreflight(identity,nativeOff,{now:()=>clock,sleep:async ms=>{clock+=ms;},read:async()=>configuration(),
  readActor:async target=>actorConfiguration(target,'off'),refresh:async()=>{refreshes++;throw Error('unknown');}});
 await assert.rejects(transitionActors(identity,{paused:async()=>anchor,preflight,send:async()=>{restarts++;}}),/exhausted/);
 assert.equal(refreshes,1);assert.equal(restarts,0);assert.ok(clock<configurationLimits.durationMs);
});
test('refresh never dispatches on changed paused anchor or foreign actor identity',async()=>{
 for(const change of ['anchor','actor']){
  let checks=0,refreshes=0;
  const preflight=edgePreflight(identity,nativeOff,{read:async()=>configuration(),readActor:async target=>({...actorConfiguration(target,'off'),...(change==='actor'?{actorId:'f'.repeat(64)}:{})}),
   refresh:async()=>{refreshes++;return {status:'uncertain',httpStatus:503};}});
  await assert.rejects(transitionActors(identity,{paused:async()=>({...anchor,workerVersionId:++checks>1&&change==='anchor'?offVersion:anchor.workerVersionId}),preflight,send:async()=>assert.fail()}));
  assert.equal(refreshes,0);
 }
});
test('refresh rejected HTTP statuses remain fail-closed and successful HTTP is not readiness',async()=>{
 const {readRefreshResponse}=await import('./feed-production-transition.mjs');
 for(const status of [400,401,403,404,405,409]){
  let refreshes=0,reads=0;
  const preflight=edgePreflight(identity,nativeOff,{read:async()=>configuration(),readActor:async target=>{reads++;return actorConfiguration(target,'off');},
   refresh:async()=>{refreshes++;return readRefreshResponse(new Response('',{status}));}});
  await assert.rejects(transitionActors(identity,{paused:async()=>anchor,preflight,send:async()=>assert.fail()}),/explicitly rejected/);
  assert.equal(refreshes,1);assert.equal(reads,1);
 }
 assert.deepEqual(await readRefreshResponse(Response.json({error:'refresh_outcome_unknown'},{status:503})),{status:'uncertain',httpStatus:503});
 for(const body of [{error:'different'}, {error:'refresh_outcome_unknown',extra:true}])
  assert.deepEqual(await readRefreshResponse(Response.json(body,{status:503})),{status:'rejected',httpStatus:503});
 assert.deepEqual(await readRefreshResponse(new Response('unreadable',{status:503})),{status:'rejected',httpStatus:503});
 assert.deepEqual(await readRefreshResponse(new Response('',{status:200})),{status:'rejected',httpStatus:200});
});
test('refresh time consumes shared propagation allowance instead of granting a new window',async()=>{
 let clock=0,refreshes=0,restarts=0;
 const preflight=edgePreflight(identity,nativeOff,{now:()=>clock,read:async()=>configuration(),readActor:async target=>actorConfiguration(target,'off'),
  refresh:async()=>{refreshes++;clock=configurationLimits.durationMs;return {status:'uncertain',httpStatus:503};}});
 await assert.rejects(transitionActors(identity,{paused:async()=>anchor,preflight,send:async()=>{restarts++;}}),/deadline/);
 assert.equal(refreshes,1);assert.equal(restarts,0);
});
test('refresh reservations survive subsequent preflight calls',async()=>{
 let clock=0,regressed=false;const counts=new Map();
 const preflight=edgePreflight(identity,nativeOff,{now:()=>clock,sleep:async ms=>{clock+=ms;},read:async()=>configuration(),
  readActor:async target=>actorConfiguration(target,counts.has(target)&&!(regressed&&target==='api-1')?'baseline':'off'),
  refresh:async target=>{counts.set(target,(counts.get(target)??0)+1);return {status:'uncertain',httpStatus:503};}});
 await preflight(()=>{},'api-0',async()=>{});regressed=true;
 await assert.rejects(preflight(()=>{},'api-1',async()=>{}),/exhausted/);
 assert.deepEqual([...counts.values()],[1,1,1]);
});
test('exact known-off edge can reject twice before one actual refresh dispatch',async()=>{
 let clock=0,posts=0,edgeReads=0;const attempts=new Map(),current=new Set(),beforePosts=[];
 const preflight=edgePreflight(identity,nativeOff,{now:()=>clock,sleep:async ms=>{clock+=ms;},read:async()=>{edgeReads++;return configuration();},
  readActor:async target=>actorConfiguration(target,current.has(target)?'baseline':'off'),
  refresh:async(target)=>{const n=(attempts.get(target)??0)+1;attempts.set(target,n);beforePosts.push(edgeReads);
   if(target==='api-0'&&n<3)return {status:'pre_dispatch_rejection',httpStatus:409,code:'refresh_edge_not_ready'};
   posts++;current.add(target);return {status:'uncertain',httpStatus:503};}});
 const result=await transitionActors(identity,{paused:async()=>anchor,preflight,send:async(target,body)=>({restarted:true,target,...body})});
 assert.equal(result.status,'passed');assert.equal(attempts.get('api-0'),3);assert.equal(posts,3);
 assert.ok(beforePosts[1]>beforePosts[0]&&beforePosts[2]>beforePosts[1]);
});
test('pre-dispatch refresh rejection bound cannot grant a fourth HTTP attempt',async()=>{
 let clock=0,sends=0,restarts=0;
 const preflight=edgePreflight(identity,nativeOff,{now:()=>clock,sleep:async ms=>{clock+=ms;},read:async()=>configuration(),readActor:async t=>actorConfiguration(t,'off'),
  refresh:async()=>{sends++;return {status:'pre_dispatch_rejection',httpStatus:409,code:'refresh_edge_not_ready'};}});
 await assert.rejects(transitionActors(identity,{paused:async()=>anchor,preflight,send:async()=>{restarts++;}}),/retry bound/);
 assert.equal(sends,3);assert.equal(restarts,0);
});
test('refresh parser only accepts exact race codes and the pinned phase version',async()=>{
 const {readRefreshResponse}=await import('./feed-production-transition.mjs');
 for(const [error,workerVersionId,status] of [['refresh_edge_not_ready',offVersion,'pre_dispatch_rejection'],['refresh_actor_already_current',baselineVersion,'already_current_unverified']]){
  assert.equal((await readRefreshResponse(Response.json({error,workerVersionId},{status:409}),offVersion,baselineVersion)).status,status);
  for(const body of [{error,workerVersionId:'wrong'},{error,workerVersionId,extra:true},{error:'other',workerVersionId}])
   assert.equal((await readRefreshResponse(Response.json(body,{status:409}),offVersion,baselineVersion)).status,'rejected');
 }
 for(const error of ['invalid_refresh_shape','invalid_refresh_identity','invalid_refresh_edge_version','invalid_refresh_actor_version','invalid_refresh_actor_scope'])
  assert.equal((await readRefreshResponse(Response.json({error},{status:400}),offVersion,baselineVersion)).code,error);
 assert.equal((await readRefreshResponse(Response.json({error:'arbitrary_private_value'},{status:400}),offVersion,baselineVersion)).code,undefined);
});
test('already-current refresh response only reconciles GET and never resends',async()=>{
 let clock=0;const attempts=new Map();
 const preflight=edgePreflight(identity,nativeOff,{now:()=>clock,sleep:async ms=>{clock+=ms;},read:async()=>configuration(),
  readActor:async t=>actorConfiguration(t,attempts.has(t)?'baseline':'off'),refresh:async t=>{attempts.set(t,(attempts.get(t)??0)+1);return {status:'already_current_unverified',httpStatus:409,code:'refresh_actor_already_current'};}});
 assert.equal((await transitionActors(identity,{paused:async()=>anchor,preflight,send:async(target,body)=>({restarted:true,target,...body})})).status,'passed');
 assert.deepEqual([...attempts.values()],[1,1,1]);
});

import { ConfigurationRetry, configurationRetryCodes, readConfigurationResponse } from './feed-production-transition.mjs';
test('allowlisted configuration 503s wait after an uncertain refresh without a second reset',async()=>{
 assert.deepEqual(configurationRetryCodes,['container_starting','container_dependency_not_ready','runtime_configuration_unavailable','actor_reset_by_deploy']);
 let clock=0,refreshes=0;const seen=new Map();
 const preflight=edgePreflight(identity,nativeOff,{now:()=>clock,sleep:async ms=>{clock+=ms;},read:async()=>configuration(),
  readActor:async target=>{
   const n=seen.get(target)??0;seen.set(target,n+1);
   if(n===0)return actorConfiguration(target,'off');
   if(n===1)throw new ConfigurationRetry('runtime_configuration_unavailable');
   if(n===2)throw new ConfigurationRetry('container_starting');
   return actorConfiguration(target);
  },
  refresh:async()=>{refreshes++;return {status:'uncertain',httpStatus:503};}});
 const result=await transitionActors(identity,{paused:async()=>anchor,preflight,send:async(target,body)=>({restarted:true,target,...body})});
 assert.equal(result.status,'passed');assert.equal(refreshes,3);
 assert.ok(result.edgePreflight.some(o=>o.scope==='actor'&&o.status==='starting'&&o.code==='runtime_configuration_unavailable'&&o.httpStatus===503));
 assert.ok(result.edgePreflight.some(o=>o.scope==='actor'&&o.status==='starting'&&o.code==='container_starting'));
 assert.equal(result.edgePreflight.filter(o=>o.scope==='refresh'&&o.status==='attempted_unverified').length,3);
 assert.ok(clock<=configurationLimits.durationMs);
});
test('edge configuration 503s wait inside the shared budget before actor inspection',async()=>{
 let clock=0,edgeReads=0,actorReads=0,refreshes=0;
 const preflight=edgePreflight(identity,nativeOff,{now:()=>clock,sleep:async ms=>{clock+=ms;},
  read:async()=>{edgeReads++;if(edgeReads===1)throw new ConfigurationRetry('actor_reset_by_deploy');return configuration();},
  readActor:async target=>{actorReads++;return actorConfiguration(target);},
  refresh:async()=>{refreshes++;}});
 const result=await transitionActors(identity,{paused:async()=>anchor,preflight,send:async(target,body)=>({restarted:true,target,...body})});
 assert.equal(result.status,'passed');assert.equal(refreshes,0);assert.equal(actorReads,5);
 assert.ok(result.edgePreflight.some(o=>o.status==='starting'&&o.code==='actor_reset_by_deploy'&&o.httpStatus===503));
 assert.equal(clock,configurationLimits.intervalMs);
});
test('invalid or unknown configuration 503s remain fail-closed without mutation',async()=>{
 assert.deepEqual(await readConfigurationResponse(Response.json(configuration())),configuration());
 for(const code of configurationRetryCodes){
  await assert.rejects(readConfigurationResponse(Response.json({error:code},{status:503})),error=>{
   assert.ok(error instanceof ConfigurationRetry);assert.equal(error.code,code);assert.equal(error.httpStatus,503);return true;
  });
 }
 for(const [status,body] of [
  [503,{error:'runtime_configuration_invalid'}],[503,{error:'container_starting',extra:true}],
  [503,{error:'private provider message'}],[500,{error:'container_starting'}],[403,{error:'container_starting'}],
 ]) await assert.rejects(readConfigurationResponse(Response.json(body,{status})),new RegExp(`preflight rejected \\(${status}\\)`));
 await assert.rejects(readConfigurationResponse(new Response('unreadable',{status:503})),/preflight rejected \(503\)/);
 let sends=0,refreshes=0,reads=0;
 const preflight=edgePreflight(identity,nativeOff,{read:async()=>configuration(),
  readActor:async()=>{reads++;throw new Error('runtime configuration preflight rejected (503)');},
  refresh:async()=>{refreshes++;}});
 await assert.rejects(transitionActors(identity,{paused:async()=>anchor,preflight,send:async()=>{sends++;}}),/preflight rejected \(503\)/);
 assert.equal(sends,0);assert.equal(refreshes,0);assert.equal(reads,1);
});
test('retryable configuration 503s still fail closed when the shared budget is spent',async()=>{
 let clock=0,sends=0,refreshes=0,last;
 const preflight=edgePreflight(identity,nativeOff,{now:()=>clock,sleep:async ms=>{clock+=ms;},read:async()=>configuration(),
  readActor:async target=>{if(refreshes===0)return actorConfiguration(target,'off');throw new ConfigurationRetry('container_dependency_not_ready');},
  refresh:async()=>{refreshes++;return {status:'uncertain',httpStatus:503};}});
 await assert.rejects(transitionActors(identity,{paused:async()=>anchor,preflight,record:e=>{last=JSON.parse(JSON.stringify(e));},send:async()=>{sends++;}}),/exhausted|deadline/);
 assert.equal(sends,0);assert.equal(refreshes,1);assert.equal(last.status,'failed');
 assert.ok(clock<=configurationLimits.durationMs);
 assert.ok(last.edgePreflight.some(o=>o.status==='starting'&&o.code==='container_dependency_not_ready'));
 assert.equal(last.edgePreflight.filter(o=>o.scope==='refresh'&&o.status==='attempted_unverified').length,1);
});
