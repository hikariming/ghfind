#!/usr/bin/env node
// A known Go-only paused Web is a containment target, not restored service.
// Default is read/plan. Only the pinned main Actions workflow may --apply.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedJSON } from './feed-platform-web-verify.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const accountId = '8f19bebe359e4ec1a24c68c5f49c1584';
export const worker = 'ghfind';
export const workflow = 'hikariming/ghfind/.github/workflows/feed-production-pause.yml@refs/heads/main';
export const runtimeWorker = 'ghfind-feed-runtime-production';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{40}$/;
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const writeJSON = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });

export function validateInput(sourceSha, pausedWebVersion) {
  requireThat(sha.test(sourceSha ?? ''), 'exact lowercase 40-character source SHA required');
  requireThat(uuid.test(pausedWebVersion ?? ''), 'explicit immutable paused Web version UUID required');
  return { sourceSha, pausedWebVersion };
}
export function authorizeApply(env = process.env) {
  requireThat(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    env.GITHUB_REPOSITORY === 'hikariming/ghfind' && env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_WORKFLOW_REF === workflow && sha.test(env.GITHUB_SHA ?? '') &&
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? ''),
  'mutation requires the pinned manual production pause workflow on main');
}
export function expectedBindings(sourceSha) {
  return [
    ...Object.entries({ GHFIND_DEPLOY_ENV: 'production', FEED_RELEASE_SHA: sourceSha,
      FEED_BACKEND: 'go', FEED_ROLLOUT_MODE: 'paused', FEED_ROLLOUT_BASIS_POINTS: '0',
      FEED_SOURCE_OUTBOX_ENABLED: 'true', FEED_STORE_PROFILE: 'cf_d1_r2',
      FEED_API_ORIGIN: 'https://ghfind-feed-runtime-production.beiming1201.workers.dev',
    }).map(([name, text]) => ({ name, type: 'plain_text', text })),
    { name: 'GHFIND_D1', type: 'd1', id: '60d45096-bfe7-4de1-8b85-c1b66a466b0d' },
    { name: 'GHFIND_FEED_D1', type: 'd1', id: '9c4ac13a-4c90-40a8-9d56-d7141f864bbf' },
    { name: 'FEED_RUNTIME', type: 'service', service: runtimeWorker },
  ];
}
export function validateCandidate(sourceSha, pausedWebVersion, version, exposure) {
  validateInput(sourceSha, pausedWebVersion);
  requireThat(version?.id === pausedWebVersion && version.annotations?.['workers/tag'] === `production-${sourceSha}`,
    'candidate immutable version/source tag differs');
  const bindings = version.resources?.bindings;
  requireThat(Array.isArray(bindings) && new Set(bindings.map(b => b.name)).size === bindings.length,
    'candidate binding inventory is missing or ambiguous');
  for (const wanted of expectedBindings(sourceSha)) {
    const actual = bindings.find(b => b.name === wanted.name);
    requireThat(actual && Object.entries(wanted).every(([key, value]) => actual[key] === value), `candidate binding differs: ${wanted.name}`);
    if (wanted.type === 'service') requireThat(actual.entrypoint === undefined &&
      (actual.environment === undefined || actual.environment === 'production'), 'candidate service targets a different entrypoint/environment');
  }
  requireThat(typeof version.resources?.script?.etag === 'string' && version.resources.script.etag.length > 0 &&
    version.resources.script.etag.length <= 256, 'candidate script identity is absent');
  requireThat(exposure?.enabled === true && exposure.previews_enabled === false,
    'production Web workers.dev/preview exposure differs');
  // Never serialize the raw binding inventory: existing OAuth/provider values
  // are irrelevant to this receipt and must not leave the CF metadata response.
  return { worker, versionId: pausedWebVersion, sourceSha, tag: `production-${sourceSha}`,
    bindingIdentitySHA256: createHash('sha256').update(JSON.stringify(expectedBindings(sourceSha))).digest('hex'),
    scriptEtag: version.resources.script.etag, backend: 'go', mode: 'paused', basisPoints: 0,
    sourceOutboxEnabled: true, previewsEnabled: false };
}
export function validateActive(deployments, pausedWebVersion) {
  const active = deployments?.deployments?.[0];
  requireThat(uuid.test(active?.id ?? '') && active.versions?.length === 1 &&
    active.versions[0].percentage === 100 && active.versions[0].version_id === pausedWebVersion,
  'actual Web deployment is not 100% on the explicitly selected paused version');
  return { deploymentId: active.id, versionId: pausedWebVersion, percentage: 100 };
}
export function platformReader(token, fetcher = fetch) {
  requireThat(typeof token === 'string' && token.length >= 32 && !/[\x00-\x20\x7f]/.test(token), 'Cloudflare API credential required');
  return async path => {
    requireThat(/^\/workers\/scripts\/ghfind\/(?:deployments|subdomain|versions\/[a-f0-9-]{36})$/.test(path), 'unexpected production metadata route');
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}` },
    });
    requireThat(response.ok, `Cloudflare metadata read failed (${response.status})`);
    const data = await boundedJSON(response);
    requireThat(data.success === true, 'Cloudflare metadata read was not successful');
    return data.result;
  };
}
export function minimalEnvironment(env, names) {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', ...names].filter(name => typeof env[name] === 'string').map(name => [name, env[name]]));
}
export async function proveSource(sourceSha, directory, env = process.env) {
  const checkoutSha = git('rev-parse', 'HEAD');
  if (env.GITHUB_ACTIONS === 'true') requireThat(checkoutSha === env.GITHUB_SHA, 'controller checkout differs from the main workflow SHA');
  const mainSha = env.GITHUB_ACTIONS === 'true' ? checkoutSha : git('rev-parse', 'refs/remotes/origin/main');
  try { git('merge-base', '--is-ancestor', sourceSha, mainSha); }
  catch { throw new Error('pause source is not an existing commit in verified main history'); }
  const checkout = resolve(directory, 'source-checkout'), ciPath = resolve(directory, 'ci.json');
  let added = false;
  try {
    git('worktree', 'add', '--detach', checkout, sourceSha); added = true;
    // The controller's verifier is trusted main code. Its git reads run against
    // the exact target tree; no executable from the historical target is used.
    try {
      execFileSync(process.execPath, [resolve(root, 'scripts/feed-ci-evidence.mjs'), 'verify-ci-remote', sourceSha, ciPath], {
        cwd: checkout, env: minimalEnvironment(env, ['GH_TOKEN']), stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000, maxBuffer: 256 * 1024,
      });
    } catch { throw new Error('exact source CI/E2E verification failed; current-branch and receipt-age gates remain enforced'); }
    const evidence = JSON.parse(readFileSync(ciPath, 'utf8'));
    requireThat(evidence.eligible === true && evidence.context?.checkoutSha === sourceSha && evidence.context?.sourceSha === sourceSha,
      'verified CI source receipt differs');
    return { mainSha, sourceSha, ciRunId: evidence.context.runId, ciRunAttempt: evidence.context.runAttempt, ciVerified: true };
  } finally {
    if (added) git('worktree', 'remove', '--force', checkout);
  }
}
export async function rollback(pausedWebVersion, directory, env = process.env) {
  authorizeApply(env);
  requireThat(uuid.test(pausedWebVersion ?? ''), 'explicit immutable paused Web version UUID required');
  const config = resolve(directory, 'wrangler.pause.json');
  writeJSON(config, { name: worker, account_id: accountId, compatibility_date: '2026-08-06' });
  try {
    execFileSync(resolve(root, 'platform/runtime/node_modules/.bin/wrangler'), ['rollback', pausedWebVersion, '--name', worker,
      '--config', config, '--message', 'Explicit Go-only pause; preserve Feed writer data; service is not restored', '--yes'], {
      cwd: root, env: { ...minimalEnvironment(env, ['CLOUDFLARE_API_TOKEN']), CLOUDFLARE_ACCOUNT_ID: accountId, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 256 * 1024,
    });
  } catch { throw new Error('Cloudflare Web rollback failed; no alternate version will be selected'); }
  finally { rmSync(config, { force: true }); }
}
export async function runPause({ sourceSha, pausedWebVersion, directory, apply = false }, {
  env = process.env, api, prove = proveSource, mutate = rollback, now = () => new Date().toISOString(),
} = {}) {
  validateInput(sourceSha, pausedWebVersion);
  if (apply) authorizeApply(env);
  const destination = resolve(directory ?? '');
  requireThat(directory && destination === directory && destination !== root && !destination.startsWith(root + '/') && !existsSync(destination),
    'fresh absolute evidence directory outside checkout required');
  const get = api ?? platformReader(env.CLOUDFLARE_API_TOKEN);
  mkdirSync(destination, { mode: 0o700 });
  const receipt = { format: 'ghfind-feed-production-pause-v1', accountId, worker, sourceSha, pausedWebVersion,
    requestedAction: apply ? 'pause' : 'plan', status: 'failed', serviceRestored: false, rollbackAttempted: false,
    runId: env.GITHUB_RUN_ID ?? null, runAttempt: env.GITHUB_RUN_ATTEMPT ?? null };
  let phase = 'source';
  try {
    receipt.source = await prove(sourceSha, destination, env);
    phase = 'candidate';
    receipt.candidate = validateCandidate(sourceSha, pausedWebVersion,
      await get(`/workers/scripts/${worker}/versions/${pausedWebVersion}`), await get(`/workers/scripts/${worker}/subdomain`));
    if (apply) {
      phase = 'rollback'; receipt.rollbackAttempted = true;
      await mutate(pausedWebVersion, destination, env);
      phase = 'readback';
      const before = validateActive(await get(`/workers/scripts/${worker}/deployments`), pausedWebVersion);
      receipt.actual = validateCandidate(sourceSha, pausedWebVersion,
        await get(`/workers/scripts/${worker}/versions/${pausedWebVersion}`), await get(`/workers/scripts/${worker}/subdomain`));
      const after = validateActive(await get(`/workers/scripts/${worker}/deployments`), pausedWebVersion);
      requireThat(after.deploymentId === before.deploymentId, 'Web deployment changed during pause readback');
      receipt.active = after; receipt.status = 'paused';
    } else receipt.status = 'planned';
    receipt.observedAt = now();
    return receipt;
  } catch (error) {
    // Error strings are fixed locally; API response bodies/bindings are omitted.
    receipt.failure = { phase, message: error.message };
    throw error;
  } finally { receipt.observedAt = now(); writeJSON(resolve(destination, 'pause.json'), receipt); }
}
export function parseArguments(args) {
  const value = { apply: false };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--apply' && !value.apply) value.apply = true;
    else {
      const key = { '--source-sha': 'sourceSha', '--paused-web-version': 'pausedWebVersion', '--directory': 'directory' }[name];
      requireThat(key && !Object.hasOwn(value, key) && typeof args[index + 1] === 'string' && !args[index + 1].startsWith('--'), 'invalid or duplicate pause argument');
      value[key] = args[++index];
    }
  }
  validateInput(value.sourceSha, value.pausedWebVersion);
  requireThat(value.directory, 'explicit fresh evidence directory required');
  return value;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  Promise.resolve().then(() => runPause(parseArguments(process.argv.slice(2)))).then(result => console.log(`Production ${result.status}; Feed remains paused, service restoration is not claimed.`)).catch(error => { console.error(error.message); process.exitCode = 1; });
