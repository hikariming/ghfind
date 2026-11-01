#!/usr/bin/env node
// Mutating release operation, distinct from read-only readiness. A fixed sleep
// cannot replace observing native stop/start when an image stays unchanged.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { authorizeMutation, verifyWeb } from './feed-production-release.mjs';
import { production, validateManifest, validateReceipt } from './feed-platform-production.mjs';
import { boundedJSON } from './feed-platform-web-verify.mjs';
const targets = ['api-0', 'api-1', 'executor-0'];
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
export function validatePreDispatchRejection(rejection, offVersion) {
  requireThat(rejection && Object.keys(rejection).sort().join(',') === 'error,workerVersionId' &&
    rejection.error === 'transition_environment_not_ready' && rejection.workerVersionId === offVersion,
    'unproven transition rejection');
}
// The runtime answers failures as {"error": "<code>"} (platform/runtime
// HTTPError). Surface only that code so an intermittent 503 names its cause
// (container_not_ready, transition_stop_timeout, ...) without echoing bodies.
export async function rejectionCode(response) {
  try {
    const code = (await boundedJSON(response, 2048))?.error;
    return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'unrecognized_error_body';
  } catch {
    return 'unreadable_error_body';
  }
}
export async function readTransitionResponse(response, target, offVersion) {
  if (response.status === 409) {
    const rejection = await boundedJSON(response, 2048);
    validatePreDispatchRejection(rejection, offVersion);
    return { rejectedWithoutMutation: true };
  }
  // Error-message arguments are evaluated even when an assertion succeeds.
  // Read only the selected branch so a 200 receipt remains available for the
  // release caller's exact identity validation, without retrying the mutation.
  if (response.status !== 200)
    throw new Error(`mode transition rejected (${response.status}; ${target}; ${await rejectionCode(response)})`);
  const receipt = await boundedJSON(response, 2048);
  // Only the verified HTTP 409 branch may grant a pre-dispatch retry. A 200
  // body carrying that internal marker is an invalid receipt, not permission.
  requireThat(receipt && typeof receipt === 'object' && !Array.isArray(receipt) &&
    Object.keys(receipt).sort().join(',') === 'imageBuildId,mode,restarted,sourceSha,target,writerEpoch' &&
    receipt.restarted === true, 'transition reply shape differs');
  return receipt;
}
// Code updates reach globally unique DOs eventually (seconds to minutes).
// One allowance covers metadata reads, their waits, and the optional one-shot
// refresh with its paused-Web check. It never grants lifecycle retries.
// https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates
export const configurationLimits = Object.freeze({ durationMs: 180000, reads: 90, edgeAttempts: 45, intervalMs: 5000 });
export const configurationRetryCodes = Object.freeze([
  'container_starting', 'container_dependency_not_ready', 'runtime_configuration_unavailable', 'actor_reset_by_deploy',
]);
export class ConfigurationRetry extends Error {
  constructor(code) {
    super('runtime configuration retryable');
    this.name = 'ConfigurationRetry';
    this.httpStatus = 503;
    this.code = code;
  }
}
export async function readConfigurationResponse(response) {
  if (response.status === 200) return boundedJSON(response, 2048);
  let code = 'unrecognized_error_body';
  try {
    const value = await boundedJSON(response, 2048);
    if (value && Object.keys(value).join(',') === 'error' && typeof value.error === 'string' && /^[a-z0-9_]{1,64}$/.test(value.error))
      code = value.error;
  } catch { code = 'unreadable_error_body'; }
  if (response.status === 503 && configurationRetryCodes.includes(code)) throw new ConfigurationRetry(code);
  throw new Error(`runtime configuration preflight rejected (${response.status})`);
}
export async function readRefreshResponse(response, offVersionId, baselineVersionId) {
  // A reset may disconnect its own RPC. None of these outcomes proves the new
  // object exists; only a subsequent exact configuration GET can do that.
  if ([400,409,503].includes(response.status)) {
    try {
      const value=await boundedJSON(response,2048);
      if (response.status===503 && value && Object.keys(value).join(',')==='error' && value.error==='refresh_outcome_unknown')
        return { status:'uncertain',httpStatus:503 };
      if(response.status===409 && value && Object.keys(value).sort().join(',')==='error,workerVersionId') {
        if(value.error==='refresh_edge_not_ready' && offVersionId && value.workerVersionId===offVersionId)
          return {status:'pre_dispatch_rejection',httpStatus:409,code:value.error};
        if(value.error==='refresh_actor_already_current' && baselineVersionId && value.workerVersionId===baselineVersionId)
          return {status:'already_current_unverified',httpStatus:409,code:value.error};
      }
      if(response.status===400 && value && Object.keys(value).join(',')==='error' &&
        ['invalid_refresh','invalid_refresh_shape','invalid_refresh_identity','invalid_refresh_edge_version','invalid_refresh_actor_version','invalid_refresh_actor_scope'].includes(value.error))
        return {status:'rejected',httpStatus:400,code:value.error};
    } catch { /* An unreadable HTTP reply does not establish the RPC boundary. */ }
  }
  return { status: 'rejected', httpStatus: response.status };
}
export function edgePreflight(identity, off, { read, readActor, refresh, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  requireThat(/^[a-f0-9-]{36}$/.test(off?.runtime?.versionId ?? '') && typeof off.image === 'string', 'off edge identity required');
  let remainingMs = configurationLimits.durationMs;
  let attempts = 0, reads = 0, baselineVersion, actorsVerified = false;
  const refreshed = new Set();
  const refreshAttempts = new Map();
  const actorIds = new Map((off.readiness ?? []).map(value => [value.target, value.actorId]));
  if (readActor) requireThat(actorIds.size === 3 && targets.every(target => /^[a-f0-9]{64}$/.test(actorIds.get(target) ?? '')) &&
    new Set(actorIds.values()).size === 3, 'off actor identity required');
  return async (record, currentTarget = targets[0], checkPaused) => {
    const startedAt = now(), deadline = startedAt + remainingMs;
    const observe = value => record({ ...value,
      elapsedMs: configurationLimits.durationMs - remainingMs + Math.max(0, now() - startedAt) });
    try {
    const remaining = () => {
      requireThat(now() < deadline && reads < configurationLimits.reads, 'runtime configuration preflight exhausted');
      reads++;
      return Math.max(1, deadline - now());
    };
    const starting = error => error instanceof ConfigurationRetry && error.httpStatus === 503 && configurationRetryCodes.includes(error.code);
    while (attempts < configurationLimits.edgeAttempts && now() < deadline && reads < configurationLimits.reads) {
      const attempt = ++attempts;
      observe({ attempt, status: 'attempted_unverified' });
      let value;
      try { value = await read(remaining()); }
      catch (error) {
        if (!starting(error)) throw error;
        observe({ attempt, status: 'starting', httpStatus: error.httpStatus, code: error.code });
        if (attempts < configurationLimits.edgeAttempts && now() + configurationLimits.intervalMs < deadline) {
          await sleep(configurationLimits.intervalMs); continue;
        }
        throw new Error('runtime edge preflight exhausted');
      }
      requireThat(now() < deadline, 'runtime edge preflight deadline exceeded');
      requireThat(value && Object.keys(value).sort().join(',') === ['service','version','contractVersion','workerVersionId','configuredImage','imageBuildId','mode','writerEpoch'].sort().join(',') &&
        value.service === 'feed-runtime' && value.version === identity.sourceSha && value.contractVersion === '1' &&
        value.configuredImage === off.image && value.imageBuildId === identity.imageBuildId && value.writerEpoch === identity.writerEpoch &&
        /^[a-f0-9-]{36}$/.test(value.workerVersionId ?? ''), 'runtime edge identity differs');
      if (value.mode === 'baseline' && value.workerVersionId !== off.runtime.versionId) {
        requireThat(!baselineVersion || baselineVersion === value.workerVersionId, 'baseline edge version changed');
        baselineVersion = value.workerVersionId;
        observe({ attempt, status: 'baseline_verified', workerVersionId: baselineVersion });
        // Prove every fixed actor before the first lifecycle POST; subsequent
        // invocations recheck the current actor within the same shared budget.
        if (readActor) for (const actor of actorsVerified ? [currentTarget] : targets) {
          requireThat(targets.includes(actor), 'invalid configuration target');
          let recheckEdge=false;
          while (true) {
            if(recheckEdge) {
              let edge;
              try { edge=await read(remaining()); }
              catch (error) {
                if (!starting(error)) throw error;
                observe({scope:'refresh_edge',actor,status:'starting',httpStatus:error.httpStatus,code:error.code});
                requireThat(now()+configurationLimits.intervalMs<deadline,'runtime configuration preflight exhausted');
                await sleep(configurationLimits.intervalMs);continue;
              }
              requireThat(edge && Object.keys(edge).sort().join(',')==='configuredImage,contractVersion,imageBuildId,mode,service,version,workerVersionId,writerEpoch' &&
                edge.service==='feed-runtime' && edge.version===identity.sourceSha && edge.contractVersion==='1' &&
                edge.configuredImage===off.image && edge.imageBuildId===identity.imageBuildId && edge.writerEpoch===identity.writerEpoch,
              'refresh retry edge identity differs');
              requireThat(now()<deadline,'runtime edge preflight deadline exceeded');
              if(edge.mode==='off' && edge.workerVersionId===off.runtime.versionId) {
                observe({scope:'refresh_edge',actor,status:'known_off',workerVersionId:edge.workerVersionId});
                requireThat(now()+configurationLimits.intervalMs<deadline,'runtime configuration preflight exhausted');
                await sleep(configurationLimits.intervalMs);continue;
              }
              requireThat(edge.mode==='baseline'&&edge.workerVersionId===baselineVersion,'refresh retry baseline identity differs');
              recheckEdge=false;
            }
            let configuration;
            try { configuration = await readActor(actor, remaining()); }
            catch (error) {
              if (!starting(error)) throw error;
              observe({ scope: 'actor', actor, read: reads, status: 'starting', httpStatus: error.httpStatus, code: error.code });
              requireThat(reads < configurationLimits.reads && now() + configurationLimits.intervalMs < deadline, 'runtime configuration preflight exhausted');
              await sleep(configurationLimits.intervalMs); continue;
            }
            requireThat(now() < deadline, 'runtime actor preflight deadline exceeded');
            requireThat(configuration && typeof configuration === 'object' && !Array.isArray(configuration) &&
              Object.keys(configuration).sort().join(',') === 'actorId,configuredImage,imageBuildId,mode,sourceSha,target,workerVersionId,writerEpoch' &&
              configuration.target === actor && configuration.actorId === actorIds.get(actor) &&
              configuration.sourceSha === identity.sourceSha && configuration.configuredImage === off.image &&
              configuration.imageBuildId === identity.imageBuildId && configuration.writerEpoch === identity.writerEpoch,
              'runtime actor identity differs');
            if (configuration.mode === 'baseline' && configuration.workerVersionId === baselineVersion) {
              observe({ scope: 'actor', actor, read: reads, status: 'baseline_verified', workerVersionId: baselineVersion });
              break;
            }
            requireThat(configuration.mode === 'off' && configuration.workerVersionId === off.runtime.versionId,
              'unexpected runtime actor state');
            observe({ scope: 'actor', actor, read: reads, status: 'known_off', workerVersionId: configuration.workerVersionId });
            if (refresh && !refreshed.has(actor)) {
              requireThat(typeof checkPaused === 'function', 'refresh requires paused Web verification');
              await checkPaused();
              requireThat(now() < deadline, 'runtime actor refresh deadline exceeded');
              // Reserve once before dispatch, including lost replies. The Set
              // spans all actors and subsequent calls to this preflight.
              refreshed.add(actor);
              const refreshAttempt=(refreshAttempts.get(actor)??0)+1;
              requireThat(refreshAttempt<=3,'runtime actor refresh pre-dispatch retry bound exceeded');
              refreshAttempts.set(actor,refreshAttempt);
              observe({ scope:'refresh',actor,refreshAttempt,status:'attempted_unverified',offVersionId:off.runtime.versionId,baselineVersionId:baselineVersion });
              const body={...identity,offVersionId:off.runtime.versionId,baselineVersionId:baselineVersion,actorId:actorIds.get(actor)};
              let outcome, refreshTimer;
              const refreshTimeout=Math.min(10000,deadline-now());
              try { outcome=await Promise.race([refresh(actor,body,refreshTimeout),new Promise((_,reject)=>{
                refreshTimer=setTimeout(()=>reject(new Error('refresh response uncertain')),refreshTimeout);
              })]); }
              catch { outcome={status:'uncertain',httpStatus:null}; }
              finally { clearTimeout(refreshTimer); }
              requireThat(outcome && ['uncertain','rejected','pre_dispatch_rejection','already_current_unverified'].includes(outcome.status) &&
                (outcome.httpStatus===null || (Number.isInteger(outcome.httpStatus)&&outcome.httpStatus>=100&&outcome.httpStatus<=599)),
              'invalid refresh outcome');
              requireThat(outcome.status!=='pre_dispatch_rejection'||(outcome.httpStatus===409&&outcome.code==='refresh_edge_not_ready'),'invalid pre-dispatch refresh outcome');
              requireThat(outcome.status!=='already_current_unverified'||(outcome.httpStatus===409&&outcome.code==='refresh_actor_already_current'),'invalid current refresh outcome');
              observe({ scope:'refresh',actor,refreshAttempt,status:outcome.status,httpStatus:outcome.httpStatus,
                ...(['refresh_edge_not_ready','refresh_actor_already_current','invalid_refresh','invalid_refresh_shape','invalid_refresh_identity','invalid_refresh_edge_version','invalid_refresh_actor_version','invalid_refresh_actor_scope'].includes(outcome.code)?{code:outcome.code}:{}) });
              requireThat(outcome.status!=='rejected','runtime actor refresh explicitly rejected');
              if(outcome.status==='pre_dispatch_rejection') {
                requireThat(refreshAttempt<3,'runtime actor refresh pre-dispatch retry bound exceeded');
                refreshed.delete(actor);recheckEdge=true;
              }
              requireThat(now() < deadline, 'runtime actor refresh deadline exceeded');
            }
            requireThat(reads < configurationLimits.reads && now() + configurationLimits.intervalMs < deadline, 'runtime configuration preflight exhausted');
            await sleep(configurationLimits.intervalMs);
          }
        }
        actorsVerified = true;
        return;
      }
      requireThat(value.mode === 'off' && value.workerVersionId === off.runtime.versionId, 'unexpected runtime edge state');
      observe({ attempt, status: 'known_off', workerVersionId: value.workerVersionId });
      if (attempts < configurationLimits.edgeAttempts && now() + configurationLimits.intervalMs < deadline) await sleep(configurationLimits.intervalMs);
      else break;
    }
    throw new Error('runtime edge preflight exhausted');
    } finally {
      // Lifecycle and paused-Web checks between invocations do not spend the
      // propagation allowance; reads and sleeps never replenish it.
      remainingMs -= Math.max(0, now() - startedAt);
    }
  };
}
export async function transitionActors(identity, { paused, send, preflight, record = () => {} }) {
  requireThat(/^[a-f0-9]{40}$/.test(identity.sourceSha ?? '') && /^[a-f0-9]{64}$/.test(identity.imageBuildId ?? '') && identity.mode === 'baseline' && identity.writerEpoch === 1, 'invalid transition identity');
  const results = [], evidence = { format: 'ghfind-feed-mode-transition-v1', ...identity, status: 'attempted_unverified', targets: results };
  let anchor;
  const checkPaused = async () => {
    const current = await paused();
    requireThat(current?.status === 'passed' && current.mode === 'paused' && current.sourceSha === identity.sourceSha && current.backend === 'go' && current.store === 'cf_d1_r2' && /^[a-f0-9-]{36}$/.test(current.workerVersionId ?? ''), 'current compatible Web must be paused');
    requireThat(!anchor || anchor === current.workerVersionId, 'paused Web anchor changed');
    anchor = current.workerVersionId; evidence.pausedVersion = anchor;
  };
  record(evidence);
  try {
    for (const target of targets) {
      await checkPaused();
      if (preflight) await preflight(observation => {
        evidence.edgePreflight ??= [];
        evidence.edgePreflight.push({ target, ...observation });
        record(evidence);
      }, target, checkPaused);
      // Persist attempted state before sending; no blind retry on a lost reply.
      const item = { target, status: 'attempted_unverified' }; results.push(item); record(evidence);
      let result;
      for (let rejected = 0; rejected < 3; rejected++) {
        result = await send(target, identity);
        if (result?.rejectedWithoutMutation !== true) break;
        requireThat(preflight && Object.keys(result).length === 1, 'invalid pre-dispatch rejection');
        item.rejectedWithoutMutation = rejected + 1; record(evidence);
        requireThat(rejected < 2, 'pre-dispatch rejection bound exceeded');
        await checkPaused();
        await preflight(observation => {
          evidence.edgePreflight ??= [];
          evidence.edgePreflight.push({ target, ...observation }); record(evidence);
        }, target, checkPaused);
      }
      requireThat(result && Object.keys(result).sort().join(',') === ['restarted','target','sourceSha','imageBuildId','mode','writerEpoch'].sort().join(',') && result.restarted === true && result.target === target && Object.entries(identity).every(([key,value])=>result[key]===value), 'transition reply identity differs');
      item.status = 'passed'; record(evidence);
    }
    await checkPaused();
    evidence.status = 'passed'; record(evidence); return evidence;
  } catch (error) {
    evidence.status = 'failed'; record(evidence); throw error;
  }
}
async function main() {
  authorizeMutation();
  const [manifestPath, offPath, output] = process.argv.slice(2);
  requireThat(process.argv.length === 5 && output && resolve(output) === output, 'usage: feed-production-transition.mjs MANIFEST OFF_RECEIPT ABSOLUTE_OUTPUT');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')), off = JSON.parse(readFileSync(offPath, 'utf8'));
  validateManifest(manifest);
  const sha = process.env.RELEASE_SHA;
  validateReceipt(off, manifest, sha, off.image, 'off');
  requireThat(typeof process.env.FEED_RUNTIME_ADMIN_SECRET === 'string' && process.env.FEED_RUNTIME_ADMIN_SECRET.length >= 32, 'runtime admin credential absent');
  const identity = { sourceSha: sha, imageBuildId: process.env.FEED_IMAGE_BUILD_ID, mode: 'baseline', writerEpoch: manifest.writerEpoch };
  const readConfiguration = async (path, remaining) => {
    const response = await fetch(`${production.runtimeOrigin}/internal/runtime/${path}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(Math.min(10000, remaining)),
      headers: { authorization: `Bearer ${process.env.FEED_RUNTIME_ADMIN_SECRET}`, accept: 'application/json' },
    });
    // Missing RPC methods and invalid configuration are not proof of known off
    // identity. Allowlisted starting/unavailable 503s wait inside the shared
    // budget; none of these outcomes authorize a lifecycle POST.
    return readConfigurationResponse(response);
  };
  let first = true;
  await transitionActors(identity, {
    preflight: edgePreflight(identity, off, {
      read: remaining => readConfiguration('configuration', remaining),
      readActor: (target, remaining) => readConfiguration(`${target}/configuration`, remaining),
      refresh: async (target, body, remaining) => {
        const response=await fetch(`${production.runtimeOrigin}/internal/runtime/${target}/refresh`,{
          method:'POST',redirect:'error',signal:AbortSignal.timeout(remaining),
          headers:{authorization:`Bearer ${process.env.FEED_RUNTIME_ADMIN_SECRET}`,'content-type':'application/json'},
          body:JSON.stringify(body),
        });
        const outcome=await readRefreshResponse(response,body.offVersionId,body.baselineVersionId);
        await response.body?.cancel().catch(()=>{});
        return outcome;
      },
    }),
    paused: () => verifyWeb(sha, 'paused', process.env),
    record: evidence => { writeFileSync(output, JSON.stringify(evidence,null,2)+'\n', { mode: 0o600, flag: first ? 'wx' : 'w' }); first = false; },
    send: async (target, body) => {
      const response = await fetch(`${production.runtimeOrigin}/internal/runtime/${target}/restart`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(35000), headers: { authorization: `Bearer ${process.env.FEED_RUNTIME_ADMIN_SECRET}`, 'content-type':'application/json' }, body: JSON.stringify(body) });
      return readTransitionResponse(response, target, off.runtime.versionId);
    },
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(error=>{console.error(error.message);process.exitCode=1;});
