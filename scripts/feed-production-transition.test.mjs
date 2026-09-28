import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionActors } from './feed-production-transition.mjs';
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

import { edgePreflight } from './feed-production-transition.mjs';
const offVersion='12345678-1234-4234-8234-123456789001', baselineVersion='12345678-1234-4234-8234-123456789002';
const off={runtime:{versionId:offVersion},image:'image@sha256:exact'};
const configuration=(mode='baseline')=>({service:'feed-runtime',version:identity.sourceSha,contractVersion:'1',workerVersionId:mode==='off'?offVersion:baselineVersion,configuredImage:off.image,imageBuildId:identity.imageBuildId,mode,writerEpoch:1});
test('known off propagates to exact baseline before each mutation',async()=>{
 let reads=0,clock=0;const observations=[];
 const preflight=edgePreflight(identity,off,{now:()=>clock,sleep:async ms=>{clock+=ms;},read:async()=>configuration(++reads===1?'off':'baseline')});
 const result=await transitionActors(identity,{paused:async()=>anchor,preflight,send:async(target,body)=>({restarted:true,target,...body}),record:e=>observations.push(JSON.parse(JSON.stringify(e)))});
 assert.equal(reads,4);assert.equal(clock,2000);assert.equal(result.status,'passed');assert.equal(result.edgePreflight[1].status,'known_off');
});
test('bounded stale off and invalid identities fail without mutation',async()=>{
 for(const patch of [null,{version:'c'.repeat(40)},{imageBuildId:'c'.repeat(64)},{configuredImage:'wrong'},{writerEpoch:2},{extra:true},{workerVersionId:baselineVersion,mode:'off'}]){
 let reads=0,sends=0,clock=0;
 const preflight=edgePreflight(identity,off,{now:()=>clock,sleep:async ms=>{clock+=ms;},read:async()=>{reads++;return patch?{...configuration(),...patch}:configuration('off');}});
 await assert.rejects(transitionActors(identity,{paused:async()=>anchor,preflight,send:async()=>{sends++;}}));
 assert.equal(sends,0);assert.equal(reads,patch?1:15);assert.ok(clock<45000);
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
 const preflight=edgePreflight(identity,off,{now:()=>clock,read:async()=>{if(!slow)throw Error('network');clock=45000;return configuration();}});
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
 const preflight=edgePreflight(identity,off,{now:()=>clock,sleep:async ms=>{clock+=ms;},read:async()=>{reads++;clock+=15000;return configuration(reads===2?'off':'baseline');}});
 await preflight(()=>{});clock+=90000;
 await assert.rejects(preflight(()=>{}),/deadline exceeded/);
 assert.equal(reads,3);
 await assert.rejects(preflight(()=>{}),/exhausted/);
 assert.equal(reads,3);
});
