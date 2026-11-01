#!/usr/bin/env node
// Read platform rollout completion before stopping any fixed actor. Configuration
// image alone is not evidence that old placements have finished being replaced.
// wrangler deploy can burst the Containers API; HTTP 429/408/5xx retry inside
// the existing read budget. Other 4xx still fail closed.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACCOUNT, authorizeMutation } from './feed-production-release.mjs';
import { validateManifest } from './feed-platform-production.mjs';
import { validatePreviousApplications } from './feed-platform-production-readback.mjs';
import { validateImage } from './feed-platform-manifest.mjs';
const check=(ok,code)=>{if(!ok)throw new Error(code);};
const uuid=x=>typeof x==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const date=x=>typeof x==='string'&&Number.isFinite(Date.parse(x));
export const limits=Object.freeze({durationMs:300000,requests:120,requestMs:10000,intervalMs:10000,retryAfterMsMax:30000,responseBytes:524288});
export const retryableHttpStatuses=Object.freeze([408,429,500,502,503,504]);
function retryAfterMs(response){
  const raw=response.headers?.get?.('retry-after');
  if(typeof raw!=='string'||raw==='')return;
  if(/^\d+$/.test(raw)){const ms=Number(raw)*1000;return Number.isSafeInteger(ms)&&ms>0&&ms<=limits.durationMs?ms:undefined;}
  const at=Date.parse(raw);if(!Number.isFinite(at))return;
  const ms=at-Date.now();return Number.isSafeInteger(ms)&&ms>0&&ms<=limits.durationMs?ms:undefined;
}
function httpReadError(response){
  const retryable=retryableHttpStatuses.includes(response.status);
  const error=new Error(retryable?'rollout_http_retryable':'rollout_http_read_failed');
  error.httpStatus=response.status;if(retryable){const wait=retryAfterMs(response);if(wait!==undefined)error.retryAfterMs=wait;}
  return error;
}

export function inspectRollout(application, rollouts, previous, image, anchor) {
  check(application?.id===previous.id && application.name===previous.name && application.account_id===ACCOUNT &&
    application.scheduling_policy==='default' && integer(application.version), 'rollout_application_identity_changed');
  const current=application.configuration?.image;
  check((current===image && application.version>previous.version) ||
    (current===previous.image && application.version===previous.version), 'rollout_application_configuration_changed');
  check(Array.isArray(rollouts)&&rollouts.length>0&&rollouts.length<=1000 &&
    rollouts.every(r=>uuid(r?.id)&&date(r.created_at))&&new Set(rollouts.map(r=>r.id)).size===rollouts.length,
  'rollout_inventory_invalid');
  const sorted=[...rollouts].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
  check(sorted.length===1||Date.parse(sorted[0].created_at)>Date.parse(sorted[1].created_at),'rollout_latest_ambiguous');
  const latest=sorted[0];
  check(['pending','progressing','completed'].includes(latest.status),'rollout_terminal_or_unknown_status');
  check(latest.strategy==='rolling' && latest.kind==='full_auto' && integer(latest.target_version) &&
    Array.isArray(latest.health?.errors) && latest.health.errors.length===0, 'rollout_contract_or_health_invalid');
  if(latest.target_configuration?.image===previous.image && latest.target_version===previous.version && !anchor) {
    return {status:'pending',reason:'known_previous_rollout',applicationId:previous.id,applicationName:previous.name};
  }
  check(latest.target_configuration?.image===image && latest.target_version>previous.version &&
    latest.current_configuration?.image===previous.image && latest.current_version===previous.version,
  'rollout_target_or_predecessor_changed');
  check(!anchor||(anchor.rolloutId===latest.id&&anchor.targetVersion===latest.target_version),'rollout_superseded');
  check(application.version===previous.version||application.version===latest.target_version,'rollout_application_version_changed');
  check(!application.active_rollout_id||application.active_rollout_id===latest.id,'rollout_active_identity_changed');
  const observation={status:'pending',applicationId:previous.id,applicationName:previous.name,rolloutId:latest.id,
    targetVersion:latest.target_version,platformStatus:latest.status,createdAt:latest.created_at};
  check(Array.isArray(latest.steps)&&latest.steps.length>0&&latest.steps.length<=100&&
    latest.steps.every((s,i)=>s.id===i+1&&['pending','progressing','completed'].includes(s.status)&&
      Number.isFinite(s.step_size?.percentage)&&s.step_size.percentage>0&&s.step_size.percentage<=100), 'rollout_steps_invalid');
  if(latest.status!=='completed')return observation;
  const p=latest.progress, d=p?.version_distribution;
  check(latest.steps.every(s=>s.status==='completed'&&date(s.completed_at)&&Date.parse(s.completed_at)>=Date.parse(latest.created_at)) &&
    latest.steps.at(-1).step_size.percentage===100 && p?.total_steps===latest.steps.length && p.current_step===latest.steps.length &&
    integer(p.total_instances)&&p.updated_instances===p.total_instances && d?.target_version_percentage===100 &&
    d.current_version_instances===0 && d.target_version_instances===p.total_instances, 'rollout_completed_proof_invalid');
  if(current!==image)return {...observation,reason:'application_metadata_pending'};
  return {...observation,status:'passed',completedAt:latest.steps.at(-1).completed_at,targetPercentage:100};
}

export async function waitForRollouts(manifest,image,previous,{get,record=()=>{},now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  validateManifest(manifest);validateImage(image);
  const apps=[...validatePreviousApplications(previous,manifest).values()];
  check(apps.length===2&&previous.length===2&&apps.every(a=>a.image!==image),'rollout_requires_two_previous_applications_and_new_image');
  check(typeof get==='function','rollout_reader_required');
  const started=now(),deadline=started+limits.durationMs;
  const receipt={format:'ghfind-feed-platform-rollout-v1',status:'attempted_unverified',accountId:ACCOUNT,image,
    startedAt:new Date(started).toISOString(),requests:0,limits,observations:[]};
  const anchors=new Map();record(receipt);
  const read=async path=>{
    check(now()<deadline&&receipt.requests<limits.requests,'rollout_read_budget_exhausted');receipt.requests++;
    const duration=Math.min(limits.requestMs,deadline-now());let timer;
    try{return await Promise.race([get(path,AbortSignal.timeout(duration)),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('rollout_request_timeout')),duration);
    })]);}finally{clearTimeout(timer);check(now()<deadline,'rollout_deadline_exceeded');}
  };
  try {
    for(;;){
      try{
        const round=[];
        for(const app of apps){
          const path=`/containers/applications/${app.id}`;
          const application=await read(path),rollouts=await read(`${path}/rollouts`);
          const result=inspectRollout(application,rollouts,app,image,anchors.get(app.id));
          if(result.rolloutId)anchors.set(app.id,result);
          round.push(result);receipt.observations.push({...result,observedAt:new Date(now()).toISOString()});record(receipt);
        }
        if(round.every(r=>r.status==='passed')){receipt.status='passed';receipt.applications=round;receipt.completedAt=new Date(now()).toISOString();record(receipt);return receipt;}
        check(now()+limits.intervalMs<deadline&&receipt.requests+4<=limits.requests,'rollout_wait_budget_exhausted');
        await sleep(limits.intervalMs);
      }catch(error){
        const retryable=error?.message==='rollout_http_retryable'&&Number.isInteger(error.httpStatus)&&error.httpStatus>=100&&error.httpStatus<=599;
        if(!retryable)throw error;
        const retries=receipt.observations.filter(o=>o.reason==='http_retryable').length;
        const suggested=Number.isSafeInteger(error.retryAfterMs)&&error.retryAfterMs>0?error.retryAfterMs:limits.intervalMs*Math.min(4,retries+1);
        const wait=Math.min(limits.retryAfterMsMax,Math.max(limits.intervalMs,suggested));
        receipt.httpStatus=error.httpStatus;
        receipt.observations.push({status:'pending',reason:'http_retryable',httpStatus:error.httpStatus,observedAt:new Date(now()).toISOString()});
        record(receipt);
        check(now()+wait<deadline&&receipt.requests+4<=limits.requests,'rollout_wait_budget_exhausted');
        await sleep(wait);
      }
    }
  }catch(error){
    receipt.status='failed';receipt.failureCode=/^rollout_[a-z_]+$/.test(error?.message??'')?error.message:'rollout_read_failed';
    if(Number.isInteger(error?.httpStatus)&&error.httpStatus>=100&&error.httpStatus<=599)receipt.httpStatus=error.httpStatus;
    record(receipt);throw error;
  }
}
export function rolloutReader(token,fetcher=fetch){
  check(typeof token==='string'&&token.length>0&&!/[\x00-\x20\x7f]/.test(token),'rollout_token_required');
  return async(path,signal)=>{
    check(/^\/containers\/applications\/[a-f0-9-]{36}(?:\/rollouts)?$/.test(path),'rollout_read_path_invalid');
    const response=await fetcher(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`,{
      method:'GET',redirect:'error',signal,headers:{authorization:`Bearer ${token}`,accept:'application/json'}});
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw httpReadError(response);}
    let size=0;const chunks=[];
    for await(const chunk of response.body??[]){size+=chunk.byteLength;check(size<=limits.responseBytes,'rollout_response_too_large');chunks.push(chunk);}
    let body;try{body=JSON.parse(Buffer.concat(chunks));}catch{throw new Error('rollout_invalid_json');}
    check(body?.success===true&&body.result!==undefined,'rollout_api_read_failed');return body.result;
  };
}
async function main(){
  authorizeMutation();
  const [manifestPath,image,previousPath,output]=process.argv.slice(2);
  check(process.argv.length===6&&output&&resolve(output)===output,'rollout_invalid_arguments');
  const load=path=>{const bytes=readFileSync(path);check(bytes.length<=limits.responseBytes,'rollout_input_too_large');return JSON.parse(bytes);};
  let first=true;
  await waitForRollouts(load(manifestPath),image,load(previousPath),{get:rolloutReader(process.env.CLOUDFLARE_API_TOKEN),
    record:value=>{writeFileSync(output,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:first?'wx':'w'});first=false;}});
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  main().catch(error=>{console.error(/^rollout_[a-z_]+$/.test(error.message)?error.message:'rollout_verification_failed');process.exitCode=1;});
