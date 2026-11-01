/** Manual integration smoke for the isolated local D1/R2 server only. Uses fictional accounts and leaves labeled sample posts. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local=root+'/.wrangler/social-feed-local';
const vars=Object.fromEntries(readFileSync(local+'/.dev.vars','utf8').trim().split('\n').map(line=>line.split('=')));
const scoreVersion=readFileSync(root+'/src/lib/cache-version.ts','utf8').match(/SCORE_CACHE_VERSION\s*=\s*"([^"]+)"/)[1];
const collectionVersion=readFileSync(root+'/src/lib/scan-run-types.ts','utf8').match(/PUBLIC_SCAN_COLLECTION_VERSION\s*=\s*"([^"]+)"/)[1];
const actors={writer:{github_id:91000001,login:'feed-local-dev'},boundary:{github_id:91000002,login:'feed-local-sixty'},low:{github_id:91000003,login:'feed-local-reader'},mirror:{github_id:91000004,login:'feed-local-mirror'}};
function cookie(actor){const payload=Buffer.from(JSON.stringify({...actor,expires_at:Date.now()+3600_000})).toString('base64url');return 'ghfind_session='+payload+'.'+createHmac('sha256',vars.AUTH_SECRET).update('ghfind:oauth:session:'+payload).digest('base64url');}
const scores={writer:69,boundary:60,low:59.96,mirror:90};
const quote=(value)=>"'"+String(value).replaceAll("'","''")+"'";
const sql=Object.entries(actors).map(([key,actor])=>{
  // Minimal fictional provenance, deliberately confined to this isolated fixture database.
  // Regression: pre-identity Go snapshots must authorize an existing 69-point score without rescanning.
  const identity = key === 'writer' ? {avatar_url:`https://avatars.githubusercontent.com/u/${actor.github_id}?v=4`} : {github_user_id:String(actor.github_id)};
  const snapshot=JSON.stringify({metrics:{username:actor.login,...identity}});
  const savedScoreVersion = key === 'writer' ? 'v12' : scoreVersion;
  const savedCollectionVersion = key === 'writer' ? 'v5' : collectionVersion;
  const hash=createHash('sha256').update(snapshot).digest('hex');
  const now=Date.now();
  return `INSERT OR REPLACE INTO public_scan_runs(id,username,score_version,collection_version,state,coverage,snapshot,snapshot_hash,started_at,completed_at,updated_at)
    VALUES(${quote('social-fixture-'+key)},${quote(actor.login)},${quote(savedScoreVersion)},${quote(savedCollectionVersion)},'complete_public','complete_public',${quote(snapshot)},${quote(hash)},${now},${now},${now});
    INSERT OR REPLACE INTO scores(username,final_score,tier,hidden,scanned_at,score_version,score_source_collection_version,score_source_snapshot_hash)
    VALUES(${quote(actor.login)},${scores[key]},'NPC',0,${now},${quote(savedScoreVersion)},${quote(savedCollectionVersion)},${quote(hash)});`;
}).join('\n');
writeFileSync(local+'/smoke-seed.sql',sql);
const migration=spawnSync('pnpm',['exec','wrangler','d1','execute','social-feed-core-local','--local','--config',local+'/wrangler.json','--persist-to',local+'/state','--file',local+'/smoke-seed.sql'],{cwd:root+'/apps/api',encoding:'utf8'});
assert.equal(migration.status,0,migration.stderr);console.log('local score fixtures ready');
const headers=(actor)=>({'Origin':'http://127.0.0.1:4321',...(actor?{Cookie:cookie(actor)}:{})});
async function request(path,{actor=actors.writer,method='GET',body,key,expected=200,extra={}}={}){const response=await fetch('http://127.0.0.1:8791'+path,{method,headers:{...headers(actor),...extra,...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined});const value=await response.json();assert.equal(response.status,expected,JSON.stringify({path,value}));return value;}
const caps=await request('/api/feed/publishing-capabilities',{actor:actors.boundary});assert.equal(caps.can_publish,true);
await request('/api/feed/posts',{actor:actors.low,method:'POST',key:randomUUID(),body:{text:'should reject'},expected:403});
await request('/api/feed/posts',{actor:null,method:'POST',key:randomUUID(),body:{text:'should reject'},expected:401});
const key=randomUUID();const input={text:'【本地联调样例】原生帖子\n最近在把开源工具的小问题一个个修好。这个帖子只保存在 ghfind。'};
const post=await request('/api/feed/posts',{method:'POST',key,body:input,expected:201});
const retry=await request('/api/feed/posts',{method:'POST',key,body:input});assert.equal(retry.id,post.id);assert.equal(post.origin,'ghfind');assert.equal(post.original_url,null);
const reply=await request(`/api/feed/posts/${post.id}/replies`,{actor:actors.boundary,method:'POST',key:randomUUID(),body:{text:'【本地联调样例】刚好 60 分，也可以参与讨论。'},expected:201});
const nested=await request(`/api/feed/posts/${reply.id}/replies`,{method:'POST',key:randomUUID(),body:{text:'【本地联调样例】这是回复的回复。'},expected:201});assert.equal(nested.conversation_id,post.id);assert.equal(nested.parent_post_id,reply.id);
await request(`/api/feed/posts/${reply.id}/replies`,{actor:actors.low,method:'POST',key:randomUUID(),body:{text:'reject nested'},expected:403});
const like=await request(`/api/feed/posts/${post.id}/reaction`,{actor:actors.low,method:'PUT',body:{value:'like'}});assert.equal(like.metrics.likes,1);
const dislike=await request(`/api/feed/posts/${post.id}/reaction`,{actor:actors.low,method:'PUT',body:{value:'dislike'}});assert.equal(dislike.metrics.likes,0);assert.equal(dislike.viewer.reaction,'dislike');
const publicPost=await request(`/api/feed/posts/${post.id}`,{actor:null});assert.equal(publicPost.viewer,null);assert.equal('dislikes' in publicPost.metrics,false);
await request(`/api/feed/posts/${post.id}/bookmark`,{actor:actors.low,method:'PUT'});
const bookmarks=await request('/api/feed/me/bookmarks',{actor:actors.low});assert(bookmarks.items.some(p=>p.id===post.id));
const privateOther=await request('/api/feed/me/bookmarks',{actor:actors.boundary});assert(!privateOther.items.some(p=>p.id===post.id));
await request(`/api/feed/posts/${post.id}/repost`,{actor:actors.low,method:'PUT'});
await request(`/api/feed/authors/gha_${actors.low.github_id}/follow`,{actor:actors.boundary,method:'PUT'});
const following=await request('/api/feed/posts?channel=following',{actor:actors.boundary});assert(following.items.some(p=>p.id===post.id && p.reposted_by?.github_login===actors.low.login));
const xId=String(Date.now());const xInput={author:{github_user_id:String(actors.mirror.github_id),github_login:actors.mirror.login,name:'本地镜像测试开发者',avatar_url:null},source:{post_id:xId,author_id:'91000999',url:`https://x.com/feed_fixture/status/${xId}`,display_name:'X 镜像测试作者',avatar_url:null,evidence_method:'editorial_review',evidence_url:'https://github.com/'+actors.mirror.login,evidence_checked_at:new Date().toISOString()},text:'【本地联调样例】这是一条 X 内容导入测试，不是真实 X 推文。只导入正文，没有带入 X 的点赞或浏览数。',published_at:new Date().toISOString()};
const imported=await request('/api/internal/social-feed/x-posts',{actor:null,method:'POST',body:xInput,extra:{Authorization:'Bearer '+vars.SOCIAL_FEED_INGEST_SECRET},expected:201});assert.equal(imported.origin,'x');assert.equal(imported.author.name,'X 镜像测试作者');assert.equal(imported.author.github_login,actors.mirror.login);assert.equal(imported.metrics.likes,0);
await request('/api/internal/social-feed/x-posts',{actor:null,method:'POST',body:{...xInput,metrics:{likes:999}},extra:{Authorization:'Bearer '+vars.SOCIAL_FEED_INGEST_SECRET},expected:400});
const first=await request('/api/feed/posts?limit=1');
assert(first.next_cursor);assert.equal(first.items.length,1);
const nextPath='/api/feed/posts?limit=1&cursor='+encodeURIComponent(first.next_cursor);
const second=await request(nextPath);assert(second.items.length>0);assert.notEqual(first.items[0].id,second.items[0].id);
await request(nextPath,{actor:actors.boundary,expected:400});
const anonymousFirst=await fetch('http://127.0.0.1:8791/api/feed/posts?limit=1');
const anonymousPage=await anonymousFirst.json();const visitorCookie=anonymousFirst.headers.get('set-cookie')?.split(';')[0];
assert(visitorCookie);assert(anonymousPage.next_cursor);
const anonymousNext=await request('/api/feed/posts?limit=1&cursor='+encodeURIComponent(anonymousPage.next_cursor),{actor:null,extra:{Cookie:visitorCookie}});
assert.notEqual(anonymousPage.items[0].id,anonymousNext.items[0].id);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6eAAAAABJRU5ErkJggg==','base64');const form=new FormData();form.set('file',new Blob([png],{type:'image/png'}),'fixture.png');form.set('alt_text','本地测试像素');
const upload=await fetch('http://127.0.0.1:8791/api/feed/media',{method:'POST',headers:headers(actors.writer),body:form});const media=await upload.json();assert.equal(upload.status,201,JSON.stringify(media));
assert.equal((await fetch('http://127.0.0.1:8791'+media.url)).status,404);
await request('/api/feed/posts',{actor:actors.boundary,method:'POST',key:randomUUID(),body:{text:'stolen media',media_ids:[media.id]},expected:400});
const imagePost=await request('/api/feed/posts',{method:'POST',key:randomUUID(),body:{text:'【本地联调样例】图片持久化与归属校验。',media_ids:[media.id]},expected:201});assert.equal(imagePost.media[0].id,media.id);assert.equal((await fetch('http://127.0.0.1:8791'+media.url)).status,200);
await request(`/api/feed/posts/${imagePost.id}`,{method:'DELETE'});
const deleteReply=await request(`/api/feed/posts/${reply.id}`,{actor:actors.boundary,method:'DELETE'});assert.equal(deleteReply.status,'deleted');
const nestedRead=await request(`/api/feed/posts/${nested.id}`,{actor:null});assert.equal(nestedRead.status,'published');const ancestors=await request(`/api/feed/posts/${nested.id}/ancestors`,{actor:null});assert(ancestors.items.some(p=>p.id===reply.id && p.status==='deleted'));
const viewPost=await request(`/api/feed/posts/${post.id}`,{actor:actors.writer});await new Promise(resolve=>setTimeout(resolve,2200));const event={event_id:randomUUID(),event_type:'qualified_view',post_id:post.id,view_token:viewPost.view_token};
const recorded=await request('/api/feed/post-events',{method:'POST',body:event});assert.equal(recorded.recorded,true);const duplicate=await request('/api/feed/post-events',{method:'POST',body:event});assert.equal(duplicate.recorded,false);
writeFileSync(local+'/smoke-fixtures.json',JSON.stringify({post,reply,nested,imported,imagePost,actors}));
console.log('PASS: public browsing; auth/60 threshold with immutable identity; idempotency; nested replies; local reactions/privacy; bookmark; repost-follow distribution; strict X import; signed snapshot pagination; media owner/visibility; tombstones; qualified-view dedup');
