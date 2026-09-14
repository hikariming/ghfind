#!/usr/bin/env node
// Serialized Actions-only production operations. The local CLI defaults to no
// mutation; --apply is accepted only by the pinned main release workflow.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { production, validateManifest, secretNames, adapterSecretNames, repository } from './feed-platform-production.mjs';
import { approvedSchemas } from './feed-platform-schema-release.mjs';
import { assertNoLocalEnvironmentFiles } from './feed-platform-web.mjs';
export const ACCOUNT = '8f19bebe359e4ec1a24c68c5f49c1584';
export const webConfig = resolve(repository, 'platform/runtime/wrangler.web.production.generated.json');
export const requireThat = (ok, text) => { if (!ok) throw new Error(text); };
export function authorizeMutation(env = process.env) {
  requireThat(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'hikariming/ghfind' &&
    env.GITHUB_REF === 'refs/heads/main' && /^hikariming\/ghfind\/.github\/workflows\/deploy-cf-production.yml@refs\/heads\/main$/.test(env.GITHUB_WORKFLOW_REF ?? ''), 'only the production Actions workflow on main may mutate');
}
export function renderWeb(sha, mode, provider) {
  requireThat(/^[a-f0-9]{40}$/.test(sha) && ['paused', 'all'].includes(mode), 'exact source SHA and paused/all required');
  requireThat(provider.MOSOO_API_BASE === 'https://cloud.mosoo.ai/api/v1' && /^[A-Z0-9]{26}$/.test(provider.MOSOO_PROJECT_AGENT_ID ?? '') && /^[A-Za-z0-9._:-]{1,128}$/.test(provider.MOSOO_PROJECT_USER_ID ?? ''), 'explicit published Mosoo provider required');
  return {
    name: 'ghfind', account_id: ACCOUNT, main: '../../.open-next/worker.js', compatibility_date: '2026-08-06', compatibility_flags: ['nodejs_compat'],
    workers_dev: true, preview_urls: false, routes: [{ pattern: 'ghfind.com', custom_domain: true }],
    assets: { directory: '../../.open-next/assets', binding: 'ASSETS' }, observability: { enabled: true },
    d1_databases: [['GHFIND_D1',production.coreDatabase,'../../migrations'],['GHFIND_FEED_D1',production.feedDatabase,'../../migrations-feed']].map(([binding,d,migrations_dir])=>({binding,database_name:d.name,database_id:d.id,migrations_dir})),
    r2_buckets: [{ binding: 'NEXT_INC_CACHE_R2_BUCKET', bucket_name: 'ghfind-next-cache' }],
    services: [{ binding: 'FEED_RUNTIME', service: production.runtimeWorker }],
    secrets: { required: ['FEED_GATEWAY_SECRET', 'MOSOO_API_TOKEN', 'PROJECT_ANALYSIS_RECONCILE_SECRET'] },
    vars: { GHFIND_DEPLOY_ENV: 'production', PUBLIC_SITE_URL: 'https://ghfind.com', NEXT_PUBLIC_SITE_URL: 'https://ghfind.com',
      FEED_BACKEND: 'go', FEED_API_ORIGIN: production.runtimeOrigin, FEED_STORE_PROFILE: 'cf_d1_r2', FEED_RELEASE_SHA: sha,
      FEED_SOURCE_OUTBOX_ENABLED: 'true', FEED_ROLLOUT_MODE: mode, FEED_ROLLOUT_GITHUB_IDS: '109743670',
      FEED_ROLLOUT_SEED: 'ghfind-go-production-v1-20260909', FEED_ROLLOUT_BASIS_POINTS: mode === 'all' ? '10000' : '0',
      MOSOO_API_BASE: provider.MOSOO_API_BASE, MOSOO_PROJECT_AGENT_ID: provider.MOSOO_PROJECT_AGENT_ID, MOSOO_PROJECT_USER_ID: provider.MOSOO_PROJECT_USER_ID,
      MOSOO_PROJECT_REQUEST_TIMEOUT_MS: '15000' },
  };
}
export function prepareSecrets(env) {
  const names = [...new Set([...secretNames,...adapterSecretNames])];
  const values = names.map(n => env[n]);
  requireThat(values.every(v=>typeof v==='string' && v.length>=32 && v.length<=512 && !/[\r\n]/.test(v)) && new Set(values).size===values.length, 'distinct production role credentials required');
  requireThat(typeof env.MOSOO_API_TOKEN==='string' && env.MOSOO_API_TOKEN.length>=32 && !values.includes(env.MOSOO_API_TOKEN), 'published provider token required');
  requireThat(typeof env.PROJECT_ANALYSIS_RECONCILE_SECRET==='string' && env.PROJECT_ANALYSIS_RECONCILE_SECRET.length>=32 && env.PROJECT_ANALYSIS_RECONCILE_SECRET.length<=512 && !/[\r\n]/.test(env.PROJECT_ANALYSIS_RECONCILE_SECRET) && ![...values,env.MOSOO_API_TOKEN].includes(env.PROJECT_ANALYSIS_RECONCILE_SECRET), 'distinct reconciliation credential required');
  return { runtime: Object.fromEntries(secretNames.map(n=>[n,env[n]])), adapter: Object.fromEntries(adapterSecretNames.map(n=>[n,env[n]])), web: { FEED_GATEWAY_SECRET: env.FEED_GATEWAY_SECRET, MOSOO_API_TOKEN: env.MOSOO_API_TOKEN, PROJECT_ANALYSIS_RECONCILE_SECRET: env.PROJECT_ANALYSIS_RECONCILE_SECRET } };
}
export function safeBuildEnv(env = process.env) {
  return {...Object.fromEntries(['PATH','HOME','TMPDIR','TMP','TEMP','PNPM_HOME'].filter(k=>typeof env[k]==='string').map(k=>[k,env[k]])), NODE_ENV:'production', CI:'true', NEXT_TELEMETRY_DISABLED:'1', WRANGLER_SEND_METRICS:'false', NEXT_PUBLIC_GHFIND_DEPLOY_PLATFORM:'cloudflare', NEXT_PUBLIC_SITE_URL:'https://ghfind.com', PUBLIC_SITE_URL:'https://ghfind.com', GHFIND_DEPLOY_ENV:'production'};
}
export async function cf(path, body, method) {
  requireThat((process.env.CLOUDFLARE_API_TOKEN??'').length>=32,'production CF credential missing');
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {method:method??(body?'POST':'GET'),headers:{authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)});
  const data=await response.json();
  if(!response.ok || data.success!==true) throw Object.assign(new Error(`Cloudflare request failed (${response.status}; ${(data.errors??[]).map(e=>e.code).join(',')})`),{status:response.status});
  return data.result;
}
function queueIdentity(q, name, id) {
  requireThat(q && q.queue_name===name && typeof q.queue_id==='string' && /^[a-f0-9]{32}$/.test(q.queue_id) && (id===undefined || q.queue_id===id),'queue identity mismatch');
}
function queueSettings(q, target, requireExplicit=false) {
  queueIdentity(q,target.name,target.id);
  const s=q.settings;
  requireThat(s && typeof s==='object' && !Array.isArray(s) && s.message_retention_period===target.retention && s.delivery_delay===0,'queue retention/delivery settings differ');
  const explicit=Object.hasOwn(s,'delivery_paused');
  // Missing is an initialization candidate, never evidence that delivery is on.
  // Do not undo an operator pause or coerce malformed API values to false.
  requireThat(explicit ? s.delivery_paused===false : !requireExplicit,'queue delivery pause must be explicitly false');
  return explicit;
}
export async function ensureResources(m, api=cf) {
  validateManifest(m); authorizeMutation();
  const resources=[];
  const ds=await api('/workers/scripts/ghfind/deployments');
  const active=ds.deployments?.[0]?.versions;
  requireThat(active?.length===1 && active[0].percentage===100,'single production Web required before provision');
  const web=await api(`/workers/scripts/ghfind/versions/${active[0].version_id}`);
  const backend=(web.resources?.bindings??[]).find(b=>b.name==='FEED_BACKEND')?.text??'legacy';
  requireThat(['legacy','go'].includes(backend),'unknown active Feed backend');
  for(const d of [m.coreDatabase,m.feedDatabase]) { const v=await api(`/d1/database/${d.id}`);requireThat(v.uuid===d.id && v.name===d.name,'production database mismatch');resources.push({kind:'d1',...d}); }
  let bucket;
  try { bucket=await api(`/r2/buckets/${m.archiveBucket}`); } catch(e) { if(e.status!==404)throw e; bucket=await api('/r2/buckets',{name:m.archiveBucket}); }
  requireThat(bucket.name===m.archiveBucket,'archive identity mismatch');resources.push({kind:'r2',name:bucket.name});
  const queues=[];
  for(let page=1;page<=20;page++) { const rows=await api(`/queues?per_page=100&page=${page}`);requireThat(Array.isArray(rows),'invalid queue list');queues.push(...rows);if(rows.length<100)break;requireThat(page<20,'queue inventory exceeds bound'); }
  const targets=[];
  for(const name of [m.queue,m.deadLetterQueue,m.terminalParkingQueue]) {
    const found=queues.filter(q=>q?.queue_name===name);requireThat(found.length<=1,'ambiguous queue identity');
    if(found[0])queueIdentity(found[0],name);
    targets.push({name,id:found[0]?.queue_id,retention:name===m.terminalParkingQueue?1209600:345600});
  }
  const existingIds=targets.filter(t=>t.id!==undefined).map(t=>t.id);
  requireThat(new Set(existingIds).size===existingIds.length,'ambiguous queue identity');
  // Preflight every existing target before any queue POST/PUT. In particular, a
  // paused or changed third queue must not partially initialize the first two.
  for(const target of targets) {
    if(target.id!==undefined)target.explicit=queueSettings(await api(`/queues/${target.id}`),target);
  }
  for(const target of targets) {
    const settings={message_retention_period:target.retention,delivery_delay:0,delivery_paused:false};
    if(target.id===undefined) {
      const created=await api('/queues',{queue_name:target.name,settings});
      queueIdentity(created,target.name);
      requireThat(!existingIds.includes(created.queue_id),'ambiguous queue identity');
      target.id=created.queue_id;existingIds.push(target.id);
      queueSettings(await api(`/queues/${target.id}`),target,true);
    } else if(!target.explicit) {
      // Re-read immediately before a full configuration PUT. Abort if a pause,
      // retention/delay edit or identity change appeared after the preflight.
      // https://developers.cloudflare.com/api/resources/queues/methods/update/
      if(!queueSettings(await api(`/queues/${target.id}`),target)) {
        const updated=await api(`/queues/${target.id}`,{queue_name:target.name,settings},'PUT');
        queueIdentity(updated,target.name,target.id);
        queueSettings(await api(`/queues/${target.id}`),target,true);
      }
    }
    resources.push({kind:'queue',name:target.name,id:target.id});
  }
  return {status:'verified',accountId:ACCOUNT,observedAt:new Date().toISOString(),existingBackend:backend,previousWebVersion:active[0].version_id,resources};
}
export async function renderSchemas(out) {
  const manifest=JSON.parse(readFileSync(resolve(repository,'ops/feed-production-schema-release.json')));
  const checked=await approvedSchemas(manifest);mkdirSync(out);
  for(const k of ['core','feed']) {mkdirSync(resolve(out,k));for(const e of checked[k])writeFileSync(resolve(out,k,e.name),e.sql,{flag:'wx'});}
  const c={name:'ghfind',account_id:ACCOUNT,compatibility_date:'2026-09-08',d1_databases:[['GHFIND_D1',production.coreDatabase,'core'],['GHFIND_FEED_D1',production.feedDatabase,'feed']].map(([binding,d,k])=>({binding,database_name:d.name,database_id:d.id,migrations_dir:resolve(out,k)}))};
  writeFileSync(resolve(out,'wrangler.json'),JSON.stringify(c,null,2),{flag:'wx'});return resolve(out,'wrangler.json');
}
function activeWebDeployment(data) {
  const deployment = data?.deployments?.[0];
  const versions = deployment?.versions;
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  requireThat(Array.isArray(data?.deployments) && uuid.test(deployment?.id ?? '') &&
    Array.isArray(versions) && versions.length === 1 && versions[0]?.percentage === 100 &&
    uuid.test(versions[0]?.version_id ?? ''), 'single 100% immutable Web deployment required');
  return { deploymentId: deployment.id, versionId: versions[0].version_id };
}
export async function verifyWeb(sha, mode, provider, api=cf) {
  const expected=renderWeb(sha,mode,provider);
  const active=activeWebDeployment(await api('/workers/scripts/ghfind/deployments'));
  const v=await api(`/workers/scripts/ghfind/versions/${active.versionId}`);
  requireThat(v?.id === active.versionId, 'immutable Web version response mismatch');
  requireThat(v.annotations?.['workers/tag']===`production-${sha}`,'actual Web source tag mismatch');
  const bindings=v.resources?.bindings;
  requireThat(Array.isArray(bindings) && bindings.every(b => b && typeof b.name === 'string' &&
    b.name.length > 0 && typeof b.type === 'string') && new Set(bindings.map(b=>b.name)).size === bindings.length,
    'Web binding names must be unique');
  const byName=new Map(bindings.map(b=>[b.name,b]));
  const verified=[];
  for(const [name,text] of Object.entries(expected.vars)) {
    const binding=byName.get(name);
    requireThat(binding?.type==='plain_text' && binding.text===text,`Web variable mismatch: ${name}`);
    verified.push({name,type:'plain_text',text});
  }
  for(const d of expected.d1_databases) {
    const binding=byName.get(d.binding);
    requireThat(binding?.type==='d1' && binding.id===d.database_id,'Web D1 mismatch');
    verified.push({name:d.binding,type:'d1',id:d.database_id});
  }
  for(const bucket of expected.r2_buckets) {
    const binding=byName.get(bucket.binding);
    requireThat(binding?.type==='r2_bucket' && binding.bucket_name===bucket.bucket_name,'Web cache bucket mismatch');
    verified.push({name:bucket.binding,type:'r2_bucket',bucket_name:bucket.bucket_name});
  }
  const assets=byName.get(expected.assets.binding);
  requireThat(assets?.type==='assets','Web assets binding mismatch');
  verified.push({name:expected.assets.binding,type:'assets'});
  const runtime=byName.get('FEED_RUNTIME');
  // Actual production binding readbacks omit environment for the default service.
  // Explicit production is equivalent; a staging environment or custom entrypoint is not.
  requireThat(runtime?.type==='service' && runtime.service===production.runtimeWorker &&
    (runtime.environment===undefined || runtime.environment==='production') &&
    (runtime.entrypoint===undefined || runtime.entrypoint==='default'),'Web runtime binding mismatch');
  verified.push({name:'FEED_RUNTIME',type:'service',service:production.runtimeWorker,environment:runtime.environment??'production',entrypoint:runtime.entrypoint??'default'});
  // These OAuth secrets are preserved in Cloudflare, not copied into CI.
  // Inventory proves configuration presence; the holder browser proves login.
  for(const name of [...expected.secrets.required,'AUTH_GITHUB_ID','AUTH_GITHUB_SECRET','AUTH_SECRET']) {
    requireThat(byName.get(name)?.type==='secret_text',`Web credential absent: ${name}`);
    verified.push({name,type:'secret_text'});
  }
  const after=activeWebDeployment(await api('/workers/scripts/ghfind/deployments'));
  requireThat(after.deploymentId===active.deploymentId && after.versionId===active.versionId,'Web deployment changed during readback');
  return {format:'ghfind-feed-production-web-v1',status:'passed',sourceSha:sha,worker:'ghfind',
    deploymentId:active.deploymentId,workerVersionId:active.versionId,mode,backend:'go',store:'cf_d1_r2',
    bindingSHA256:createHash('sha256').update(JSON.stringify(verified)).digest('hex'),
    observedAt:new Date().toISOString(),runId:process.env.GITHUB_RUN_ID,
    notProven:['public domain routing and preview exposure','OAuth session and authenticated gateway journey']};
}

async function main() {
  const [cmd,...args]=process.argv.slice(2);
  if(cmd==='resources' && args.length===2) {const r=await ensureResources(JSON.parse(readFileSync(args[0])));writeFileSync(args[1],JSON.stringify(r,null,2),{flag:'wx'});}
  else if(cmd==='schema' && args.length===1)console.log(await renderSchemas(resolve(args[0])));
  else if(cmd==='prepare' && args.length===1) {const out=resolve(args[0]);requireThat(!out.startsWith(repository+'/'),'secrets must stay outside checkout');for(const [role,values]of Object.entries(prepareSecrets(process.env)))writeFileSync(resolve(out,`feed-${role}-secrets.json`),JSON.stringify(values),{mode:0o600,flag:'wx'});}
  else if(cmd==='web' && args.length===2)writeFileSync(webConfig,JSON.stringify(renderWeb(args[0],args[1],process.env),null,2));
  else if(cmd==='web-verify' && args.length===3)writeFileSync(args[2],JSON.stringify(await verifyWeb(args[0],args[1],process.env),null,2),{flag:'wx'});
  else if(cmd==='build' && args.length===0) {assertNoLocalEnvironmentFiles(repository);requireThat(!existsSync(resolve(repository,'.open-next')) && !existsSync(resolve(repository,'.next')),'fresh build outputs required');const r=spawnSync(process.execPath,[resolve(repository,'node_modules/@opennextjs/cloudflare/dist/cli/index.js'),'build','--config',webConfig],{cwd:repository,env:safeBuildEnv(),stdio:'inherit',timeout:780000});requireThat(r.status===0,'secret-free Web build failed');}
  else throw new Error('usage: feed-production-release.mjs resources MANIFEST RECEIPT | schema NEW_DIR | prepare PRIVATE_DIR | web SHA paused|all | web-verify SHA MODE RECEIPT | build');
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
