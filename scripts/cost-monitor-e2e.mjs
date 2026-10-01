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
  const body=await response.json();return {status:response.status,body};
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
    server.stdout.on("data",()=>{});server.stderr.on("data",()=>{});
    for(let i=0;i<120;i++){try{await request("/health","GET");break;}catch{await new Promise(r=>setTimeout(r,250));if(i===119)throw new Error("Local workerd did not start");}}
  }
  assert.equal((await request("/health","GET",false)).status,401);
  assert.equal((await request("/arbitrary-route")).status,404);
  assert.equal((await request("/test/reset")).status,200);
  if(result.kind==="remote"){
    const live=await request("/run");assert.equal(live.status,200);assert.equal(live.body.status,"ok");assert.ok(live.body.points>0);assert.deepEqual(live.body.errors,[]);result.steps.push({name:"real Cloudflare collection",...live.body});
    await request("/test/reset");
  }
  await request("/test/baseline");
  const partial=(await request("/test/partial")).body;
  assert.equal(partial.pending,1,"A failed second recipient must remain queued");
  const opened=(await request("/test/duplicate")).body;
  assert.equal(opened.pending,0);assert.equal(opened.deliveries.length,1);assert.equal(opened.deliveries[0].kind,"open");assert.equal(opened.deliveries[0].recipients,2);
  const duplicate=(await request("/test/duplicate")).body;assert.equal(duplicate.deliveries.length,1,"Same bucket must not resend");
  const repeated=(await request("/test/reminder")).body;assert.equal(repeated.deliveries.length,2);assert.equal(repeated.deliveries[1].kind,"reminder");
  const recovered=(await request("/test/recovery")).body;assert.equal(recovered.deliveries.length,3);assert.equal(recovered.deliveries[2].kind,"recovery");
  const health=(await request("/health","GET")).body;assert.equal(health.pending,0);assert.equal(health.mailReceipts.length,6,"Exactly one accepted message per recipient per transition");result.steps.push({name:"incident, partial-recipient retry, dedupe, reminder, recovery",deliveries:recovered.deliveries,mailReceipts:health.mailReceipts});
  const limited=(await request("/test/rate-limit")).body;assert.equal(limited.pending,1);
  const capped=(await request("/health","GET")).body;assert.equal(capped.mailReceipts.length,6);assert.match(capped.lastError,/rate budget/);result.steps.push({name:"global mail rate limit retains pending notifications"});
  const retention=(await request("/test/retention")).body;assert.equal(retention.before,288);assert.equal(retention.after,0);result.steps.push({name:"workerd storage cap and TTL purge",...retention});
  if(result.kind==="local-workerd"){
    // Invoke the real scheduled event and alarm-capable storage handler, not only pure policy code.
    await request("/test/reset");
    const scheduled=await fetch(`${base}/__scheduled?cron=${encodeURIComponent("*/5 * * * *")}`,{signal:AbortSignal.timeout(120_000)});assert.equal(scheduled.status,500,"Missing live analytics is detected as degraded");
    const after=(await request("/health","GET")).body;assert.ok(after.lastAttempt>0);assert.ok(after.lastError);result.steps.push({name:"real scheduled entry detects collection failure"});
  }
  result.completed=true;console.log(JSON.stringify({kind:result.kind,completed:true,steps:result.steps.map(x=>x.name)}));
} finally {
  if(process.env.COST_MONITOR_EVIDENCE)await fs.writeFile(process.env.COST_MONITOR_EVIDENCE,JSON.stringify(result,null,2),{mode:0o600});
  if(server){try{process.kill(-server.pid,"SIGTERM");}catch{}await new Promise(resolve=>{server.once("exit",resolve);setTimeout(()=>{try{process.kill(-server.pid,"SIGKILL");}catch{}resolve();},5000);});}
  if(temporary)await fs.rm(temporary,{recursive:true,force:true});
}
