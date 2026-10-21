import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
let base=process.env.COST_MONITOR_URL;
let token=process.env.MONITOR_ADMIN_TOKEN??"local-e2e-only";
let server,temporary;
const result={kind:base?"remote":"local-workerd",steps:[],completed:false};
async function request(route,method="POST",authenticated=true){
  const response=await fetch(`${base}${route}`,{method,headers:authenticated?{authorization:`Bearer ${token}`}:{},signal:AbortSignal.timeout(120_000)});
  const raw=await response.text();
  if(!raw.startsWith("{"))throw new Error(`${route}: HTTP ${response.status}: ${raw.replace(/<[^>]+>/g," ").slice(0,1200)}`);
  const body=JSON.parse(raw);return {status:response.status,body};
}
try {
  if(!base){
    temporary=await fs.mkdtemp(path.join(os.tmpdir(),"ghfind-cost-monitor-e2e-"));
    const config=JSON.parse(await fs.readFile(path.join(root,"apps/cost-monitor/wrangler.jsonc"),"utf8"));
    const local={...config,...config.env.e2e,name:"ghfind-cost-monitor-local-e2e",main:path.join(root,"apps/cost-monitor/src/index.ts"),env:undefined,triggers:undefined,vars:{...config.env.e2e.vars,E2E_CAPTURE_MAIL:"1"}};
    await fs.writeFile(path.join(temporary,"wrangler.json"),JSON.stringify(local));
    await fs.writeFile(path.join(temporary,".dev.vars"),`MONITOR_ADMIN_TOKEN=${JSON.stringify(token)}\nCF_MONITOR_API_TOKEN="local-e2e-not-used"\nALERT_RECIPIENTS='["one@example.org","two@example.org",""]'\n`,{mode:0o600});
    base="http://127.0.0.1:18788";
    server=spawn("pnpm",["--filter","@ghfind/cost-monitor","exec","wrangler","dev","--config",path.join(temporary,"wrangler.json"),"--port","18788","--ip","127.0.0.1","--test-scheduled","--persist-to",path.join(temporary,"state"),"--log-level","error"],{cwd:root,stdio:["ignore","pipe","pipe"],detached:true});
    server.stdout.on("data",()=>{});server.stderr.on("data",chunk=>process.stderr.write(chunk));
    for(let i=0;i<120;i++){try{await request("/health","GET");break;}catch{await new Promise(r=>setTimeout(r,250));if(i===119)throw new Error("Local workerd did not start");}}
  }
  assert.equal((await request("/health","GET",false)).status,401);
  assert.equal((await request("/arbitrary-route")).status,404);
  assert.equal((await request("/test/reset")).status,200);
  assert.deepEqual((await request("/test/atomic")).body,{cardinality:{rejected:true,stateUnchanged:true,windowsUnchanged:true,billingUnchanged:true},storageSize:{rejected:true,stateUnchanged:true,persistedStateUnchanged:true,windowsUnchanged:true,billingUnchanged:true},deliveryCapacity:{noSend:true,noAttempt:true,pendingRetained:true,reported:true}});
  result.steps.push({name:"atomic cardinality/state-byte rejection and pre-send receipt capacity protection"});
  await request("/test/reset");
  if(result.kind==="remote"){
    const live=await request("/run");assert.equal(live.status,200);assert.equal(live.body.status,"ok");assert.ok(live.body.points>0);assert.deepEqual(live.body.errors,[]);result.steps.push({name:"real Cloudflare collection",...live.body});
    await request("/test/reset");
  }
  const traffic=(await request("/test/traffic")).body;
  assert.equal(traffic.before,0);assert.equal(traffic.partial,1);assert.equal(traffic.failed,true);assert.equal(traffic.retry,2);assert.equal(traffic.attempts,123);assert.equal(traffic.duplicate,2);assert.equal(traffic.missed,2);assert.equal(traffic.after,2);
  result.steps.push({name:"traffic noon schedule, persistent partial retry, quota independence and missed-day catchup"});
  const deniedPreview=await fetch(`${base}/traffic-report/preview`,{method:"POST"});assert.equal(deniedPreview.status,401);
  await request("/test/reset");
  const daily=(await request("/test/daily")).body;
  assert.equal(daily.failureReported,true);assert.equal(daily.partial,1);assert.equal(daily.retry,2);assert.equal(daily.duplicate,2);assert.equal(daily.pending,0);
  assert.match(daily.subject,/\[日报\] 全部正常/);
  result.steps.push({name:"empty daily digest, durable partial-recipient retry and same-day dedupe",subject:daily.subject});
  await request("/test/reset");
  const mixedDaily=(await request("/test/daily-mixed")).body;
  assert.equal(mixedDaily.accepted,2);assert.equal(mixedDaily.afterHourly,2);assert.equal(mixedDaily.pending,0);
  assert.match(mixedDaily.subject,/1 项进行中/);
  result.steps.push({name:"daily report absorbs pending hourly alerts without duplicate delivery"});
  await request("/test/reset");
  const hourly=(await request("/test/hourly")).body;
  assert.deepEqual(hourly,{before:0,digest:2,critical:4,quiet:4,partial:5,retry:6,pending:0});
  result.steps.push({name:"hourly digest, urgent bypass and partial-recipient digest retry"});
  await request("/test/reset");
  const collection=(await request("/test/collection")).body;
  assert.deepEqual(collection,{transient:0,legacyRetired:true,sustained:0,stillIncomplete:true,mixed:2,customerOnly:true,recovery:2,pending:0,resolved:true});
  result.steps.push({name:"internal collection gaps stay silent; legacy partial mail retires and real business failures still send"});
  await request("/test/reset");
  const business=(await request("/test/business")).body;
  assert.equal(business.rows[0].total,5);assert.equal(business.rows[0].failed,1);assert.equal(business.rows[0].slow,1);assert.equal(business.severity,2);assert.equal(business.remaining,0);
  result.steps.push({name:"business aggregate RPC, critical failure policy and TTL cleanup"});
  await request("/test/baseline");
  const partial=(await request("/test/partial")).body;
  assert.equal(partial.pending,1,"A failed second recipient must remain queued");
  const opened=(await request("/test/duplicate")).body;
  assert.equal(opened.pending,0);assert.equal(opened.deliveries.length,1);assert.equal(opened.deliveries[0].kind,"open");assert.equal(opened.deliveries[0].recipients,2);
  const duplicate=(await request("/test/duplicate")).body;assert.equal(duplicate.deliveries.length,1,"Same bucket must not resend");
  const repeated=(await request("/test/reminder")).body;assert.equal(repeated.deliveries.length,2);assert.equal(repeated.deliveries[1].kind,"reminder");
  const recovered=(await request("/test/recovery")).body;assert.equal(recovered.deliveries.length,2);
  const health=(await request("/health","GET")).body;assert.equal(health.pending,0);assert.equal(health.mailReceipts.length,4,"Exactly one accepted message per recipient per transition");result.steps.push({name:"incident, partial-recipient retry, dedupe, reminder, recovery",deliveries:recovered.deliveries,mailReceipts:health.mailReceipts});
  const limited=(await request("/test/rate-limit")).body;assert.equal(limited.pending,1);
  const capped=(await request("/health","GET")).body;assert.equal(capped.mailReceipts.length,4);assert.match(capped.lastDeliveryError,/rate budget/);assert.equal(capped.deliveryHealthy,false);result.steps.push({name:"global mail rate limit retains pending notifications"});
  const retention=(await request("/test/retention")).body;assert.equal(retention.before,288);assert.equal(retention.after,0);result.steps.push({name:"workerd storage cap and TTL purge",...retention});
  if(result.kind==="local-workerd"){
    // Invoke the real scheduled event and alarm-capable storage handler, not only pure policy code.
    await request("/test/reset");
    const scheduled=await fetch(`${base}/__scheduled?cron=${encodeURIComponent("*/5 * * * *")}`,{signal:AbortSignal.timeout(120_000)});assert.equal(scheduled.status,200,"Expected upstream gaps must not manufacture Worker execution failures");
    const after=(await request("/health","GET")).body;assert.ok(after.lastAttempt>0);assert.ok(after.lastError);assert.equal(after.heartbeatHealthy,true);assert.equal(after.collectionHealthy,false);assert.equal(after.pending,0);result.steps.push({name:"real scheduled entry separates a transient telemetry gap from monitor failure"});
  }
  result.completed=true;console.log(JSON.stringify({kind:result.kind,completed:true,steps:result.steps.map(x=>x.name)}));
} finally {
  if(process.env.COST_MONITOR_EVIDENCE)await fs.writeFile(process.env.COST_MONITOR_EVIDENCE,JSON.stringify(result,null,2),{mode:0o600});
  if(server){try{process.kill(-server.pid,"SIGTERM");}catch{}await new Promise(resolve=>{server.once("exit",resolve);setTimeout(()=>{try{process.kill(-server.pid,"SIGKILL");}catch{}resolve();},5000);});}
  if(temporary)await fs.rm(temporary,{recursive:true,force:true});
}
