#!/usr/bin/env node
// Replace old container processes only behind the paused gateway and detached
// consumers. Unlike baseline propagation, no failed POST is ever retried.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACCOUNT, authorizeMutation, verifyWeb } from './feed-production-release.mjs';
import { production, validateManifest } from './feed-platform-production.mjs';
import { boundedJSON } from './feed-platform-web-verify.mjs';
const targets = ['api-0', 'api-1', 'executor-0'];
const CONFIG_READ_ATTEMPTS = 3, CONFIG_READ_BACKOFF_MS = 3000;
const check = (ok, message) => { if (!ok) throw new Error(message); };
const uuid = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value ?? '');
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const errorCodes = new Set([
  'unauthorized', 'not_found', 'invalid_transition', 'transition_in_progress', 'transition_timeout',
  'transition_stop_timeout', 'transition_environment_not_ready', 'transition_unavailable',
  'runtime_unconfigured', 'runtime_configuration_invalid', 'runtime_configuration_unavailable',
  'runtime_deployment_identity_mismatch', 'container_no_instance', 'container_not_ready',
  'container_starting', 'container_dependency_not_ready', 'container_response_not_json',
  'container_version_or_contract_mismatch', 'actor_reset_by_deploy', 'actor_overloaded',
  'executor_not_enabled', 'internal_error',
]);
class OffRequestError extends Error {
  constructor(path, status, code) {
    super(`off transition request rejected (${status}; ${path}; ${code})`);
    this.diagnostic = { path, phase: path.endsWith('/restart') ? 'restart' : 'configuration', status, code };
  }
}
export { OffRequestError };
export async function readOffResponse(response, path) {
  check(/^(configuration|(api-[01]|executor-0)\/(configuration|restart))$/.test(path), 'invalid off request path');
  if (response.status === 200) return boundedJSON(response,2048);
  let code = 'unrecognized_error_body';
  try {
    const value = (await boundedJSON(response,2048))?.error;
    if (typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value) && errorCodes.has(value)) code=value;
  } catch { code='unreadable_error_body'; }
  throw new OffRequestError(path,response.status,code);
}
export function validateConsumerReceipt(receipt, manifest, env) {
  check(receipt?.format === 'ghfind-feed-production-consumers-off-v1' && receipt.status === 'passed' &&
    receipt.accountId === ACCOUNT && receipt.runtimeWorker === manifest.runtimeWorker &&
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') &&
    receipt.runId === env.GITHUB_RUN_ID && receipt.runAttempt === env.GITHUB_RUN_ATTEMPT &&
    receipt.consumersAbsent === true && receipt.messagesDeleted === false && receipt.queuesDeleted === false,
  'off transition requires same-attempt detached consumers without message deletion');
  check(Array.isArray(receipt.queues) && receipt.queues.length === 2 &&
    new Set(receipt.queues.map(q => q.queueId)).size === 2 &&
    [manifest.queue, manifest.deadLetterQueue].every(name => receipt.queues.filter(q => q.name === name && hex(q.queueId,32) &&
      Array.isArray(q.consumerIds) && q.consumerIds.every(id => hex(id,32)) && new Set(q.consumerIds).size === q.consumerIds.length).length === 1),
  'off transition consumer queue identities differ');
  for (const list of [receipt.removed, receipt.deleteAttempts]) check(Array.isArray(list) && list.every(item =>
    exact(item,'queueId,consumerId') && receipt.queues.some(q => q.queueId === item.queueId && q.consumerIds.includes(item.consumerId))),
  'off transition consumer deletion identities differ');
  return receipt;
}
export async function transitionOffActors(identity, { consumerReceipt, manifest, env = process.env, paused, read, send, record = () => {}, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  authorizeMutation(env); validateManifest(manifest);
  check(hex(identity?.sourceSha,40) && hex(identity.imageBuildId,64) && identity.mode === 'off' && identity.writerEpoch === 1 &&
    identity.writerEpoch === manifest.writerEpoch && typeof identity.image === 'string' &&
    new RegExp(`^registry\\.cloudflare\\.com/${ACCOUNT}/ghfind-feed@sha256:[a-f0-9]{64}$`).test(identity.image), 'invalid off transition identity');
  const evidence = {format:'ghfind-feed-off-transition-v1',status:'attempted_unverified',...identity,
    runId:env.GITHUB_RUN_ID,runAttempt:env.GITHUB_RUN_ATTEMPT,targets:[],observations:[],readonlyCalls:0};
  const deadline = now() + 240000;
  let anchor, workerVersion, actorIds;
  let operation = { phase:'consumer_validation', path:null, status:null };
  const invoke = async (fn, timeout, readonly = false) => {
    check(now() < deadline, 'off transition deadline exceeded');
    if (readonly) check(++evidence.readonlyCalls <= 32, 'off transition read budget exceeded');
    let timer;
    try { const value = await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
      timer=setTimeout(()=>reject(new Error('off transition operation timeout')),Math.min(timeout,deadline-now()));
    })]); check(now() < deadline, 'off transition deadline exceeded'); return value; } finally { clearTimeout(timer); }
  };
  const checkPaused = async () => {
    operation={phase:'paused_web',path:null,status:null};
    // verifyWeb performs three bounded management reads, not one HTTP request.
    const value=await invoke(paused,30000,true);
    check(value?.status==='passed' && value.mode==='paused' && value.sourceSha===identity.sourceSha && value.backend==='go' &&
      value.store==='cf_d1_r2' && uuid(value.workerVersionId), 'current compatible Web must be paused');
    check(!anchor || anchor===value.workerVersionId,'paused Web anchor changed'); anchor=value.workerVersionId; evidence.pausedVersion=anchor;
  };
  record(evidence);
  try {
    validateConsumerReceipt(consumerReceipt,manifest,env);
    evidence.consumerReceipt={runId:consumerReceipt.runId,runAttempt:consumerReceipt.runAttempt,observedAt:consumerReceipt.observedAt,queues:consumerReceipt.queues};
    for (const target of targets) {
      await checkPaused();
      operation={phase:'configuration',path:'configuration',status:null};
      const edge=await invoke(()=>read('configuration'),10000,true);
      check(exact(edge,'service,version,contractVersion,workerVersionId,configuredImage,imageBuildId,mode,writerEpoch') &&
        edge.service==='feed-runtime' && edge.version===identity.sourceSha && edge.contractVersion==='1' &&
        edge.configuredImage===identity.image && edge.imageBuildId===identity.imageBuildId && edge.mode==='off' &&
        edge.writerEpoch===identity.writerEpoch && uuid(edge.workerVersionId), 'off runtime edge identity differs');
      check(!workerVersion || workerVersion===edge.workerVersionId,'off runtime version changed'); workerVersion=edge.workerVersionId;
      evidence.workerVersionId=workerVersion;
      const currentActors={};
      for(const actor of targets) {
        operation={phase:'configuration',path:`${actor}/configuration`,status:null};
        // Read-only metadata GET: a transient 503 runtime_configuration_unavailable
        // (DO still waking after the deploy) is retried a bounded number of times.
        // Lifecycle POSTs below are still never retried.
        let config;
        for (let attempt = 1; ; attempt++) {
          try { config=await invoke(()=>read(`${actor}/configuration`),10000,true); break; }
          catch (error) {
            if (!(error instanceof OffRequestError) || error.diagnostic.code !== 'runtime_configuration_unavailable' || attempt >= CONFIG_READ_ATTEMPTS) throw error;
            evidence.configurationRetries=(evidence.configurationRetries ?? 0)+1;
            await invoke(()=>sleep(CONFIG_READ_BACKOFF_MS*attempt),CONFIG_READ_BACKOFF_MS*attempt+1000);
          }
        }
        check(exact(config,'actorId,configuredImage,imageBuildId,mode,sourceSha,target,workerVersionId,writerEpoch') &&
          config.target===actor && hex(config.actorId,64) && config.sourceSha===identity.sourceSha && config.configuredImage===identity.image &&
          config.imageBuildId===identity.imageBuildId && config.mode==='off' && config.writerEpoch===identity.writerEpoch &&
          config.workerVersionId===workerVersion, 'off runtime actor identity differs');
        currentActors[actor]=config.actorId;
      }
      check(new Set(Object.values(currentActors)).size===3 && (!actorIds || targets.every(actor=>actorIds[actor]===currentActors[actor])),
        'off runtime actor identity changed or duplicated');
      actorIds=currentActors; evidence.actorIds=actorIds;
      evidence.observations.push({target,status:'off_configuration_verified',workerVersionId:workerVersion}); record(evidence);
      const item={target,actorId:actorIds[target],status:'attempted_unverified'}; evidence.targets.push(item); record(evidence);
      const body={sourceSha:identity.sourceSha,imageBuildId:identity.imageBuildId,mode:'off',writerEpoch:identity.writerEpoch};
      operation={phase:'restart',path:`${target}/restart`,status:null};
      const reply=await invoke(()=>send(target,body),35000);
      check(exact(reply,'imageBuildId,mode,restarted,sourceSha,target,writerEpoch') && reply.restarted===true && reply.target===target &&
        Object.entries(body).every(([key,value])=>reply[key]===value), 'off restart reply identity differs');
      item.status='passed'; item.receipt=reply; record(evidence);
    }
    await checkPaused();
    evidence.status='passed'; record(evidence); return evidence;
  } catch(error) {
    evidence.status='failed';
    evidence.error=error instanceof OffRequestError ? error.diagnostic : {...operation,code:'off_transition_failed'};
    record(evidence); throw error;
  }
}
async function main() {
  authorizeMutation();
  const [manifestPath,image,consumerPath,output]=process.argv.slice(2);
  check(process.argv.length===6 && output && resolve(output)===output,'usage: off-transition MANIFEST IMAGE CONSUMER_RECEIPT ABS_OUTPUT');
  const load=path=>{const bytes=readFileSync(path);check(bytes.length<=65536,'off transition input exceeds bound');return JSON.parse(bytes);};
  const manifest=load(manifestPath), consumerReceipt=load(consumerPath), secret=process.env.FEED_RUNTIME_ADMIN_SECRET;
  check(typeof secret==='string' && secret.length>=32 && !/[\x00-\x20\x7f]/.test(secret),'runtime admin credential absent');
  const request=async(path,body)=>{
    const response=await fetch(`${production.runtimeOrigin}/internal/runtime/${path}`,{method:body?'POST':'GET',redirect:'error',
      signal:AbortSignal.timeout(body?35000:10000),headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{})});
    return readOffResponse(response,path);
  };
  let first=true;
  await transitionOffActors({sourceSha:process.env.RELEASE_SHA,imageBuildId:process.env.FEED_IMAGE_BUILD_ID,image,mode:'off',writerEpoch:manifest.writerEpoch},{
    manifest,consumerReceipt,paused:()=>verifyWeb(process.env.RELEASE_SHA,'paused',process.env),read:path=>request(path),
    send:(target,body)=>request(`${target}/restart`,body),
    record:value=>{writeFileSync(output,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:first?'wx':'w'});first=false;},
  });
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
