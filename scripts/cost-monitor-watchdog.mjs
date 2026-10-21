import {createHmac} from "node:crypto";
import {mkdir,readFile,rename,stat,writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import {pathToFileURL} from "node:url";

export const REPEAT_MS=6*60*60_000;
const DELIVERY_REPEAT_MS=12*60*60_000;
const HEARTBEAT_MS=30*60_000;
const STATE_MAX_BYTES=8192;
const keyedHash=(env,value)=>createHmac("sha256",env.MONITOR_ADMIN_TOKEN).update(value).digest("hex");
const fresh=(at,now)=>typeof at==="number"&&Number.isFinite(at)&&at>0&&at<=now+60_000&&now-at<HEARTBEAT_MS;
const emptyState=()=>({version:1,incident:null});

// Only the scheduler and delivery path need an independent watchdog. The
// running monitor exposes upstream analytics/billing gaps in internal health only.
export function healthFailure(health,now){
  if(!health||typeof health!=="object")return "heartbeat";
  const attempted=Object.hasOwn(health,"lastAttempt")?health.lastAttempt:health.lastSuccess;
  if(!fresh(attempted,now)||health.heartbeatHealthy===false)return "heartbeat";
  if(health.deliveryHealthy===false)return "delivery";
  return null;
}

async function boundedJson(response){
  const reader=response.body?.getReader();
  if(!reader)throw new Error("Empty response");
  let size=0,text="";const decoder=new TextDecoder();
  try{
    for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>64*1024)throw new Error("Response too large");text+=decoder.decode(chunk.value,{stream:true});}
    return JSON.parse(text+decoder.decode());
  }finally{await reader.cancel();}
}

export async function readWatchdogState(path){
  try{
    if((await stat(path)).size>STATE_MAX_BYTES)return emptyState();
    const data=await readFile(path,"utf8");
    if(Buffer.byteLength(data)>STATE_MAX_BYTES)return emptyState();
    const state=JSON.parse(data);
    return state?.version===1?state:emptyState();
  }catch(error){if(error.code==="ENOENT"||error instanceof SyntaxError)return emptyState();throw error;}
}

export async function saveWatchdogState(path,state){
  const data=JSON.stringify(state);
  if(Buffer.byteLength(data)>STATE_MAX_BYTES)throw new Error("Watchdog state exceeds bound");
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temporary=`${path}.${process.pid}.tmp`;
  await writeFile(temporary,data,{mode:0o600});
  await rename(temporary,path);
}

function normalizedState(input,env,targets,now){
  const state=emptyState(),old=input?.version===1?input.incident:null;
  if(!old||!["heartbeat","delivery"].includes(old.reason)||!Number.isFinite(old.startedAt)||old.startedAt>now||old.startedAt<=0||old.scope!==keyedHash(env,`monitor:${env.COST_MONITOR_URL}`))return state;
  state.incident={scope:old.scope,reason:old.reason,startedAt:old.startedAt,notified:{}};
  for(const to of targets){
    const id=keyedHash(env,`recipient:${to}`),at=old.notified?.[id];
    if(typeof at==="number"&&Number.isFinite(at)&&at>=old.startedAt&&at<=now)state.incident.notified[id]=at;
  }
  return state;
}

function message(reason,startedAt,now,e2e){
  const title=reason==="delivery"?"告警邮件发送异常":"监控任务心跳中断";
  const impact=reason==="delivery"?"监控仍在运行，但部分告警邮件未能被发送服务接受。":"超过 30 分钟未确认监控任务运行，或健康检查接口不可达。";
  const action=reason==="delivery"?"检查 Cloudflare Email Service 的发送状态、配额和收件地址。":"检查 ghfind-cost-monitor 的 Cron、部署状态和健康接口鉴权。";
  const started=new Date(startedAt+8*3600_000).toISOString().replace("T"," ").slice(0,16)+" 北京时间";
  const duration=Math.max(0,Math.floor((now-startedAt)/60_000));
  const intro=e2e?"这是外部心跳告警演练。\n":"";
  const text=`${intro}${title}\n${impact}\n\n首次检测：${started}（持续 ${duration} 分钟）\n下一步：${action}\n\n同一异常仅首次通知，持续时每 ${reason==="heartbeat"?6:12} 小时提醒；恢复后静默。此通知不代表已发生费用超支。`;
  const escaped=text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return {subject:`[ghfind]${e2e?"[模拟]":""}[P${reason==="delivery"?3:1}][监控] ${title}`,text,html:`<div style="max-width:640px;font:15px/1.7 system-ui,sans-serif"><p style="white-space:pre-line">${escaped}</p></div>`};
}

export async function watchdog(env,fetcher=fetch,now=Date.now(),options={}){
  const required=["COST_MONITOR_URL","MONITOR_ADMIN_TOKEN"];
  if(required.some(k=>!env[k]))throw new Error("Watchdog configuration incomplete");
  // Operator routing is explicit and independent of customer notifications.
  // Missing/blank/[] means report via CLI and Actions only; never fall back to
  // ALERT_RECIPIENTS, and do not require email credentials in that mode.
  let input=[];
  try{if(env.MONITOR_OPS_RECIPIENTS?.trim())input=JSON.parse(env.MONITOR_OPS_RECIPIENTS);}catch{throw new Error("Invalid watchdog recipients");}
  if(!Array.isArray(input)||input.some(x=>typeof x!=="string"))throw new Error("Invalid watchdog recipients");
  const targets=[...new Set(input.map(x=>x.trim().toLowerCase()).filter(Boolean))];
  if(targets.length>20||targets.some(x=>!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(x)))throw new Error("Invalid watchdog recipients");
  if(targets.length&&(!env.CF_MONITOR_API_TOKEN||!env.CF_ACCOUNT_ID))throw new Error("Watchdog email configuration incomplete");
  const notificationMode=targets.length?"operations":"actions-only";
  const state=normalizedState(options.state,env,targets,now);
  const persist=async()=>{if(options.persist)await options.persist(state);};
  let reason="heartbeat";
  try{
    const response=await fetcher(`${env.COST_MONITOR_URL}/health`,{headers:{authorization:`Bearer ${env.MONITOR_ADMIN_TOKEN}`},signal:AbortSignal.timeout(20_000)});
    if(response.ok)reason=healthFailure(await boundedJson(response),now);
    else await response.body?.cancel();
  }catch{}
  if(!reason){state.incident=null;await persist();return {healthy:true,notified:false,failed:0,notificationMode,state};}
  if(state.incident?.reason!==reason)state.incident={scope:keyedHash(env,`monitor:${env.COST_MONITOR_URL}`),reason,startedAt:now,notified:{}};
  await persist();
  const notice=message(reason,state.incident.startedAt,now,env.WATCHDOG_E2E==="1");
  const due=targets.filter(to=>{const at=state.incident.notified[keyedHash(env,`recipient:${to}`)];return at===undefined||now-at>=(reason==="heartbeat"?REPEAT_MS:DELIVERY_REPEAT_MS);});
  let notified=0,failed=0;
  // Groups of four keep worst-case calls below the workflow timeout. No raw
  // address is persisted, and accepted recipients survive another recipient's failure.
  for(let offset=0;offset<due.length;offset+=4){
    const results=await Promise.all(due.slice(offset,offset+4).map(async to=>{
      try{
        const response=await fetcher(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`,{method:"POST",headers:{authorization:`Bearer ${env.CF_MONITOR_API_TOKEN}`,"content-type":"application/json"},body:JSON.stringify({from:{address:env.ALERT_FROM??"alerts@mail.ghfind.com",name:"ghfind 告警"},to:[to],...notice}),signal:AbortSignal.timeout(30_000)});
        const payload=await boundedJson(response),result=payload.result??payload;
        const accepted=[...(Array.isArray(result.delivered)?result.delivered:[]),...(Array.isArray(result.queued)?result.queued:[])];
        return {to,ok:response.ok&&payload.success!==false&&!(result.permanent_bounces?.length??0)&&accepted.length===1&&accepted[0]===to};
      }catch{return {to,ok:false};}
    }));
    for(const result of results){
      if(result.ok){state.incident.notified[keyedHash(env,`recipient:${result.to}`)]=now;notified++;}
      else failed++;
    }
    await persist();
  }
  return {healthy:false,notified:notified>0,failed,reason,notificationMode,state};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const path=process.env.WATCHDOG_STATE_FILE;
    if(!path)throw new Error("Watchdog state path not configured");
    const state=await readWatchdogState(path);
    const result=await watchdog(process.env,fetch,Date.now(),{state,persist:state=>saveWatchdogState(path,state)});
    console.log(JSON.stringify({healthy:result.healthy,notified:result.notified,failed:result.failed,reason:result.reason??null,notificationMode:result.notificationMode}));
    if(!result.healthy)console.log(`::notice::Monitor ${result.reason}; notification state persisted`);
  }catch{console.error("Cost-monitor watchdog failed; check private configuration and provider availability");process.exitCode=1;}
}
