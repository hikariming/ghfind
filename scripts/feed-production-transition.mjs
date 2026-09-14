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
export async function transitionActors(identity, { paused, send, record = () => {} }) {
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
      // Persist attempted state before sending; no blind retry on a lost reply.
      const item = { target, status: 'attempted_unverified' }; results.push(item); record(evidence);
      const result = await send(target, identity);
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
  let first = true;
  await transitionActors(identity, {
    paused: () => verifyWeb(sha, 'paused', process.env),
    record: evidence => { writeFileSync(output, JSON.stringify(evidence,null,2)+'\n', { mode: 0o600, flag: first ? 'wx' : 'w' }); first = false; },
    send: async (target, body) => {
      const response = await fetch(`${production.runtimeOrigin}/internal/runtime/${target}/restart`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(35000), headers: { authorization: `Bearer ${process.env.FEED_RUNTIME_ADMIN_SECRET}`, 'content-type':'application/json' }, body: JSON.stringify(body) });
      requireThat(response.status === 200, `mode transition rejected (${response.status}; ${target})`);
      return boundedJSON(response, 2048);
    },
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(error=>{console.error(error.message);process.exitCode=1;});
