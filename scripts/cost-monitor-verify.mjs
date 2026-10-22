import {setTimeout as delay} from "node:timers/promises";
import {pathToFileURL} from "node:url";

export const VERIFY_LIMITS=Object.freeze({durationMs:12*60_000,readinessMs:90_000,requestMs:120_000,readinessRequestMs:10_000,intervalMs:15_000});
const BODY_LIMIT=64*1024;
export class MonitorVerificationError extends Error {
  constructor(code){super(`Cost monitor verification failed: ${code}`);this.code=code;}
}
const fail=code=>{throw new MonitorVerificationError(code);};
const record=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
// Collector errors are "<source>: <detail>". Only allowlisted source prefixes are
// logged so failures are diagnosable from public CI logs; details never are.
export const ERROR_CATEGORIES=Object.freeze(["D1","D1 SQL","Workers","R2 operations","R2 storage","KV","DO","Queues","Billing","Monitor"]);
export function errorCategories(errors){
  if(!Array.isArray(errors))return null;
  const found=new Set();
  for(const error of errors.slice(0,32)){
    const prefix=typeof error==="string"&&error.includes(":")?error.slice(0,error.indexOf(":")):"";
    found.add(ERROR_CATEGORIES.includes(prefix)?prefix:"other");
  }
  return [...found].sort();
}

async function boundedJson(response,signal){
  const reader=response.body?.getReader();if(!reader)return {json:false};
  const abort=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener("abort",abort,{once:true});
  let bytes=0,text="";const decoder=new TextDecoder();
  try{
    for(;;){
      signal.throwIfAborted();const chunk=await reader.read();signal.throwIfAborted();
      if(chunk.done)break;
      bytes+=chunk.value.byteLength;if(bytes>BODY_LIMIT)throw new Error("bounded response");
      text+=decoder.decode(chunk.value,{stream:true});
    }
    try{return {json:true,value:JSON.parse(text+decoder.decode())};}catch{return {json:false};}
  }finally{signal.removeEventListener("abort",abort);void reader.cancel().catch(()=>{});}
}

// Readiness is a read-only routing check. Success must come from this run's POST,
// never a cached or historical /health timestamp. POST transport/non-JSON errors
// have an unknown side-effect outcome and therefore must not be retried.
export async function verifyMonitor(env,options={}){
  const fetcher=options.fetcher??fetch,now=options.now??Date.now;
  const sleep=options.sleep??((ms,signal)=>delay(ms,undefined,{signal}));
  const log=options.log??(value=>console.log(JSON.stringify(value)));
  const limits={...VERIFY_LIMITS,...options.limits};
  if(Object.values(limits).some(n=>!Number.isSafeInteger(n)||n<=0))fail("invalid_limits");
  if(!env.COST_MONITOR_URL||!env.MONITOR_ADMIN_TOKEN)fail("configuration_incomplete");
  let base;
  try{base=new URL(env.COST_MONITOR_URL);}catch{fail("invalid_monitor_url");}
  if(!["https:","http:"].includes(base.protocol)||base.username||base.password||base.search||base.hash)fail("invalid_monitor_url");
  const started=now(),deadline=started+limits.durationMs,readyDeadline=Math.min(deadline,started+limits.readinessMs);
  const run=new AbortController();
  const timer=setTimeout(()=>run.abort(),limits.durationMs);
  const remaining=()=>deadline-now();
  const check=()=>{if(run.signal.aborted||remaining()<=0)fail("deadline_exceeded");};
  const wait=async(until)=>{
    check();const available=Math.min(until-now(),remaining());
    if(available<=0)fail(until===deadline?"deadline_exceeded":"readiness_timeout");
    try{await sleep(Math.min(limits.intervalMs,available),run.signal);}catch{fail("deadline_exceeded");}
    check();
  };
  const request=async(method,path,requestMs)=>{
    check();let response;
    const signal=AbortSignal.any([run.signal,AbortSignal.timeout(Math.max(1,Math.min(requestMs,remaining())))]);
    try{
      response=await fetcher(new URL(path,base).href,{method,redirect:"manual",headers:{authorization:`Bearer ${env.MONITOR_ADMIN_TOKEN}`},signal});
      // Auth and redirects are definitive failures; do not wait on their bodies.
      if([401,403].includes(response.status)||response.status>=300&&response.status<400){void response.body?.cancel().catch(()=>{});return {http:response.status,json:false};}
      const body=await boundedJson(response,signal);check();
      return {http:response.status,...body};
    }catch(error){
      if(error instanceof MonitorVerificationError)throw error;
      check();return {http:response?.status??null,json:false,transport:true};
    }
  };
  const report=(stage,attempt,response,status)=>log({event:"cost_monitor_verify_attempt",stage,attempt,http:response.http,status,points:count(response.value?.points),errorCount:Array.isArray(response.value?.errors)?response.value.errors.length:null,errorCategories:errorCategories(response.value?.errors)});
  try{
    for(let attempt=1;;attempt++){
      if(now()>=readyDeadline)fail("readiness_timeout");
      const response=await request("GET","/health",Math.min(limits.readinessRequestMs,readyDeadline-now()));
      const ready=response.http===200&&response.json&&record(response.value)&&response.value.version===2&&count(response.value.lastAttempt)!==null;
      report("readiness",attempt,response,ready?"ready":response.transport?"transport_error":response.json?"unexpected_json":"non_json");
      if(ready)break;
      if([401,403].includes(response.http))fail("readiness_unauthorized");
      if(response.http>=300&&response.http<400)fail("readiness_redirect");
      // GET is safe to retry during brief route propagation or edge outages.
      const transient=response.transport||response.http===404||response.http===429||response.http>=500||!response.json&&response.http===200;
      if(!transient)fail("readiness_unexpected_response");
      await wait(readyDeadline);
    }
    for(let attempt=1;;attempt++){
      const response=await request("POST","/run",limits.requestMs);
      const value=response.value;
      const status=record(value)&&["ok","busy","degraded"].includes(value.status)?value.status:response.transport?"transport_error":response.json?"unexpected_json":"non_json";
      report("collection",attempt,response,status);
      if([401,403].includes(response.http))fail("collection_unauthorized");
      if(response.transport||!response.json)fail("collection_outcome_unknown");
      if(response.http!==200)fail("collection_http_error");
      if(status==="ok"&&count(value.points)>0&&Array.isArray(value.errors)&&value.errors.length===0)return {status:"verified",attempts:attempt,points:value.points,errorCount:0};
      // tick() returns this exact shape before running when another caller owns
      // the durable ten-minute lease. Nothing was collected or sent in this call.
      if(status==="busy"&&Object.keys(value).length===1){await wait(deadline);continue;}
      if(status==="degraded")fail("collection_degraded");
      fail("collection_invalid_result");
    }
  }finally{clearTimeout(timer);run.abort();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const result=await verifyMonitor(process.env);console.log(JSON.stringify({event:"cost_monitor_verified",...result}));}
  catch(error){console.error(JSON.stringify({event:"cost_monitor_verify_failed",code:error instanceof MonitorVerificationError?error.code:"unexpected_verifier_error"}));process.exitCode=1;}
}
