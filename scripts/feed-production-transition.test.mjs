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
