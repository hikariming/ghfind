import {pathToFileURL} from "node:url";
export async function watchdog(env,fetcher=fetch,now=Date.now()){
  const required=["COST_MONITOR_URL","MONITOR_ADMIN_TOKEN","CF_MONITOR_API_TOKEN","CF_ACCOUNT_ID","ALERT_RECIPIENTS"];
  if(required.some(k=>!env[k]))throw new Error("Watchdog configuration incomplete");
  const targets=JSON.parse(env.ALERT_RECIPIENTS).filter(x=>typeof x==="string"&&x.trim());
  if(!targets.length||targets.length>20)throw new Error("Invalid watchdog recipients");
  let healthy=false;
  try{
    const response=await fetcher(`${env.COST_MONITOR_URL}/health`,{headers:{authorization:`Bearer ${env.MONITOR_ADMIN_TOKEN}`},signal:AbortSignal.timeout(20_000)});
    const health=await response.json();
    healthy=response.ok&&health.healthy===true&&typeof health.lastSuccess==="number"&&now-health.lastSuccess<30*60_000&&health.lastSuccess<=now+60_000;
  }catch{}
  if(healthy)return {healthy:true,notified:false};
  const text="Cloudflare 用量监控超过 30 分钟没有完整健康心跳，或采集/邮件链路异常。\n当前不能确认计费安全，请检查 ghfind-cost-monitor 的定时任务、API 权限及邮件发送。\n这是 GitHub Actions 的外部检查，每 30 分钟复查；调度可能延迟。";
  const response=await fetcher(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`,{method:"POST",headers:{authorization:`Bearer ${env.CF_MONITOR_API_TOKEN}`,"content-type":"application/json"},body:JSON.stringify({from:{address:env.ALERT_FROM??"alerts@mail.ghfind.com",name:"ghfind 监控心跳"},to:targets,subject:`[ghfind${env.WATCHDOG_E2E==="1"?" E2E 演练":""}] 用量监控心跳异常`,text:`${env.WATCHDOG_E2E==="1"?"这是外部心跳告警演练。\n":""}${text}`,html:`<p>${text.replace(/\n/g,"<br/>")}</p>`}),signal:AbortSignal.timeout(30_000)});
  const payload=await response.json();const result=payload.result??payload;
  if(!response.ok||payload.success===false||(result.permanent_bounces?.length??0)>0||((result.delivered?.length??0)+(result.queued?.length??0))!==targets.length)throw new Error("Watchdog mail was not accepted for every recipient");
  return {healthy:false,notified:true,messageId:result.message_id??null};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const r=await watchdog(process.env);console.log(JSON.stringify({healthy:r.healthy,notified:r.notified}));if(!r.healthy)process.exitCode=1;}
  catch{console.error("Cost-monitor watchdog failed; check private configuration and provider availability");process.exitCode=1;}
}
