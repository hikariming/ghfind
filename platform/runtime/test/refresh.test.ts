import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshActor, validateRefresh } from "../src/refresh";
import { handleRequest, type RuntimeSettings } from "../src/router";
const env: RuntimeSettings = {
  FEED_ENVIRONMENT: "production", FEED_IMAGE_BUILD_ID: "d".repeat(64), FEED_RELEASE_SHA: "a".repeat(40),
  FEED_IMAGE_REFERENCE: `registry.cloudflare.com/8f19bebe359e4ec1a24c68c5f49c1584/ghfind-feed@sha256:${"b".repeat(64)}`,
  FEED_MODE: "baseline", FEED_WRITER_EPOCH: "1", FEED_EXECUTOR_ENABLED: "true", FEED_SOURCE_RELAY_ENABLED: "true",
  FEED_QUEUE_NAME: "ghfind-feed-production-jobs", FEED_DLQ_NAME: "ghfind-feed-production-dlq",
  FEED_GATEWAY_SECRET: "g".repeat(32), FEED_SIGNING_SECRET: "s".repeat(32), FEED_BRIDGE_SECRET: "b".repeat(32),
  FEED_RUNTIME_ADMIN_SECRET: "r".repeat(32), FEED_EXECUTOR_SECRET: "e".repeat(32), FEED_SOURCE_SECRET: "q".repeat(32), FEED_DELIVERY_SECRET: "d".repeat(32),
  WORKER_VERSION: { id: "12345678-1234-4234-8234-123456789012", tag: "test", timestamp: "2026-09-09T00:00:00Z" },
};

const actorId = "1".repeat(64);
const input = { sourceSha: env.FEED_RELEASE_SHA, imageBuildId: env.FEED_IMAGE_BUILD_ID!, mode: "baseline" as const, writerEpoch: 1 as const,
 actorId, baselineVersionId: env.WORKER_VERSION.id, offVersionId: "22345678-1234-4234-8234-123456789012" };
const off = {...env, FEED_MODE: "off", WORKER_VERSION: {...env.WORKER_VERSION,id:input.offVersionId}};
test("refresh only aborts exact idle off actor; rejects identity and scope before abort", () => {
 let aborted = 0;
 const abort = () => {aborted++; throw new Error("native abort");};
 assert.throws(()=>refreshActor(input,off,"api-0",actorId,actorId,"api",false,abort), /native abort/);
 assert.equal(aborted,1);
 for (const patch of [{sourceSha:"b".repeat(40)},{imageBuildId:"c".repeat(64)},{mode:"off"},{writerEpoch:2},
 {actorId:"2".repeat(64)},{offVersionId:input.baselineVersionId},{baselineVersionId:input.offVersionId},{extra:true}]) {
  assert.equal(refreshActor({...input,...patch},off,"api-0",actorId,actorId,"api",false,abort).kind,"refresh-rejected");
 }
 assert.deepEqual(refreshActor(input,env,"api-0",actorId,actorId,"api",false,abort),{kind:"refresh-already-current",workerVersionId:input.baselineVersionId});
 assert.equal(refreshActor(input,off,"executor-0",actorId,actorId,"api",false,abort).kind,"refresh-rejected");
 assert.equal(refreshActor(input,off,"api-0",actorId,"2".repeat(64),"api",false,abort).kind,"refresh-rejected");
 assert.deepEqual(refreshActor(input,off,"api-0",actorId,actorId,"api",true,abort),{kind:"refresh-rejected",status:409,code:"transition_in_progress"});
 assert.equal(aborted,1);
});
test("edge refresh requires exact baseline deployment and fixed actor",()=>{
 validateRefresh(input,env,actorId,"edge");
 for(const e of [off,{...env,FEED_ENVIRONMENT:"staging"},{...env,WORKER_VERSION:off.WORKER_VERSION}])
  assert.throws(()=>validateRefresh(input,e,actorId,"edge"),/invalid_refresh/);
 assert.throws(()=>validateRefresh(input,env,"2".repeat(64),"edge"),/invalid_refresh/);
});
test("route preserves typed rejection and treats abort or invalid reply as unknown; never lifecycle dispatches",async()=>{
 let calls=0;
 const dispatch = {fetch:async()=>{throw Error("unexpected fetch");},stop:async()=>{throw Error("unexpected stop");},actorId:()=>actorId,
 refresh:async()=>{calls++;throw Error("native abort");}};
 const req=(auth=true,body:unknown=input)=>new Request("https://runtime/internal/runtime/api-0/refresh",{method:"POST",headers:auth?{authorization:`Bearer ${env.FEED_RUNTIME_ADMIN_SECRET}`}:{},body:JSON.stringify(body)});
 assert.equal((await handleRequest(req(false),env,dispatch)).status,401);
 assert.equal((await handleRequest(req(true,{...input,actorId:"2".repeat(64)}),env,dispatch)).status,400);
 assert.equal(calls,0);
 let r=await handleRequest(req(),env,dispatch);assert.equal(r.status,503);assert.equal((await r.json() as {error:string}).error,"refresh_outcome_unknown");
 for(const [status,code] of [[400,"invalid_refresh_identity"],[409,"transition_in_progress"]] as const){
 r=await handleRequest(req(),env,{...dispatch,refresh:async()=>({kind:"refresh-rejected",status,code})});assert.equal(r.status,status);
 }
 r=await handleRequest(req(),env,{...dispatch,refresh:async()=>({ok:true})});assert.equal(r.status,503);
 assert.equal(calls,1);
});

test("known-off edge rejects before dispatch; exact baseline actor allows reads only", async()=>{
 let dispatches=0;
 const request=(body:unknown=input)=>new Request("https://runtime/internal/runtime/api-0/refresh",{method:"POST",headers:{authorization:`Bearer ${env.FEED_RUNTIME_ADMIN_SECRET}`},body:JSON.stringify(body)});
 const dispatch={fetch:async()=>{throw Error("unexpected fetch");},stop:async()=>{throw Error("unexpected stop");},actorId:()=>actorId,
 refresh:async()=>{dispatches++;return {kind:"refresh-already-current",workerVersionId:input.baselineVersionId};}};
 let r=await handleRequest(request(),off,dispatch);
 assert.equal(r.status,409);assert.deepEqual(await r.json(),{error:"refresh_edge_not_ready",workerVersionId:input.offVersionId});assert.equal(dispatches,0);
 for(const body of [{...input,offVersionId:"33333333-3333-4333-8333-333333333333"},{...input,imageBuildId:"c".repeat(64)},{...input,actorId:"2".repeat(64)}]) {
  r=await handleRequest(request(body),off,dispatch);assert.equal(r.status,400);
 }
 assert.equal(dispatches,0);
 r=await handleRequest(request(),env,dispatch);assert.equal(r.status,409);
 assert.deepEqual(await r.json(),{error:"refresh_actor_already_current",workerVersionId:input.baselineVersionId});
 r=await handleRequest(request(),env,{...dispatch,refresh:async()=>({kind:"refresh-already-current",workerVersionId:input.offVersionId})});assert.equal(r.status,503);
 let aborts=0;
 for(const [e,id,target] of [[{...env,WORKER_VERSION:off.WORKER_VERSION},actorId,"api-0"],[env,"2".repeat(64),"api-0"],[env,actorId,"executor-0"]] as const){
  const result=refreshActor(input,e,target,actorId,id,"api",false,()=>{aborts++;});assert.equal(result.kind,"refresh-rejected");
 }
 assert.equal(aborts,0);
});
