import {test} from "node:test";
import assert from "node:assert/strict";
import {watchdog} from "./cost-monitor-watchdog.mjs";
const env={COST_MONITOR_URL:"https://monitor.example",MONITOR_ADMIN_TOKEN:"private",CF_MONITOR_API_TOKEN:"private",CF_ACCOUNT_ID:"account",ALERT_RECIPIENTS:'["one@example.org","two@example.org",""]'};
test("fresh healthy heartbeat sends no email",async()=>{
  let calls=0;const r=await watchdog(env,async()=>{calls++;return Response.json({healthy:true,lastSuccess:1000});},1001);assert.equal(calls,1);assert.equal(r.notified,false);
});
test("stale, unhealthy, future, unreachable and unauthorized heartbeat notify the full configured list",async()=>{
  for(const health of [{healthy:true,lastSuccess:0},{healthy:false,lastSuccess:1000},{healthy:true,lastSuccess:99999999},null,"unauthorized"]){
    let calls=0;const r=await watchdog(env,async(url,init)=>{
      calls++;if(calls===1){if(health===null)throw new Error("offline");return Response.json(health,{status:health==="unauthorized"?401:200});}
      assert.equal(url,"https://api.cloudflare.com/client/v4/accounts/account/email/sending/send");assert.deepEqual(JSON.parse(init.body).to,["one@example.org","two@example.org"]);return Response.json({success:true,result:{delivered:["one@example.org"],queued:["two@example.org"],permanent_bounces:[]}});
    },2_000_000);assert.equal(r.notified,true);assert.equal(calls,2);
  }
});
test("partial rejection fails instead of claiming all recipients notified",async()=>{
  let calls=0;await assert.rejects(watchdog(env,async()=>++calls===1?Response.json({healthy:false}):Response.json({success:true,result:{delivered:[],queued:["one@example.org"],permanent_bounces:["two@example.org"]}}),1000));
});
