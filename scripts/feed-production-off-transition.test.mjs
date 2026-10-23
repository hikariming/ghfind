import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transitionOffActors, validateConsumerReceipt, readOffResponse, OffRequestError } from './feed-production-off-transition.mjs';
import { ACCOUNT } from './feed-production-release.mjs';
const manifest=JSON.parse(readFileSync(new URL('../ops/feed-production-manifest.json',import.meta.url)));
const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'hikariming/ghfind',GITHUB_REF:'refs/heads/main',
  GITHUB_WORKFLOW_REF:'hikariming/ghfind/.github/workflows/deploy-cf-production.yml@refs/heads/main',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1'};
const identity={sourceSha:'a'.repeat(40),imageBuildId:'b'.repeat(64),image:`registry.cloudflare.com/${ACCOUNT}/ghfind-feed@sha256:${'c'.repeat(64)}`,mode:'off',writerEpoch:1};
const version='12345678-1234-1234-1234-123456789abc', anchor='12345678-1234-1234-1234-123456789abd';
const targets=['api-0','api-1','executor-0'];
const receipt=()=>({format:'ghfind-feed-production-consumers-off-v1',status:'passed',accountId:ACCOUNT,runtimeWorker:manifest.runtimeWorker,
  runId:'123',runAttempt:'1',consumersAbsent:true,messagesDeleted:false,queuesDeleted:false,removed:[],deleteAttempts:[],
  queues:[{name:manifest.queue,queueId:'a'.repeat(32),consumerIds:[]},{name:manifest.deadLetterQueue,queueId:'b'.repeat(32),consumerIds:[]}]});
const paused=async()=>({status:'passed',mode:'paused',sourceSha:identity.sourceSha,backend:'go',store:'cf_d1_r2',workerVersionId:anchor});
const read=async path=>path==='configuration'?{service:'feed-runtime',version:identity.sourceSha,contractVersion:'1',workerVersionId:version,
  configuredImage:identity.image,imageBuildId:identity.imageBuildId,mode:'off',writerEpoch:1}:
  {actorId:String(targets.indexOf(path.split('/')[0])+1).repeat(64),target:path.split('/')[0],sourceSha:identity.sourceSha,
    workerVersionId:version,configuredImage:identity.image,imageBuildId:identity.imageBuildId,mode:'off',writerEpoch:1};
const options=(extra={})=>({manifest,env,consumerReceipt:receipt(),paused,read,send:async(target,body)=>({...body,target,restarted:true}),...extra});
test('off restart validates every actor before each single POST and persists intent',async()=>{
  const states=[],sends=[];
  const result=await transitionOffActors(identity,options({record:v=>states.push(structuredClone(v)),send:async(target,body)=>{
    assert.equal(states.at(-1).targets.at(-1).status,'attempted_unverified');
    assert.equal(states.at(-1).observations.at(-1).target,target); sends.push(target); return {...body,target,restarted:true};
  }}));
  assert.equal(result.status,'passed');assert.deepEqual(sends,targets);assert.equal(result.readonlyCalls,16);
});
test('stale consumer receipt, unknown queue, message deletion and non-main fail before POST',async()=>{
  for(const patch of [{runId:'122'},{runAttempt:'2'},{messagesDeleted:true},{queuesDeleted:true},{consumersAbsent:false},{queues:[]}]){
    let sent=0;await assert.rejects(transitionOffActors(identity,options({consumerReceipt:{...receipt(),...patch},send:()=>{sent++;}})));assert.equal(sent,0);
  }
  assert.throws(()=>validateConsumerReceipt({...receipt(),removed:[{queueId:'f'.repeat(32),consumerId:'e'.repeat(32)}]},manifest,env));
  await assert.rejects(transitionOffActors(identity,options({env:{...env,GITHUB_REF:'refs/heads/other'}})));
});
test('wrong edge/actor configuration or duplicate actors prevents mutation',async()=>{
  for(const [path,patch] of [['configuration',{mode:'baseline'}],['configuration',{imageBuildId:'d'.repeat(64)}],
    ['api-0/configuration',{sourceSha:'d'.repeat(40)}],['api-1/configuration',{actorId:'1'.repeat(64)}],
    ['executor-0/configuration',{workerVersionId:anchor}]]){
    let sent=0;await assert.rejects(transitionOffActors(identity,options({read:async p=>({...await read(p),...(p===path?patch:{})}),send:()=>{sent++;}}))); assert.equal(sent,0);
  }
});
test('uncertain POST and rejected replies are never retried and preserve attempted evidence',async()=>{
  for(const reply of [new Error('network unknown'),new Error('409'),new Error('503'),{rejectedWithoutMutation:true},{restarted:true}]){
    let sends=0,last;
    await assert.rejects(transitionOffActors(identity,options({record:v=>{last=structuredClone(v);},send:async()=>{sends++;if(reply instanceof Error)throw reply;return reply;}})));
    assert.equal(sends,1);assert.equal(last.status,'failed');assert.equal(last.targets[0].status,'attempted_unverified');
  }
});
test('changed paused anchor or runtime version stops subsequent actors',async()=>{
  for(const change of ['anchor','version']){
    let checks=0,edges=0,sends=0;
    await assert.rejects(transitionOffActors(identity,options({paused:async()=>({...await paused(),workerVersionId:++checks>1&&change==='anchor'?version:anchor}),
      read:async path=>{const v=await read(path);if(path==='configuration'&&++edges>1&&change==='version')v.workerVersionId=anchor;return v;},
      send:async(target,body)=>{sends++;return {...body,target,restarted:true};}})));
    assert.equal(sends,1);
  }
});
test('overall deadline prevents additional calls',async()=>{
  let time=0,sends=0;
  await assert.rejects(transitionOffActors(identity,options({now:()=>time,read:async path=>{time=240001;return read(path);},send:()=>{sends++;}})),/deadline/);
  assert.equal(sends,0);
});

test('HTTP failure records only bounded known code, request phase and status, never retries',async()=>{
  let last,sends=0;
  await assert.rejects(transitionOffActors(identity,options({record:v=>{last=structuredClone(v);},send:async target=>{
    sends++; return readOffResponse(new Response(JSON.stringify({error:'transition_stop_timeout',debug:'PRIVATE_SECRET'}),{status:503}),`${target}/restart`);
  }})),/transition_stop_timeout/);
  assert.equal(sends,1);assert.deepEqual(last.error,{path:'api-0/restart',phase:'restart',status:503,code:'transition_stop_timeout'});
  assert.equal(JSON.stringify(last).includes('PRIVATE_SECRET'),false);
  assert.equal(last.targets[0].status,'attempted_unverified');
});
test('arbitrary, malformed, oversized and unknown error bodies are never echoed',async()=>{
  for(const [body,code] of [[JSON.stringify({error:'PRIVATE_SECRET'}),'unrecognized_error_body'],
    [JSON.stringify({error:'unknown_but_formatted_code'}),'unrecognized_error_body'],
    [JSON.stringify({error:'token secret\nraw'}),'unrecognized_error_body'],['PRIVATE_SECRET','unreadable_error_body'],
    ['PRIVATE_SECRET'.repeat(300),'unreadable_error_body']]) {
    await assert.rejects(readOffResponse(new Response(body,{status:503}),'executor-0/restart'),error=>{
      assert.equal(error.diagnostic.code,code);assert.equal(error.diagnostic.status,503);
      assert.equal(error.message.includes('PRIVATE_SECRET'),false);return true;
    });
  }
  await assert.rejects(readOffResponse(new Response('{"error":"transition_environment_not_ready"}',{status:409}),'api-1/restart'),/transition_environment_not_ready/);
  assert.deepEqual(await readOffResponse(new Response('{"restarted":true}'),'api-0/restart'),{restarted:true});
});
test('unknown network errors retain safe request context without exception contents',async()=>{
  let last,sends=0;
  await assert.rejects(transitionOffActors(identity,options({record:v=>{last=structuredClone(v);},send:async()=>{sends++;throw Error('PRIVATE_TOKEN');}})));
  assert.equal(sends,1);assert.deepEqual(last.error,{phase:'restart',path:'api-0/restart',status:null,code:'off_transition_failed'});
  assert.equal(JSON.stringify(last).includes('PRIVATE_TOKEN'),false);
});

test('transient actor configuration 503 is retried read-only and bounded; other errors are not',async()=>{
  let fails=2,sends=0,slept=[];
  const result=await transitionOffActors(identity,options({sleep:async ms=>{slept.push(ms);},
    read:async p=>{if(p==='api-1/configuration'&&fails-->0)throw new OffRequestError(p,503,'runtime_configuration_unavailable');return read(p);},
    send:async(target,body)=>{sends++;return {...body,target,restarted:true};}}));
  assert.equal(result.status,'passed');assert.equal(sends,3);assert.equal(result.configurationRetries,2);assert.deepEqual(slept,[3000,6000]);
  let calls=0;sends=0;
  await assert.rejects(transitionOffActors(identity,options({sleep:async()=>{},
    read:async p=>{if(p==='api-1/configuration'){calls++;throw new OffRequestError(p,503,'runtime_configuration_unavailable');}return read(p);},
    send:async()=>{sends++;}})),/runtime_configuration_unavailable/);
  assert.equal(calls,3);assert.equal(sends,0);
  calls=0;
  await assert.rejects(transitionOffActors(identity,options({sleep:async()=>{},
    read:async p=>{if(p==='api-1/configuration'){calls++;throw new OffRequestError(p,503,'runtime_configuration_invalid');}return read(p);},
    send:async()=>{sends++;}})));
  assert.equal(calls,1);assert.equal(sends,0);
});
