import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ui } from "../src/ui";
import { seal } from "../src/secrets";
import { getSettings, putSettings } from "../src/settings";
import { ADMIN_MESSAGES } from "../src/admin-i18n";
import { LOCALES } from "../src/i18n";
import { adminLink } from "../src/admin-ui";

declare const TEST_SQL: string[];
const testEnv=env as Env, origin="https://bot.example", repo="sample/control-panel";
const e={...testEnv,APP_CLIENT_ID:"client-test",LLM_API_KEY:"",JEV_ENABLED:"false"} as Env;
let cookie="",csrf="",admin=true, liveId=100, liveName=repo;
const calls:string[]=[];
let installations=[{id:10,account:{login:"sample"}}];
let repos=[{id:100,full_name:repo}];
beforeAll(async()=>{for(const sql of TEST_SQL)await testEnv.DB.prepare(sql).run()});
beforeEach(async()=>{
 await testEnv.DB.exec("DELETE FROM sessions; DELETE FROM repo_settings; DELETE FROM jobs; DELETE FROM cleanups; DELETE FROM cleanup_items; DELETE FROM audit_log; DELETE FROM api_rate;");
 admin=true;liveId=100;liveName=repo;calls.length=0;installations=[{id:10,account:{login:"sample"}}];repos=[{id:100,full_name:repo}];
 csrf=crypto.randomUUID();cookie=`ghfind_bot_session=${csrf}`;
 await testEnv.DB.prepare("INSERT INTO sessions(id,value,expires) VALUES(?,?,?)").bind(`session:${csrf}`,await seal(testEnv,"dashboard-test-token"),Date.now()+3600000).run();
 vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
   const url=new URL(String(input));expect(url.hostname).toBe("api.github.com");calls.push(url.pathname);
   if(url.pathname==="/user/installations")return Response.json({installations});
   if(url.pathname==="/user/installations/10/repositories")return Response.json({repositories:repos});
   if(url.pathname==="/user/installations/20/repositories")return Response.json({repositories:[{id:200,full_name:"other/tools"}]});
   if(url.pathname==="/repos/other/tools")return Response.json({id:200,full_name:"other/tools",permissions:{admin:true,push:true}});
   if(url.pathname===`/repos/${repo}`)return Response.json({id:liveId,full_name:liveName,permissions:{admin,push:true}});
   if(url.pathname===`/repos/${repo}/labels`)return Response.json([{name:"bug",color:"d73a4a",description:"Fix defects"}]);
   if(url.pathname==="/user")return Response.json({id:1,login:"octo-admin"});
   throw new Error(`Unexpected GitHub request ${url.pathname}`);
 }));
});
afterEach(()=>vi.unstubAllGlobals());
const get=(path:string)=>ui(new Request(origin+path,{headers:{cookie}}),e);
const post=(path:string,form:URLSearchParams,source=origin)=>ui(new Request(origin+path,{method:"POST",headers:{cookie,origin:source},body:form}),e);
const query="installation_id=10&repository=100";

describe("SaaS dashboard navigation and operations",()=>{
 it("renders a real global dashboard and scopes account drill-downs to each installation",async()=>{
  installations.push({id:20,account:{login:"other"}});
  const now=Date.now();
  await testEnv.DB.batch([
   testEnv.DB.prepare("INSERT INTO jobs(id,installation,repository,full_name,pr,kind,state,created,due,updated) VALUES('global-one',10,100,?,10,'label','pending',?,?,?)").bind(repo,now,now,now),
   testEnv.DB.prepare("INSERT INTO jobs(id,installation,repository,full_name,pr,kind,state,created,due,updated) VALUES('global-other',20,200,'other/tools',2,'label','failed',?,?,?)").bind(now,now,now),
  ]);
  const response=await get('/admin?lang=zh');expect(response.status).toBe(200);const html=await response.text();
  expect(html).toContain('class="kpi-strip"');expect(html).toContain('global-one');expect(html).toContain('global-other');
  expect(html).toContain('/admin/repo?installation_id=20&amp;lang=zh&amp;repository=200');
  expect(html).toContain('/retry?installation_id=20&amp;lang=zh');
  expect(html).toContain('/admin/tasks?installation_id=20&amp;lang=zh&amp;status=failed');
  const other=await(await get('/admin?installation_id=20&lang=zh')).text();
  expect(other).toContain('global-other');expect(other).not.toContain('global-one');
  expect(calls.filter(path=>path==='/user/installations/20/repositories')).toHaveLength(2);
 });
 it("rejects malformed global pagination before repository reads and renders zero accounts without invented metrics",async()=>{
  for(const suffix of ['account_page=0','account_page=1&account_page=2','account_page=251'])expect((await get('/admin?'+suffix)).status).toBe(400);
  expect(calls).toEqual([]);
  expect((await get('/admin?account_page=2')).status).toBe(400);expect(calls).toEqual(['/user/installations']);
  installations=[];const html=await(await get('/admin')).text();
  expect(html).toContain('class="admin-empty"');expect(html).not.toContain('class="kpi-strip"');expect(html).toContain('https://github.com/settings/installations');
 });
 it("keeps legacy setup number-ordered and filters unauthorized history before its 100-row limit",async()=>{
  await testEnv.DB.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<110)
   INSERT INTO jobs(id,installation,repository,full_name,pr,kind,state,created,due,updated)
   SELECT 'hidden-'||n,10,999,'secret/hidden',n,'label','done',n,0,1000+n FROM seq`).run();
  await testEnv.DB.batch([2,10,100,1].map((number,index)=>testEnv.DB.prepare("INSERT INTO jobs(id,installation,repository,full_name,pr,kind,state,created,due,updated) VALUES(?,10,100,?,?,'label','done',?,0,?)").bind('visible-'+number,repo,number,10-index,index*100)));
  const first=await(await get('/setup?installation_id=10')).text();
  const positions=[1,2,10,100].map(number=>first.indexOf(` #${number}</td>`));
  expect(positions.every(position=>position>=0)).toBe(true);expect([...positions].sort((a,b)=>a-b)).toEqual(positions);expect(first).not.toContain('secret/hidden');
  await testEnv.DB.prepare("UPDATE jobs SET updated=99999-updated").run();
  const second=await(await get('/setup?installation_id=10')).text();
  expect([1,2,10,100].map(number=>second.indexOf(` #${number}</td>`))).toEqual(positions);
 });
 it("keeps installation management inside the selected workspace and every sidebar destination usable",async()=>{
  const html=await(await get("/admin/installations?installation_id=10&lang=zh")).text();
  expect(html).toContain('href="/admin?lang=zh"');
  const global=await get('/admin?lang=zh');expect(global.status).toBe(200);expect(await global.text()).toContain('class="kpi-strip"');
  for(const route of ["/admin/repositories","/admin/tasks","/admin/activity"]){
   expect(html).toContain(`href="${route}?installation_id=10&amp;lang=zh"`);
   const next=await get(`${route}?installation_id=10&lang=zh`);
   expect(next.status).toBe(200);expect(await next.text()).toContain('class="scope-note"');
  }
  expect(html).not.toContain('id="installation-context"');
 });
 it("gives direct installation entry a valid account context without needing repository data",async()=>{
  repos=[];
  const html=await(await get("/admin/installations?lang=ar")).text();
  expect(html).toContain('/admin/repositories?installation_id=10&amp;lang=ar');
  expect(html).toContain('sample');expect(html).toContain('dir="rtl"');
  expect(calls).toEqual(['/user/installations']);
 });
 it("offers every authenticated installation throughout the workspace and selects the requested account",async()=>{
  installations.push({id:20,account:{login:"other"}});
  const html=await(await get("/admin/repositories?installation_id=10&lang=zh")).text();
  expect(html).toContain('/admin/repositories?installation_id=20&amp;lang=zh');
  const switched=await get("/admin/repositories?installation_id=20&lang=zh");
  expect(switched.status).toBe(200);expect(await switched.text()).toContain('other/tools');
  const management=await(await get("/admin/installations?installation_id=20&lang=zh")).text();
  expect(management).toContain('/admin/tasks?installation_id=20&amp;lang=zh');
 });
 it("never selects an unowned or malformed installation as workspace context",async()=>{
  expect((await get("/admin/installations?installation_id=999")).status).toBe(404);
  expect(calls).toEqual(['/user/installations']);calls.length=0;
  expect((await get("/admin/installations?installation_id=not-a-number")).status).toBe(400);
  expect(calls).toEqual([]);
 });
 it("keeps installation ID and locale in links to management",()=>{
  expect(adminLink({path:'/admin/repositories',installation:'20',locale:'ar',lang:'ar',repoPage:3},'/admin/installations')).toBe('/admin/installations?installation_id=20&lang=ar');
 });
 it("requires an explicit workspace for repository reads and mutations",async()=>{
  expect((await get('/admin/repo?repository=100')).status).toBe(400);
  for(const route of ['/admin/repo','/admin/toggle','/admin/intent-preview']){
   expect((await post(`${route}?repository=100`,new URLSearchParams({csrf,enabled:'off',preview_kind:'issue',preview_title:'Synthetic sample'}))).status).toBe(400);
  }
  expect(calls).toEqual([]);
  expect((await getSettings(testEnv,100)).issuesEnabled).toBe(true);
  expect((await testEnv.DB.prepare('SELECT id FROM jobs').all()).results).toEqual([]);
  expect((await testEnv.DB.prepare('SELECT id FROM audit_log').all()).results).toEqual([]);
 });
 it("preserves locale, repository page and list filters through settings and operation forms",async()=>{
  const suffix='&lang=ar&repo_page=3&return_q=control&return_processing=active';
  for(const tab of ['settings','preview','backfill','cleanup']){
   const html=await(await get(`/admin/repo?${query}${suffix}&tab=${tab}`)).text();
   expect(html).toContain('/admin/repositories?installation_id=10&amp;lang=ar&amp;repo_page=3&amp;q=control&amp;processing=active');
   expect(html).toContain('return_q=control&amp;return_processing=active');
   expect(html).toContain('lang=ar&amp;repo_page=3');
  }
  const response=await post(`/admin/repo?${query}${suffix}`,new URLSearchParams({csrf,issues_enabled:'on',prs_enabled:'on',allowed_labels:'bug'}));
  expect(response.status).toBe(303);
  const redirect=new URL(response.headers.get('location')!,origin);
  for(const [key,value] of Object.entries({lang:'ar',repo_page:'3',return_q:'control',return_processing:'active',saved:'1'}))expect(redirect.searchParams.get(key)).toBe(value);
 });
 it("keeps repository list filters after toggles and rejects malformed return context",async()=>{
  const response=await post(`/admin/toggle?${query}&lang=zh&repo_page=3&return_q=control&return_processing=active`,new URLSearchParams({csrf,enabled:'off'}));
  expect(response.status).toBe(303);
  const redirect=new URL(response.headers.get('location')!,origin);
  expect(Object.fromEntries(redirect.searchParams)).toEqual({installation_id:'10',lang:'zh',repo_page:'3',q:'control',processing:'active'});
  for(const suffix of ['&return_processing=bad','&return_q='+encodeURIComponent('x'.repeat(101)),'&return_q=x&return_q=y'])expect((await get(`/admin/repo?${query}${suffix}`)).status).toBe(400);
 });
 it("returns a retried task to the same locale, page and validated filters",async()=>{
  await testEnv.DB.prepare("INSERT INTO jobs(id,installation,repository,full_name,kind,state,created,due,updated) VALUES('ux-retry',10,100,?,'initialize','failed',1,1,1)").bind(repo).run();
  const response=await post('/retry?installation_id=10&lang=ar&repo_page=3&q=control&status=failed&kind=initialize&task_page=2',new URLSearchParams({csrf,id:'ux-retry',return_to:'tasks'}));
  expect(response.status).toBe(303);
  const target=new URL(response.headers.get('location')!,origin);
  expect(target.pathname).toBe('/admin/tasks');
  expect(Object.fromEntries(target.searchParams)).toEqual({installation_id:'10',lang:'ar',repo_page:'3',q:'control',status:'failed',kind:'initialize',task_page:'2'});
  expect(await testEnv.DB.prepare("SELECT state FROM jobs WHERE id='ux-retry'").first()).toEqual({state:'cancelled'});
 });
 it("has complete localized dashboard catalogs",()=>{
  const keys=Object.keys(ADMIN_MESSAGES.en);
  for(const locale of LOCALES){expect(Object.keys(ADMIN_MESSAGES[locale])).toEqual(keys);expect(Object.values(ADMIN_MESSAGES[locale]).every(value=>typeof value==="string"&&value.length>0)).toBe(true)}
 });
 it("renders real independent pages in a desktop shell with scope and safe navigation",async()=>{
  for(const route of ["/admin","/admin/repositories","/admin/tasks","/admin/activity"]){
   const response=await get(`${route}?installation_id=10&lang=ar`);expect(response.status).toBe(200);const html=await response.text();
   expect(html).toContain('class="admin-app"');expect(html).toContain('id="admin-sidebar"');expect(html).toContain('dir="rtl"');expect(html).toContain('src="/admin.js?v=');expect(html).toContain('class="scope-note"');
   for(const choice of ["light","dark","auto"])expect(html).toContain(`data-theme-choice="${choice}"`);
   expect(html).toContain('action="/logout"');expect(html).toContain('installation_id=10&amp;lang=ar');
   expect(html).not.toContain('class="page"');
  }
  expect(calls.filter(path=>path===`/repos/${repo}`)).toHaveLength(4);
 });
 it("offers processing switches only to admins and reads status for collaborators",async()=>{
  let html=await(await get("/admin/repositories?installation_id=10")).text();expect(html).toContain('role="switch" aria-checked="true"');expect(html).toContain('action="/admin/toggle?installation_id=10&amp;repository=100"');
  admin=false;html=await(await get("/admin/repositories?installation_id=10")).text();expect(html).not.toContain('role="switch"');expect(html).toContain("Read only");expect(html).toContain("Open settings");
 });
 it("rejects new mutation routes before external calls for bad Origin or CSRF",async()=>{
  for(const route of ["/admin/toggle","/admin/intent-preview"]){
   expect((await post(`${route}?${query}`,new URLSearchParams({csrf,enabled:"off"}),"https://evil.example")).status).toBe(403);
   expect((await post(`${route}?${query}`,new URLSearchParams({csrf:"wrong",enabled:"off"}))).status).toBe(403);
   expect((await get(`${route}?${query}`)).status).toBe(405);
  }
  expect(calls).toEqual([]);
 });
 it("checks live admin permission and preserves every optional feature when pausing",async()=>{
  await putSettings(testEnv,10,100,repo,{issuesEnabled:true,prsEnabled:false,commentsEnabled:true,commentPrompt:"Keep this",triageEnabled:true,allowedLabels:["bug"]},"octo-admin");
  const data=new URLSearchParams({csrf,enabled:"off"});admin=false;
  expect((await post(`/admin/toggle?${query}`,data)).status).toBe(403);expect((await getSettings(testEnv,100)).issuesEnabled).toBe(true);
  admin=true;const result=await post(`/admin/toggle?${query}&lang=zh`,data);expect(result.status).toBe(303);expect(result.headers.get("location")).toBe("/admin/repositories?installation_id=10&lang=zh");
  expect(await getSettings(testEnv,100)).toMatchObject({issuesEnabled:false,prsEnabled:false,commentsEnabled:true,commentPrompt:"Keep this",triageEnabled:true,allowedLabels:["bug"]});
  const audit=await testEnv.DB.prepare("SELECT detail FROM audit_log").first<{detail:string}>();expect(JSON.parse(audit!.detail)).toEqual({changed:["issuesEnabled","prsEnabled"]});
 });
 it("fails closed when a live repository changes identity or owner",async()=>{
  for(const mismatch of [{id:200,name:repo},{id:100,name:"new-owner/control-panel"}]){
   liveId=mismatch.id;liveName=mismatch.name;
   expect((await get(`/admin/repo?${query}`)).status).toBe(404);
   expect((await post(`/admin/toggle?${query}`,new URLSearchParams({csrf,enabled:"off"}))).status).toBe(403);
   expect((await post(`/admin/intent-preview?${query}`,new URLSearchParams({csrf,preview_kind:"issue",preview_title:"Synthetic sample"}))).status).toBe(403);
  }
  expect(calls.some(path=>path.endsWith("/labels")||path==="/user")).toBe(false);
  expect((await getSettings(testEnv,100)).issuesEnabled).toBe(true);
 });
 it("renders separate repository tabs and keeps optional forms explicit",async()=>{
  const settings=await(await get(`/admin/repo?${query}`)).text();expect(settings).toContain('class="settings-flow"');expect(settings).toContain('class="settings-save"');expect(settings).not.toContain('name="preview_title"');expect(settings).not.toContain('id="backfill"');
  const preview=await(await get(`/admin/repo?${query}&tab=preview`)).text();expect(preview).toContain('name="preview_title"');expect(preview).toContain("no GitHub changes");expect(preview).not.toContain('name="comment_prompt"');
  admin=false;const readOnly=await(await get(`/admin/repo?${query}&tab=preview`)).text();expect(readOnly).toContain('<fieldset class="stack" disabled>');expect(readOnly).not.toContain("Run preview");
 });
 it("keeps preview error samples ephemeral and escaped for retry",async()=>{
  const form=new URLSearchParams({csrf,preview_kind:"issue",preview_title:'<script>sample</script>',preview_body:'A synthetic <b>sample</b>'});
  const response=await post(`/admin/intent-preview?${query}`,form);expect(response.status).toBe(503);const html=await response.text();
  expect(html).toContain('role="alert"');expect(html).toContain("not configured");expect(html).toContain("&lt;script&gt;sample&lt;/script&gt;");expect(html).toContain("A synthetic &lt;b&gt;sample&lt;/b&gt;");expect(html).not.toContain("<script>sample");
  expect((await testEnv.DB.prepare("SELECT id FROM jobs").all()).results).toEqual([]);expect((await testEnv.DB.prepare("SELECT id FROM audit_log").all()).results).toEqual([]);
 });
 it("renders empty installations actionably and validates filters",async()=>{
  installations=[];const html=await(await get("/admin/installations")).text();expect(html).toContain("/installations/new");
  installations=[{id:10,account:{login:"sample"}}];
  expect((await get("/admin/tasks?installation_id=10&status=not-a-state")).status).toBe(400);expect((await get("/admin/tasks?installation_id=10&task_page=0")).status).toBe(400);
 });
});
