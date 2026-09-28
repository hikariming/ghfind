import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authorizeMutation, renderWeb, prepareSecrets, safeBuildEnv, verifyWeb, ensureResources } from './feed-production-release.mjs';
import { approvedSchemas } from './feed-platform-schema-release.mjs';
import { template } from './feed-platform-production.mjs';
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
 const names=['FEED_GATEWAY_SECRET','FEED_SIGNING_SECRET','FEED_BRIDGE_SECRET','FEED_RUNTIME_ADMIN_SECRET','FEED_EXECUTOR_SECRET','FEED_SOURCE_SECRET','FEED_DELIVERY_SECRET','FEED_OPERATOR_SECRET','MOSOO_API_TOKEN','PROJECT_ANALYSIS_RECONCILE_SECRET'];
 const env=Object.fromEntries(names.map((n,i)=>[n,`${i}`.repeat(48)]));
 assert.equal(Object.keys(prepareSecrets(env).web).length,3);
 assert.throws(()=>prepareSecrets({...env,FEED_BRIDGE_SECRET:env.FEED_GATEWAY_SECRET}));
 assert.throws(()=>prepareSecrets({...env,MOSOO_API_TOKEN:''}));
 for(const value of ['',env.MOSOO_API_TOKEN,env.FEED_GATEWAY_SECRET,'x'.repeat(513),'x'.repeat(48)+'\n']) assert.throws(()=>prepareSecrets({...env,PROJECT_ANALYSIS_RECONCILE_SECRET:value}));
 const build=safeBuildEnv({...env,PATH:'/bin',NODE_OPTIONS:'--require malicious.cjs',NEXT_PUBLIC_API_SECRET:'do-not-leak',CLOUDFLARE_API_TOKEN:'do-not-leak'});
 assert.deepEqual(Object.keys(build).filter(k=>/SECRET|TOKEN|NODE_OPTIONS/.test(k)),[]);
 assert.equal(build.NEXT_PUBLIC_SITE_URL,'https://ghfind.com');
});
function webFixture() {
 const c=renderWeb(sha,'all',provider);
 const bindings=[{name:c.assets.binding,type:'assets'},...c.r2_buckets.map(b=>({name:b.binding,type:'r2_bucket',bucket_name:b.bucket_name})),...Object.entries(c.vars).map(([name,text])=>({name,type:'plain_text',text})),...c.d1_databases.map(b=>({name:b.binding,type:'d1',id:b.database_id})),{name:'FEED_RUNTIME',type:'service',service:c.services[0].service},...[...c.secrets.required,'AUTH_GITHUB_ID','AUTH_GITHUB_SECRET','AUTH_SECRET'].map(name=>({name,type:'secret_text'}))];
 const versionId='11111111-1111-4111-8111-111111111111',deploymentId='22222222-2222-4222-8222-222222222222';
 const version={id:versionId,annotations:{'workers/tag':`production-${sha}`},resources:{bindings}};
 const deployment={deployments:[{id:deploymentId,versions:[{percentage:100,version_id:versionId}]}]};
 const paths=[];
 const api=async path=>{paths.push(path);return structuredClone(path.endsWith('/deployments')?deployment:version);};
 return {version,bindings,deployment,versionId,deploymentId,paths,api};
}
test('Web readback pins both immutable response and stable active deployment with a nonsecret receipt',async()=>{
 for(const environment of [undefined,'production']) {
  const f=webFixture();f.bindings.find(b=>b.name==='FEED_RUNTIME').environment=environment;
  f.bindings.push({name:'PRESERVED_EXISTING_SETTING',type:'plain_text',text:'private-not-in-receipt'});
  const result=await verifyWeb(sha,'all',provider,f.api);
  assert.equal(result.mode,'all');assert.equal(result.workerVersionId,f.versionId);assert.equal(result.deploymentId,f.deploymentId);
  assert.match(result.bindingSHA256,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(result).includes('private-not-in-receipt'));
  assert.deepEqual(f.paths,['/workers/scripts/ghfind/deployments',`/workers/scripts/ghfind/versions/${f.versionId}`,'/workers/scripts/ghfind/deployments']);
  await assert.rejects(verifyWeb(sha,'paused',provider,f.api));
 }
});
test('Web version response, source tag, binding names/types and production service target reject ambiguity',async()=>{
 const changes=[
  f=>{delete f.version.id;},f=>{f.version.id='33333333-3333-4333-8333-333333333333';},
  f=>{f.version.annotations['workers/tag']='production-'+ 'b'.repeat(40);},
  f=>{delete f.version.resources.bindings;},f=>{f.bindings.push(null);},f=>{f.bindings.push({name:'',type:'plain_text'});},
  f=>{f.bindings.push({...f.bindings[0]});},f=>{f.bindings.push({name:'FEED_RUNTIME',type:'secret_text'});},
  f=>{f.version.resources.bindings=f.bindings.filter(b=>b.name!=='FEED_RUNTIME');},
  f=>{f.bindings.find(b=>b.name==='FEED_RUNTIME').service='ghfind-feed-runtime-staging';},
  ...['staging','',null,42].map(environment=>f=>{f.bindings.find(b=>b.name==='FEED_RUNTIME').environment=environment;}),
  ...['Admin','',null].map(entrypoint=>f=>{f.bindings.find(b=>b.name==='FEED_RUNTIME').entrypoint=entrypoint;}),
  f=>{f.bindings.find(b=>b.name==='FEED_RUNTIME').type='plain_text';},
  f=>{f.bindings.find(b=>b.name==='GHFIND_FEED_D1').id='33333333-3333-4333-8333-333333333333';},
  f=>{f.bindings.find(b=>b.name==='NEXT_INC_CACHE_R2_BUCKET').bucket_name='wrong-isolated-cache';},
  f=>{f.bindings.find(b=>b.name==='NEXT_INC_CACHE_R2_BUCKET').type='plain_text';},
  f=>{f.version.resources.bindings=f.bindings.filter(b=>b.name!=='NEXT_INC_CACHE_R2_BUCKET');},
  f=>{f.bindings.find(b=>b.name==='ASSETS').type='plain_text';},
  f=>{f.version.resources.bindings=f.bindings.filter(b=>b.name!=='ASSETS');},
  ...['AUTH_GITHUB_ID','AUTH_GITHUB_SECRET','AUTH_SECRET'].flatMap(name=>[
    f=>{f.version.resources.bindings=f.bindings.filter(b=>b.name!==name);},
    f=>{f.bindings.find(b=>b.name===name).type='plain_text';},
  ]),
  f=>{f.bindings.find(b=>b.name==='MOSOO_API_TOKEN').type='plain_text';},
  f=>{f.bindings.find(b=>b.name==='FEED_SOURCE_OUTBOX_ENABLED').text='false';},
 ];
 for(const change of changes){const f=webFixture();change(f);await assert.rejects(verifyWeb(sha,'all',provider,f.api));}
 const f=webFixture();f.bindings.find(b=>b.name==='FEED_RUNTIME').entrypoint='default';
 assert.equal((await verifyWeb(sha,'all',provider,f.api)).status,'passed');
});
test('Web readback rejects malformed, split, replaced or changed deployments including a same-version redeploy',async()=>{
 const changes=[
  d=>{delete d.deployments[0].id;},d=>{d.deployments[0].id='not-uuid';},
  d=>{d.deployments[0].versions[0].version_id='not-uuid';},
  d=>{d.deployments[0].versions[0].percentage=99;},d=>{d.deployments[0].versions[0].percentage='100';},
  d=>{d.deployments[0].versions.push({...d.deployments[0].versions[0]});},
  d=>{d.deployments=[];},d=>{d.deployments[0].versions=null;},
 ];
 for(const change of changes){const f=webFixture();change(f.deployment);await assert.rejects(verifyWeb(sha,'all',provider,f.api));assert.equal(f.paths.length,1);}
 for(const change of [d=>{d.deployments[0].id='33333333-3333-4333-8333-333333333333';},d=>{d.deployments[0].versions[0].version_id='33333333-3333-4333-8333-333333333333';},...changes]) {
  const f=webFixture();let reads=0;
  const api=async path=>{const data=await f.api(path);if(path.endsWith('/deployments') && ++reads===2)change(data);return data;};
  await assert.rejects(verifyWeb(sha,'all',provider,api));assert.equal(f.paths.length,3);
 }
 const f=webFixture();await assert.rejects(verifyWeb(sha,'all',provider,async path=>{if(f.paths.length===2)throw new Error('readback_unavailable');return f.api(path);}),/readback_unavailable/);
});
test('production Feed schema approval covers the complete fixed migrations without widening dev application releases',async()=>{
 const m=JSON.parse(readFileSync(new URL('../ops/feed-production-schema-release.json',import.meta.url)));
 const r=await approvedSchemas(m);assert.equal(r.core.length,9);assert.equal(r.feed.length,12);
 const legacy=JSON.parse(readFileSync(new URL('../ops/feed-application-schema-release.json',import.meta.url)));
 assert.equal(legacy.feed.length,2);
 assert.ok(!legacy.core.some(e=>e.name==='0005_feed_source_outbox.sql'));
});

const productionActions={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'hikariming/ghfind',GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_REF:'hikariming/ghfind/.github/workflows/deploy-cf-production.yml@refs/heads/main'};
async function withActions(fn,changes={}) {
 const saved=Object.fromEntries(Object.keys(productionActions).map(k=>[k,process.env[k]]));
 Object.assign(process.env,productionActions,changes);
 try{return await fn();}finally{for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
function resourcesFixture({missing=[],pause=false,onRead,onWrite}={}) {
 const m=template();m.billing={confirmed:true,evidence:'https://example.invalid/synthetic-billing',maximumMonthlyUSD:100,projectedMonthlyUSD:50};
 const names=[m.queue,m.deadLetterQueue,m.terminalParkingQueue];
 const ids=names.map((_,i)=>String(i+1).repeat(32));
 const calls=[],reads=new Map();
 const rows=new Map(names.filter(n=>!missing.includes(n)).map(name=>{
  const q={queue_name:name,queue_id:ids[names.indexOf(name)],settings:{message_retention_period:name===m.terminalParkingQueue?1209600:345600,delivery_delay:0},consumers:[{consumer_id:'preserved-consumer'}],messages:17};
  if(pause!=='missing')q.settings.delivery_paused=pause;
  return [q.queue_id,q];
 }));
 const api=async(path,body,method)=>{
  method??=body?'POST':'GET';calls.push({path,method,...(body?{body:structuredClone(body)}:{})});
  if(path==='/workers/scripts/ghfind/deployments')return {deployments:[{versions:[{percentage:100,version_id:'11111111-1111-4111-8111-111111111111'}]}]};
  if(path.startsWith('/workers/scripts/ghfind/versions/'))return {resources:{bindings:[{name:'FEED_BACKEND',text:'go'}]}};
  for(const d of [m.coreDatabase,m.feedDatabase])if(path===`/d1/database/${d.id}`)return {uuid:d.id,name:d.name};
  if(path===`/r2/buckets/${m.archiveBucket}`)return {name:m.archiveBucket};
  if(path==='/queues?per_page=100&page=1')return [...rows.values()].map(q=>({queue_id:q.queue_id,queue_name:q.queue_name}));
  if(path==='/queues'&&method==='POST') {
   assert.ok(names.includes(body.queue_name));
   assert.ok(![...rows.values()].some(q=>q.queue_name===body.queue_name));
   const q={queue_id:ids[names.indexOf(body.queue_name)],...structuredClone(body),consumers:[],messages:0};
   rows.set(q.queue_id,q);onWrite?.(q,method);return structuredClone(q);
  }
  const match=/^\/queues\/([a-f0-9]{32})$/.exec(path);
  if(match) {
   const q=rows.get(match[1]);assert.ok(q,'known queue required');
   if(method==='GET') {
    const count=(reads.get(match[1])??0)+1;reads.set(match[1],count);
    const result=structuredClone(q);onRead?.(result,count,rows);return result;
   }
   assert.equal(method,'PUT');assert.deepEqual(Object.keys(body).sort(),['queue_name','settings']);
   Object.assign(q,structuredClone(body));onWrite?.(q,method);return structuredClone(q);
  }
  throw new Error(`unexpected synthetic API call ${method} ${path}`);
 };
 return {m,names,ids,api,calls,rows,reads,mutations:()=>calls.filter(c=>c.method!=='GET')};
}
test('resource initialization is Actions-only before even reading the API',async()=>{
 for(const changed of [{GITHUB_ACTIONS:'false'},{GITHUB_REPOSITORY:'fork/ghfind'},{GITHUB_REF:'refs/heads/feature'},{GITHUB_WORKFLOW_REF:'hikariming/ghfind/.github/workflows/ci.yml@refs/heads/main'}]) {
  const f=resourcesFixture();await withActions(()=>assert.rejects(ensureResources(f.m,f.api),/only the production Actions/),changed);assert.deepEqual(f.calls,[]);
 }
});
test('missing delivery flag initializes once only after all three exact queue preflights and fresh explicit readback',async()=>{
 const f=resourcesFixture({pause:'missing'});
 const before=[...f.rows.values()].map(q=>({id:q.queue_id,consumers:q.consumers,messages:q.messages}));
 const result=await withActions(()=>ensureResources(f.m,f.api));
 assert.equal(result.status,'verified');assert.equal(result.resources.filter(r=>r.kind==='queue').length,3);
 assert.equal(f.mutations().length,3);
 const firstMutation=f.calls.findIndex(c=>c.method!=='GET');
 for(const id of f.ids)assert.ok(f.calls.slice(0,firstMutation).some(c=>c.path===`/queues/${id}`&&c.method==='GET'));
 for(const c of f.mutations()) {
  assert.equal(c.method,'PUT');
  assert.deepEqual(c.body,{queue_name:f.names[f.ids.indexOf(c.path.split('/').at(-1))],settings:{message_retention_period:c.body.queue_name===f.m.terminalParkingQueue?1209600:345600,delivery_delay:0,delivery_paused:false}});
 }
 for(const old of before) {
  const current=f.rows.get(old.id);assert.deepEqual(current.consumers,old.consumers);assert.equal(current.messages,old.messages);assert.equal(f.reads.get(old.id),3);
 }
 await withActions(()=>ensureResources(f.m,f.api));assert.equal(f.mutations().length,3,'successful re-entry never repeats PUT');
});
test('new queue creation pins explicit delivery false and independently reads its exact identity and settings',async()=>{
 const names=resourcesFixture().names;
 const f=resourcesFixture({missing:names});
 await withActions(()=>ensureResources(f.m,f.api));
 assert.equal(f.mutations().length,3);assert.ok(f.mutations().every(c=>c.path==='/queues'&&c.method==='POST'&&c.body.settings.delivery_paused===false));
 for(const id of f.ids)assert.equal(f.reads.get(id),1);
 await withActions(()=>ensureResources(f.m,f.api));assert.equal(f.mutations().length,3);
});
test('explicit false is idempotent while a third paused or malformed queue prevents every queue mutation',async()=>{
 const ready=resourcesFixture();await withActions(()=>ensureResources(ready.m,ready.api));assert.deepEqual(ready.mutations(),[]);
 for(const pause of [true,null,0,'false',undefined]) {
  const f=resourcesFixture({pause:'missing'});f.rows.get(f.ids[2]).settings.delivery_paused=pause;
  await withActions(()=>assert.rejects(ensureResources(f.m,f.api),/pause must be explicitly false/));assert.deepEqual(f.mutations(),[]);
 }
 for(const key of ['message_retention_period','delivery_delay']) {
  const f=resourcesFixture({pause:'missing'});f.rows.get(f.ids[2]).settings[key]++;
  await withActions(()=>assert.rejects(ensureResources(f.m,f.api),/retention\/delivery settings differ/));assert.deepEqual(f.mutations(),[]);
 }
 const f=resourcesFixture({missing:[ready.names[0]],pause:'missing'});f.rows.get(f.ids[2]).settings.delivery_paused=true;
 await withActions(()=>assert.rejects(ensureResources(f.m,f.api)));assert.deepEqual(f.mutations(),[],'new queue cannot be created before existing third target preflight');
});
test('identity drift during preflight or immediate pre-PUT read fails without changing a queue',async()=>{
 for(const countToChange of [1,2])for(const field of ['queue_id','queue_name']) {
  const f=resourcesFixture({pause:'missing',onRead(q,count){if(count===countToChange)q[field]=field==='queue_id'?'f'.repeat(32):'other-owner-queue';}});
  await withActions(()=>assert.rejects(ensureResources(f.m,f.api),/queue identity mismatch/));assert.deepEqual(f.mutations(),[]);
 }
 const paused=resourcesFixture({pause:'missing',onRead(q,count){if(count===2)q.settings.delivery_paused=true;}});
 await withActions(()=>assert.rejects(ensureResources(paused.m,paused.api),/pause must be explicitly false/));assert.deepEqual(paused.mutations(),[]);
 const initialized=resourcesFixture({pause:'missing',onRead(q,count){if(count===2)q.settings.delivery_paused=false;}});
 await withActions(()=>ensureResources(initialized.m,initialized.api));assert.deepEqual(initialized.mutations(),[],'another initializer completed between reads');
});
test('PUT and create cannot pass without explicit fresh readback or with changed returned identity/settings',async()=>{
 for(const existing of [true,false])for(const change of ['missing','paused','malformed','identity','retention','delay','get-error']) {
  const f=resourcesFixture({missing:existing?[]:resourcesFixture().names,pause:'missing',onRead(q,count){
   if(count!==(existing?3:1))return;
   if(change==='missing')delete q.settings.delivery_paused;
   if(change==='paused')q.settings.delivery_paused=true;
   if(change==='malformed')q.settings.delivery_paused='false';
   if(change==='identity')q.queue_id='f'.repeat(32);
   if(change==='retention')q.settings.message_retention_period++;
   if(change==='delay')q.settings.delivery_delay++;
   if(change==='get-error')throw new Error('synthetic readback unavailable');
  }});
  await withActions(()=>assert.rejects(ensureResources(f.m,f.api)));assert.equal(f.mutations().length,1,'uncertain operation is never blindly retried and later targets stay untouched');
 }
 for(const existing of [true,false]) {
  const f=resourcesFixture({missing:existing?[]:resourcesFixture().names,pause:'missing',onWrite(q){q.queue_name='other-owner-queue';}});
  await withActions(()=>assert.rejects(ensureResources(f.m,f.api),/queue identity mismatch/));assert.equal(f.mutations().length,1);
 }
});
