import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authorizeMutation, renderWeb, prepareSecrets, safeBuildEnv, verifyWeb } from './feed-production-release.mjs';
import { approvedSchemas } from './feed-platform-schema-release.mjs';
const sha='a'.repeat(40);
const provider={MOSOO_API_BASE:'https://cloud.mosoo.ai/api/v1',MOSOO_PROJECT_AGENT_ID:'01M22PWZR0A7ZYCDKWTEA0YEHQ',MOSOO_PROJECT_USER_ID:'ghfind-feed-staging'};
test('production mutations reject local, fork, branch and alternate workflow execution',()=>{
 const good={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'hikariming/ghfind',GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_REF:'hikariming/ghfind/.github/workflows/deploy-cf-production.yml@refs/heads/main'};
 authorizeMutation(good);
 for(const changed of [{GITHUB_ACTIONS:'false'},{GITHUB_REPOSITORY:'fork/ghfind'},{GITHUB_REF:'refs/heads/codex/feed-release'},{GITHUB_WORKFLOW_REF:'hikariming/ghfind/.github/workflows/ci.yml@refs/heads/main'}])assert.throws(()=>authorizeMutation({...good,...changed}));
});
test('paused and all configurations share only the production D1 writer and private service binding',()=>{
 for(const mode of ['paused','all']) {
  const c=renderWeb(sha,mode,provider);
  assert.equal(c.vars.FEED_BACKEND,'go');assert.equal(c.vars.FEED_SOURCE_OUTBOX_ENABLED,'true');
  assert.equal(c.vars.FEED_ROLLOUT_BASIS_POINTS,mode==='all'?'10000':'0');
  assert.equal(c.services[0].service,'ghfind-feed-runtime-production');
  assert.equal(c.d1_databases[1].database_id,'9c4ac13a-4c90-40a8-9d56-d7141f864bbf');
  assert.equal(c.preview_urls,false);
 }
 for(const mode of ['legacy','internal','1%'])assert.throws(()=>renderWeb(sha,mode,provider));
 assert.throws(()=>renderWeb('main','all',provider));
 assert.throws(()=>renderWeb(sha,'all',{...provider,MOSOO_API_BASE:'https://attacker.invalid'}));
});
test('runtime credentials are distinct and never enter the Web build environment',()=>{
 const names=['FEED_GATEWAY_SECRET','FEED_SIGNING_SECRET','FEED_BRIDGE_SECRET','FEED_RUNTIME_ADMIN_SECRET','FEED_EXECUTOR_SECRET','FEED_SOURCE_SECRET','FEED_DELIVERY_SECRET','FEED_OPERATOR_SECRET','MOSOO_API_TOKEN'];
 const env=Object.fromEntries(names.map((n,i)=>[n,`${i}`.repeat(48)]));
 assert.equal(Object.keys(prepareSecrets(env).web).length,2);
 assert.throws(()=>prepareSecrets({...env,FEED_BRIDGE_SECRET:env.FEED_GATEWAY_SECRET}));
 assert.throws(()=>prepareSecrets({...env,MOSOO_API_TOKEN:''}));
 const build=safeBuildEnv({...env,PATH:'/bin',NODE_OPTIONS:'--require malicious.cjs',NEXT_PUBLIC_API_SECRET:'do-not-leak',CLOUDFLARE_API_TOKEN:'do-not-leak'});
 assert.deepEqual(Object.keys(build).filter(k=>/SECRET|TOKEN|NODE_OPTIONS/.test(k)),[]);
 assert.equal(build.NEXT_PUBLIC_SITE_URL,'https://ghfind.com');
});
test('readback must observe the actual source, all vars, production bindings and secrets',async()=>{
 const c=renderWeb(sha,'all',provider);
 const bindings=[...Object.entries(c.vars).map(([name,text])=>({name,type:'plain_text',text})),...c.d1_databases.map(b=>({name:b.binding,type:'d1',id:b.database_id})),{name:'FEED_RUNTIME',type:'service',service:c.services[0].service},...c.secrets.required.map(name=>({name,type:'secret_text'}))];
 const version={annotations:{'workers/tag':`production-${sha}`},resources:{bindings}};
 const api=async path=>path.endsWith('/deployments')?{deployments:[{versions:[{percentage:100,version_id:'11111111-1111-4111-8111-111111111111'}]}]}:version;
 assert.equal((await verifyWeb(sha,'all',provider,api)).mode,'all');
 await assert.rejects(verifyWeb(sha,'paused',provider,api));
 version.resources.bindings=bindings.filter(b=>b.name!=='FEED_RUNTIME');await assert.rejects(verifyWeb(sha,'all',provider,api));
 version.resources.bindings=bindings;version.annotations['workers/tag']='production-'+ 'b'.repeat(40);await assert.rejects(verifyWeb(sha,'all',provider,api));
});
test('production Feed schema approval covers the complete fixed migrations without widening dev application releases',async()=>{
 const m=JSON.parse(readFileSync(new URL('../ops/feed-production-schema-release.json',import.meta.url)));
 const r=await approvedSchemas(m);assert.equal(r.core.length,7);assert.equal(r.feed.length,12);
 const legacy=JSON.parse(readFileSync(new URL('../ops/feed-application-schema-release.json',import.meta.url)));
 assert.equal(legacy.feed.length,2);
 assert.ok(!legacy.core.some(e=>e.name==='0005_feed_source_outbox.sql'));
});
