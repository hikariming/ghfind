import {test} from "node:test";
import assert from "node:assert/strict";
import {verifyMonitor,VERIFY_LIMITS,MonitorVerificationError,errorCategories} from "./cost-monitor-verify.mjs";

const env={COST_MONITOR_URL:"https://monitor.example",MONITOR_ADMIN_TOKEN:"private-admin-token"};
const ready=()=>Response.json({version:2,lastAttempt:0,lastSuccess:0,healthy:false});
const okay=()=>Response.json({status:"ok",points:131,errors:[]});
const busy=()=>Response.json({status:"busy"});
function harness(responses,limits={}){
  let clock=1_800_000_000_000;const started=clock,calls=[],logs=[],waits=[];
  const options={limits,now:()=>clock,log:row=>logs.push(row),sleep:async ms=>{waits.push(ms);clock+=ms;},fetcher:async(url,init)=>{
    calls.push({url,method:init.method});assert.equal(init.headers.authorization,`Bearer ${env.MONITOR_ADMIN_TOKEN}`);assert.equal(init.redirect,"manual");
    const next=responses.shift();assert.ok(next,"Unexpected request");
    return typeof next==="function"?next({url,init,elapsed:clock-started}):next;
  }};
  return {calls,logs,waits,options,run:()=>verifyMonitor(env,options),elapsed:()=>clock-started};
}
const fails=code=>error=>{assert.ok(error instanceof MonitorVerificationError);assert.equal(error.code,code);return true;};

test("requires a fresh successful collection instead of accepting old health timestamps",async()=>{
  const h=harness([ready,okay]);
  assert.deepEqual(await h.run(),{status:"verified",attempts:1,points:131,errorCount:0});
  assert.deepEqual(h.calls.map(c=>c.method),["GET","POST"]);
  assert.deepEqual(h.calls.map(c=>new URL(c.url).pathname),["/health","/run"]);
  assert.deepEqual(h.logs.map(l=>l.status),["ready","ok"]);
  const stale=harness([ready,()=>Response.json({status:"degraded",points:1,errors:["private provider response"]})]);
  await assert.rejects(stale.run(),fails("collection_degraded"));
});

test("read-only route readiness retries transient responses before any collection",async()=>{
  const h=harness([()=>new Response("edge propagating",{status:503}),()=>new Response("route absent",{status:404}),()=>new Response("pending HTML",{status:200}),ready,busy,okay]);
  assert.equal((await h.run()).attempts,2);
  assert.deepEqual(h.calls.map(c=>c.method),["GET","GET","GET","GET","POST","POST"]);
  assert.deepEqual(h.waits,[15_000,15_000,15_000,15_000]);
});

test("an existing ten-minute durable lease fits within the bounded verification budget",async()=>{
  const h=harness([ready,...Array.from({length:40},()=>busy),okay]);
  assert.equal((await h.run()).attempts,41);
  assert.equal(h.elapsed(),10*60_000);
  assert.ok(VERIFY_LIMITS.durationMs>=10*60_000+VERIFY_LIMITS.requestMs);
});

test("persistent busy stops at the global deadline without a request after expiry",async()=>{
  const h=harness([ready,busy,busy,busy],{durationMs:45_000});
  await assert.rejects(h.run(),fails("deadline_exceeded"));
  assert.equal(h.elapsed(),45_000);assert.equal(h.calls.length,4);
});

test("readiness has its own short deadline and never posts while the route is unready",async()=>{
  const h=harness(Array.from({length:3},()=>()=>new Response("not ready",{status:503})),{readinessMs:45_000});
  await assert.rejects(h.run(),fails("readiness_timeout"));
  assert.equal(h.elapsed(),45_000);assert.deepEqual(h.calls.map(c=>c.method),["GET","GET","GET"]);
});

test("only exact HTTP 200 busy is retryable after POST",async()=>{
  const cases=[
    [()=>new Response("private HTML",{status:503}),"collection_outcome_unknown"],
    [()=>new Response("private HTML",{status:200}),"collection_outcome_unknown"],
    [()=>Response.json({status:"busy",points:0}),"collection_invalid_result"],
    [()=>Response.json({status:"busy"},{status:500}),"collection_http_error"],
    [()=>Response.json({status:"degraded",points:20,errors:["private upstream error"]}),"collection_degraded"],
    [()=>Response.json({status:"unknown-private-status"}),"collection_invalid_result"],
    [()=>Response.json({status:"ok",points:0,errors:[]}),"collection_invalid_result"],
    [()=>Response.json({status:"ok",points:"131",errors:[]}),"collection_invalid_result"],
    [()=>Response.json({status:"ok",points:131}),"collection_invalid_result"],
    [()=>Response.json({status:"ok",points:131,errors:["partial"]}),"collection_invalid_result"],
    [()=>Response.json(null),"collection_invalid_result"],
  ];
  for(const [response,code] of cases){
    const h=harness([ready,response]);await assert.rejects(h.run(),fails(code));
    assert.equal(h.calls.filter(c=>c.method==="POST").length,1);assert.equal(h.waits.length,0);
  }
});

test("auth failures and redirects are definitive in either phase",async()=>{
  for(const status of [401,403])for(const stage of ["readiness","collection"]){
    const h=harness([...(stage==="collection"?[ready]:[]),()=>new Response("private auth body",{status})]);
    await assert.rejects(h.run(),fails(`${stage}_unauthorized`));assert.equal(h.waits.length,0);
  }
  const redirect=harness([()=>new Response(null,{status:302,headers:{location:"https://different.example"}})]);
  await assert.rejects(redirect.run(),fails("readiness_redirect"));assert.equal(redirect.calls.length,1);
});

test("unknown health JSON does not prove route readiness",async()=>{
  const h=harness([()=>Response.json({healthy:true,lastSuccess:Date.now()})]);
  await assert.rejects(h.run(),fails("readiness_unexpected_response"));assert.equal(h.calls.length,1);
});

test("POST transport failures have unknown outcomes and are never repeated",async()=>{
  const h=harness([ready,()=>{throw new Error("private network address or token");}]);
  await assert.rejects(h.run(),fails("collection_outcome_unknown"));
  assert.equal(h.calls.length,2);assert.equal(h.waits.length,0);assert.equal(h.logs.at(-1).status,"transport_error");
});

test("bounded responses and logs never expose provider content, URLs or credentials",async()=>{
  for(const payload of [{status:"private-admin-token",points:131,errors:["secret source details"]},"x".repeat(65*1024)]){
    const h=harness([ready,()=>Response.json(payload)]);
    await assert.rejects(h.run(),error=>error instanceof MonitorVerificationError);
    const logs=JSON.stringify(h.logs);
    for(const secret of [env.MONITOR_ADMIN_TOKEN,env.COST_MONITOR_URL,"secret source details"])assert.equal(logs.includes(secret),false);
    assert.equal(h.calls.length,2);
  }
});

test("real abort timers bound an in-flight POST and do not retry it",async()=>{
  for(const limits of [{durationMs:30,requestMs:100},{durationMs:300,requestMs:20}]){
    let posts=0;const logs=[];
    const result=verifyMonitor(env,{limits,log:row=>logs.push(row),fetcher:async(_url,init)=>{
      if(init.method==="GET")return ready();
      posts++;
      return new Promise((_,reject)=>init.signal.addEventListener("abort",()=>reject(new Error("private transport timeout")),{once:true}));
    }});
    await assert.rejects(result,fails(limits.durationMs<limits.requestMs?"deadline_exceeded":"collection_outcome_unknown"));
    assert.equal(posts,1);assert.equal(JSON.stringify(logs).includes("private transport timeout"),false);
  }
});

test("invalid configuration is rejected before network access",async()=>{
  for(const config of [{},{...env,MONITOR_ADMIN_TOKEN:""},{...env,COST_MONITOR_URL:"invalid"},{...env,COST_MONITOR_URL:"https://user:secret@monitor.example"}]){
    await assert.rejects(verifyMonitor(config,{fetcher:()=>{throw new Error("must not request");}}),error=>error instanceof MonitorVerificationError);
  }
});

test("degraded collections log only allowlisted error categories, never details",async()=>{
  const errors=["R2 storage: known snapshot missing; coverage incomplete","Billing: reconciliation unavailable","Workers: access denied; check analytics token permissions","R2 storage: request timed out","private-admin-token: secret source details","no prefix secret source details",42];
  const h=harness([ready,()=>Response.json({status:"degraded",points:141,errors})]);
  await assert.rejects(h.run(),fails("collection_degraded"));
  const row=h.logs.at(-1);
  assert.equal(row.errorCount,7);
  assert.deepEqual(row.errorCategories,["Billing","R2 storage","Workers","other"]);
  const logs=JSON.stringify(h.logs);
  for(const secret of [env.MONITOR_ADMIN_TOKEN,"secret source details","snapshot missing","reconciliation","access denied","timed out"])assert.equal(logs.includes(secret),false);
  assert.equal(h.logs[0].errorCategories,null);
});

test("error categories are bounded and map unknown or detail-only prefixes to other",()=>{
  assert.equal(errorCategories(undefined),null);
  assert.deepEqual(errorCategories([]),[]);
  assert.deepEqual(errorCategories(["D1 SQL: x","D1: y","Monitor: z","R2 operations: w","KV: a","DO: b","Queues: c"]),["D1","D1 SQL","DO","KV","Monitor","Queues","R2 operations"]);
  assert.deepEqual(errorCategories(["R2: x"," R2 storage: y",{}]),["other"]);
  assert.deepEqual(errorCategories(Array.from({length:1000},(_,i)=>`p${i}: secret`)),["other"]);
});
