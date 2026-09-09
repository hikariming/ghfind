#!/usr/bin/env node
// Serialized Actions-only production operations. The local CLI defaults to no
// mutation; --apply is accepted only by the pinned main release workflow.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
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
    secrets: { required: ['FEED_GATEWAY_SECRET', 'MOSOO_API_TOKEN'] },
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
  return { runtime: Object.fromEntries(secretNames.map(n=>[n,env[n]])), adapter: Object.fromEntries(adapterSecretNames.map(n=>[n,env[n]])), web: { FEED_GATEWAY_SECRET: env.FEED_GATEWAY_SECRET, MOSOO_API_TOKEN: env.MOSOO_API_TOKEN } };
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
  for(const name of [m.queue,m.deadLetterQueue,m.terminalParkingQueue]) {
    const found=queues.filter(q=>q.queue_name===name);requireThat(found.length<=1,'ambiguous queue identity');
    const q=found[0]??await api('/queues',{queue_name:name,settings:{message_retention_period:name===m.terminalParkingQueue?1209600:345600,delivery_delay:0}});requireThat(q.queue_name===name && /^[a-f0-9]{32}$/.test(q.queue_id),'queue identity mismatch');resources.push({kind:'queue',name,id:q.queue_id});
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
export async function verifyWeb(sha, mode, provider, api=cf) {
  const expected=renderWeb(sha,mode,provider);
  const ds=await api('/workers/scripts/ghfind/deployments'),active=ds.deployments?.[0]?.versions;
  requireThat(active?.length===1 && active[0].percentage===100,'single 100% Web deployment required');
  const versionId=active[0].version_id,v=await api(`/workers/scripts/ghfind/versions/${versionId}`);
  requireThat(v.annotations?.['workers/tag']===`production-${sha}`,'actual Web source tag mismatch');
  const bindings=v.resources?.bindings??[];
  for(const [name,text] of Object.entries(expected.vars))requireThat(bindings.some(b=>b.name===name && b.type==='plain_text' && b.text===text),`Web variable mismatch: ${name}`);
  for(const d of expected.d1_databases)requireThat(bindings.some(b=>b.name===d.binding && b.type==='d1' && b.id===d.database_id),'Web D1 mismatch');
  requireThat(bindings.some(b=>b.name==='FEED_RUNTIME' && b.type==='service' && b.service===production.runtimeWorker),'Web runtime binding mismatch');
  for(const name of expected.secrets.required)requireThat(bindings.some(b=>b.name===name && b.type==='secret_text'),`Web credential absent: ${name}`);
  return {format:'ghfind-feed-production-web-v1',status:'passed',sourceSha:sha,worker:'ghfind',workerVersionId:versionId,mode,backend:'go',store:'cf_d1_r2',observedAt:new Date().toISOString(),runId:process.env.GITHUB_RUN_ID};
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
