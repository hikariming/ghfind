import {test} from "node:test";
import {execFile} from "node:child_process";
import {createServer} from "node:http";
import {promisify} from "node:util";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {healthFailure,readWatchdogState,REPEAT_MS,saveWatchdogState,watchdog} from "./cost-monitor-watchdog.mjs";

const env={COST_MONITOR_URL:"https://monitor.example",MONITOR_ADMIN_TOKEN:"admin-private",CF_MONITOR_API_TOKEN:"send-private",CF_ACCOUNT_ID:"account",MONITOR_OPS_RECIPIENTS:'["one@example.org","two@example.org",""]'};
const now=10_000_000;
const good={version:2,lastAttempt:now-60_000,lastSuccess:0,heartbeatHealthy:true,collectionHealthy:false,deliveryHealthy:true,healthy:false};
const accepted=to=>Response.json({success:true,result:{delivered:[],queued:[to],permanent_bounces:[]}});
function scenario(health,sends=[],rejectTo=null){
  return async(url,init)=>{
    if(url.endsWith("/health")){
      if(health===null)throw new Error("offline");
      if(health==="unauthorized")return Response.json({error:"Unauthorized"},{status:401});
      return Response.json(health);
    }
    assert.equal(url,"https://api.cloudflare.com/client/v4/accounts/account/email/sending/send");
    const body=JSON.parse(init.body);assert.equal(body.to.length,1);sends.push(body);
    return body.to[0]===rejectTo?Response.json({success:true,result:{delivered:[],queued:[],permanent_bounces:[rejectTo]}}):accepted(body.to[0]);
  };
}

test("collection gaps do not trigger external heartbeat mail in health v2 or legacy v1",async()=>{
  for(const health of [good,{version:1,lastAttempt:now-60_000,lastSuccess:0,healthy:false,lastError:"GraphQL unavailable"},{healthy:true,lastSuccess:now-1}]){
    const sends=[];const result=await watchdog(env,scenario(health,sends),now);
    assert.equal(result.healthy,true);assert.equal(result.notified,false);assert.equal(sends.length,0);
  }
});

test("stale, future, malformed, unreachable and unauthorized heartbeats notify once per recipient",async()=>{
  for(const health of [{lastAttempt:0},{lastAttempt:now-30*60_000},{lastAttempt:now+60_001},{lastAttempt:"1000"},{lastAttempt:now,heartbeatHealthy:false},null,"unauthorized"]){
    const sends=[];const result=await watchdog(env,scenario(health,sends),now);
    assert.equal(result.healthy,false);assert.equal(result.notified,true);assert.equal(result.failed,0);
    assert.deepEqual(sends.map(s=>s.to[0]),["one@example.org","two@example.org"]);
    assert.equal(result.reason,"heartbeat");assert.equal(sends[0].subject,"[ghfind][P1][监控] 监控任务心跳中断");
  }
});

test("explicit delivery failure is actionable without declaring a billing overspend",async()=>{
  const sends=[];const result=await watchdog(env,scenario({...good,deliveryHealthy:false},sends),now);
  assert.equal(result.reason,"delivery");assert.equal(result.notified,true);
  assert.equal(sends[0].subject,"[ghfind][P3][监控] 告警邮件发送异常");assert.match(sends[0].text,/此通知不代表已发生费用超支/);
  assert.doesNotMatch(sends[0].text,/Collection failed|Token 权限、数据延迟/);
});

test("persistent incidents notify at first detection and six hours, with no hourly repeats",async()=>{
  let state;const sends=[];
  for(let hour=0;hour<=6;hour++){
    const result=await watchdog(env,scenario({lastAttempt:0},sends),now+hour*3600_000,{state,persist:s=>{state=structuredClone(s);}});
    assert.equal(result.notified,hour===0||hour===6);
  }
  assert.equal(sends.length,4);assert.match(sends[2].text,/持续 360 分钟/);
});

test("one failed recipient retries while accepted recipients keep their six-hour cooldown",async()=>{
  let state;const snapshots=[];const sends=[];
  const persist=s=>{state=structuredClone(s);snapshots.push(state);};
  const first=await watchdog(env,scenario({lastAttempt:0},sends,"two@example.org"),now,{persist});
  assert.equal(first.failed,1);assert.equal(first.notified,true);
  assert.equal(Object.keys(state.incident.notified).length,1);
  const retrySends=[];
  const retry=await watchdog(env,scenario({lastAttempt:0},retrySends),now+3600_000,{state,persist});
  assert.equal(retry.failed,0);assert.deepEqual(retrySends.map(s=>s.to[0]),["two@example.org"]);
  const at12=[];await watchdog(env,scenario({lastAttempt:0},at12),now+REPEAT_MS,{state,persist});
  assert.deepEqual(at12.map(s=>s.to[0]),["one@example.org"]);
  const at13=[];await watchdog(env,scenario({lastAttempt:0},at13),now+REPEAT_MS+3600_000,{state,persist});
  assert.deepEqual(at13.map(s=>s.to[0]),["two@example.org"]);
  const serialized=JSON.stringify(snapshots);
  for(const privateValue of ["one@example.org","two@example.org",env.COST_MONITOR_URL,env.MONITOR_ADMIN_TOKEN,env.CF_MONITOR_API_TOKEN])assert.equal(serialized.includes(privateValue),false);
});

test("recovery is silent, clears prior delivery receipts, and permits a later new incident",async()=>{
  const first=await watchdog(env,scenario({lastAttempt:0}),now);
  const sends=[];const recovery=await watchdog(env,scenario(good,sends),now,{state:first.state});
  assert.equal(recovery.healthy,true);assert.equal(recovery.state.incident,null);assert.equal(sends.length,0);
  const later=await watchdog(env,scenario({lastAttempt:0},sends),now+3600_000,{state:recovery.state});
  assert.equal(later.notified,true);assert.equal(sends.length,2);
});

test("a changed failure type opens an actionable incident and unknown state cannot suppress mail",async()=>{
  const first=await watchdog(env,scenario({...good,deliveryHealthy:false}),now);
  const changed=await watchdog(env,scenario({lastAttempt:0}),now+3600_000,{state:first.state});
  assert.equal(changed.notified,true);assert.equal(changed.reason,"heartbeat");
  for(const state of [{version:42,incident:first.state.incident},{version:1,incident:{...first.state.incident,startedAt:now+1}},{version:1,incident:{...first.state.incident,scope:"not-the-configured-monitor"}}]){
    const result=await watchdog(env,scenario({...good,deliveryHealthy:false}),now,{state});assert.equal(result.notified,true);
  }
});

test("new recipients are notified without repeating recipients already notified",async()=>{
  const first=await watchdog(env,scenario({lastAttempt:0}),now);
  const sends=[];
  await watchdog({...env,MONITOR_OPS_RECIPIENTS:'[" one@example.org ","ONE@example.org","three@example.org"]'},scenario({lastAttempt:0},sends),now+3600_000,{state:first.state});
  assert.deepEqual(sends.map(s=>s.to[0]),["three@example.org"]);
});

test("failed or mismatched provider acceptance is retained for retry",async()=>{
  for(const payload of [{success:false},{success:true,result:{queued:["other@example.org"]}},{success:true,result:{queued:[]}},null]){
    const result=await watchdog(env,async(url)=>url.endsWith("/health")?Response.json({lastAttempt:0}):Response.json(payload),now);
    assert.equal(result.notified,false);assert.equal(result.failed,2);assert.equal(Object.keys(result.state.incident.notified).length,0);
  }
});

test("refuses unpersistable state before sending and invalid recipients before any request",async()=>{
  const sends=[];
  await assert.rejects(watchdog(env,scenario({lastAttempt:0},sends),now,{persist:()=>{throw new Error("storage unavailable");}}),/storage unavailable/);
  assert.equal(sends.length,0);
  for(const addresses of ['null','[42]','invalid-json','["bad"]']){
    await assert.rejects(watchdog({...env,MONITOR_OPS_RECIPIENTS:addresses},()=>{throw new Error("must not fetch");},now),/Invalid watchdog recipients/);
  }
});

test("bounds API responses and does not accept oversized health as a fresh heartbeat",async()=>{
  let sends=0;
  const result=await watchdog(env,async(url,init)=>{
    if(url.endsWith("/health"))return Response.json({...good,padding:"x".repeat(70*1024)});
    sends++;return accepted(JSON.parse(init.body).to[0]);
  },now);
  assert.equal(result.reason,"heartbeat");assert.equal(sends,2);
});

test("state file is bounded, atomic, private, and safely migrates corrupt or unknown schemas",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"cost-watchdog-")),path=join(dir,"state.json");
  try{
    assert.deepEqual(await readWatchdogState(path),{version:1,incident:null});
    const first=await watchdog(env,scenario({lastAttempt:0}),now,{persist:s=>saveWatchdogState(path,s)});
    assert.deepEqual(await readWatchdogState(path),first.state);
    assert.equal((await stat(path)).mode&0o777,0o600);
    const raw=await readFile(path,"utf8");assert.equal(raw.includes("@"),false);assert.equal(raw.includes(env.COST_MONITOR_URL),false);
    for(const invalid of ['broken','{"version":99}',"x".repeat(8193)]){await writeFile(path,invalid);assert.deepEqual(await readWatchdogState(path),{version:1,incident:null});}
    await assert.rejects(saveWatchdogState(path,{value:"x".repeat(8193)}),/exceeds bound/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("health parser does not treat future or invalid attempt times as liveness",()=>{
  for(const lastAttempt of [NaN,Infinity,"1000",now+60_001,0,null])assert.equal(healthFailure({lastAttempt,lastSuccess:now},now),"heartbeat");
  assert.equal(healthFailure({...good,lastAttempt:now+60_000},now),null);
});


test("absent or empty operator routing reports health without customer fallback or mail credentials", async()=>{
  for(const routing of [undefined,"","  ","[]",'["", " "]'])for(const health of [good,{lastAttempt:0},null]){
    const sends=[];let persisted;
    const isolated={COST_MONITOR_URL:env.COST_MONITOR_URL,MONITOR_ADMIN_TOKEN:env.MONITOR_ADMIN_TOKEN,MONITOR_OPS_RECIPIENTS:routing,ALERT_RECIPIENTS:'["customer@example.org"]'};
    const result=await watchdog(isolated,scenario(health,sends),now,{persist:state=>{persisted=state;}});
    assert.equal(result.healthy,health===good);
    assert.equal(result.notified,false);
    assert.equal(result.failed,0);
    assert.equal(result.notificationMode,"actions-only");
    assert.equal(sends.length,0);
    assert.equal(result.reason,health===good?undefined:"heartbeat");
    assert.ok(persisted);
    assert.equal(JSON.stringify(persisted).includes("customer@example.org"),false);
  }
});

test("explicit operator recipients are the only mail audience even when customers are configured", async()=>{
  const sends=[];
  const result=await watchdog({...env,MONITOR_OPS_RECIPIENTS:'["ops@example.org"]',ALERT_RECIPIENTS:'["customer@example.org"]'},scenario({lastAttempt:0},sends),now);
  assert.equal(result.notified,true);
  assert.equal(result.notificationMode,"operations");
  assert.deepEqual(sends.map(s=>s.to[0]),["ops@example.org"]);
  for(const absent of ["CF_MONITOR_API_TOKEN","CF_ACCOUNT_ID"]){
    await assert.rejects(watchdog({...env,[absent]:undefined},()=>{throw new Error("must not fetch");},now),/Watchdog email configuration incomplete/);
  }
});

test("CLI records an unhealthy monitor as notice without hourly failure mail", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"cost-watchdog-cli-"));
  const server=createServer((_request,response)=>{response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({lastAttempt:0}));});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{
    const {port}=server.address();
    const result=await promisify(execFile)(process.execPath,[new URL("./cost-monitor-watchdog.mjs",import.meta.url).pathname],{env:{...process.env,COST_MONITOR_URL:`http://127.0.0.1:${port}`,MONITOR_ADMIN_TOKEN:"local-only",MONITOR_OPS_RECIPIENTS:"",CF_MONITOR_API_TOKEN:"",CF_ACCOUNT_ID:"",ALERT_RECIPIENTS:'["customer@example.org"]',WATCHDOG_STATE_FILE:join(dir,"state.json")},timeout:10_000});
    assert.match(result.stdout,/::notice::Monitor heartbeat/);
    assert.deepEqual(JSON.parse(result.stdout.split("\n")[0]),{healthy:false,notified:false,failed:0,reason:"heartbeat",notificationMode:"actions-only"});
    assert.equal((await readWatchdogState(join(dir,"state.json"))).incident.reason,"heartbeat");
  }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test("P3 delivery reminders retain the quieter twelve-hour cadence",async()=>{
 let state;const sends=[];const persist=s=>{state=structuredClone(s);};
 await watchdog(env,scenario({...good,deliveryHealthy:false},sends),now,{state,persist});
 await watchdog(env,scenario({...good,lastAttempt:now+REPEAT_MS,deliveryHealthy:false},sends),now+REPEAT_MS,{state,persist});
 assert.equal(sends.length,2);
 await watchdog(env,scenario({...good,lastAttempt:now+2*REPEAT_MS,deliveryHealthy:false},sends),now+2*REPEAT_MS,{state,persist});
 assert.equal(sends.length,4);
});
