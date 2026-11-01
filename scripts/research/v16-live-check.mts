/** Explicit, bounded live checks. Account names and credentials come from env;
 * stdout and the optional report contain anonymous labels and numeric scores. */
import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import {score} from '../../src/lib/score';
import type {RawMetrics,Scoring} from '../../src/lib/types';
const require=createRequire(import.meta.url);
interface Dispatcher {close():Promise<void>}
const runtime=createRequire(require.resolve('wrangler/package.json'))('undici') as {
 ProxyAgent:new(uri:string)=>Dispatcher;
 fetch:(url:string,init:RequestInit & {dispatcher?:Dispatcher})=>Promise<Response>;
};
const proxy=process.env.HTTPS_PROXY?new runtime.ProxyAgent(process.env.HTTPS_PROXY):undefined;
const origin=process.env.V16_LIVE_ORIGIN??'https://ghfind.com';
const accounts=[...['PATTERN','CONTROL'].flatMap(role=>(process.env[`V16_${role}_ACCOUNTS`]??'').split(',').filter(Boolean).map((username,index)=>({username,role,id:`${role.toLowerCase()}-${index+1}`})))];
if(!accounts.some(a=>a.role==='PATTERN')||!accounts.some(a=>a.role==='CONTROL')||accounts.length>8)throw Error('Provide 1–8 total pattern/control accounts through env');
if(accounts.some(a=>!/^\w[\w-]{0,38}$/.test(a.username)))throw Error('Invalid account input');
const headers:Record<string,string>={'content-type':'application/json'};
const token=process.env.GHFIND_API_KEY??process.env.GITHUB_ROAST_CLI_API_KEY;
if(token)headers.authorization=`Bearer ${token}`;
interface Payload {metrics?:RawMetrics;scoring?:Scoring;stale?:boolean;served_score_version?:string;cached?:boolean}
const results=[];
try {
 for(const account of accounts){
  const started=Date.now();
  let response=await runtime.fetch(`${origin}/api/scan?force=1`,{method:'POST',headers,body:JSON.stringify({username:account.username}),dispatcher:proxy,signal:AbortSignal.timeout(75_000)});
  let status=response.status;
  let payload=await response.json() as Payload;
  while(status===202&&Date.now()-started<600_000){
   console.log(account.id,'pending');
   await new Promise(resolve=>setTimeout(resolve,Math.max(5,Math.min(60,Number(response.headers.get('retry-after'))||5))*1000));
   response=await runtime.fetch(`${origin}/api/scan?username=${encodeURIComponent(account.username)}`,{headers,dispatcher:proxy,signal:AbortSignal.timeout(75_000)});
   status=response.status;payload=await response.json() as Payload;
  }
  const valid=status===200&&!payload.stale&&payload.metrics?.content_skill_star_share!==undefined&&payload.scoring!==undefined;
  const parity=valid&&score(payload.metrics!).final_score===payload.scoring!.final_score;
  const result={id:account.id,status,valid,parity,final:payload.scoring?.final_score,original:payload.scoring?.sub_scores.original_project_quality,content_share:payload.metrics?.content_skill_star_share,served_version:payload.served_score_version,elapsed_ms:Date.now()-started};
  results.push(result);console.log(JSON.stringify(result));
  if(!valid||!parity){process.exitCode=1;break;}
 }
 if(process.env.V16_LIVE_REPORT)writeFileSync(process.env.V16_LIVE_REPORT,JSON.stringify(results,null,2)+'\n');
} catch {console.error('Live verification failed; no account identifiers or response bodies logged.');process.exitCode=1;}
finally{await proxy?.close();}
