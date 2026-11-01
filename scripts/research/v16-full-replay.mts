/** Re-run both collectors against identical cached GitHub responses.
 * Reads local evidence only; never falls through to live GitHub or production.
 * Account identifiers are accepted via environment/input files, never logged. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {collect, type CollectOptions} from '../../src/lib/github';
import {score} from '../../src/lib/score';
const input=process.env.V16_SAMPLE_DIR, http=process.env.V16_HTTP_CACHE_DIR, layout=process.env.V16_LAYOUT_CACHE_DIR;
if(!input||!http||!layout)throw Error('V16_SAMPLE_DIR, V16_HTTP_CACHE_DIR and V16_LAYOUT_CACHE_DIR required');
const output=process.env.V16_REPLAY_DIR??'/tmp/v16-full-replay';mkdirSync(output,{recursive:true});
if(!process.env.V16_BASELINE_REF)throw Error('V16_BASELINE_REF must identify the v15 baseline');
const baseline=execFileSync('git',['rev-parse',process.env.V16_BASELINE_REF],{encoding:'utf8'}).trim();
const tag=`.v16-replay-${process.pid}`;
const scorePath=resolve(`src/lib/${tag}-score.ts`),githubPath=resolve(`src/lib/${tag}-github.ts`);
writeFileSync(scorePath,execFileSync('git',['show',`${baseline}:src/lib/score.ts`]));
writeFileSync(githubPath,execFileSync('git',['show',`${baseline}:src/lib/github.ts`],{encoding:'utf8'}).replace('from "./score"',`from "./${tag}-score"`));
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const missing=new Map<string,{url:string;body?:string}>();
let missingCount=0;
const missingLayouts=new Set<string>();
const candidateHash=hash(['src/lib/github.ts','src/lib/score.ts','src/lib/presentation-concentration.ts','src/lib/co-creator.ts'].map(p=>readFileSync(p,'utf8')).join('\n'));
process.env.GITHUB_TOKEN ||= execFileSync('gh',['auth','token'],{encoding:'utf8'}).trim();
globalThis.fetch=async(input,init={})=>{
 const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
 const parsed=new URL(url);
 if(parsed.origin!=='https://api.github.com')throw Error('Offline replay forbids external requests');
 let body=typeof init.body==='string'?init.body:undefined;
 if(body&&parsed.pathname==='/graphql')body=body.replaceAll('files(first: 50) { nodes { path } }','files(first: 100) { nodes { path additions deletions } }');
 const key=hash(`${url}\n${body??''}`);
 const extra=process.env.V16_EXTRA_HTTP_CACHE_DIR?resolve(process.env.V16_EXTRA_HTTP_CACHE_DIR,`${key}.json`):'';
 const path=extra&&existsSync(extra)?extra:resolve(http,`${key}.json`);
 if(existsSync(path)){
  const r=JSON.parse(readFileSync(path,'utf8'));
  return new Response(r.body,{status:r.status,headers:{'content-type':'application/json'}});
 }
 const root=parsed.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents$/);
 if(root){
  const p=resolve(layout,`${hash(root[1].toLowerCase())}.json`);
  if(existsSync(p)){
   const paths:string[]|null=JSON.parse(readFileSync(p,'utf8'));
   return Response.json(paths?.map(name=>({name}))??{message:'Unavailable'},{status:paths?200:404});
  }
  missingLayouts.add(key);
  return Response.json({message:'Optional root listing unavailable in frozen evidence'},{status:404});
 }
 missingCount++;
 missing.set(key,{url,body});
 throw Error('Missing frozen response');
};
try {
 const {collect:oldCollect}=await import(pathToFileURL(githubPath).href) as {collect:typeof collect};
 const {score:oldScore}=await import(pathToFileURL(scorePath).href) as {score:typeof score};
 const rows=readdirSync(input).filter(f=>f.endsWith('.json')&&!f.includes('.pre-')).sort().map(f=>JSON.parse(readFileSync(resolve(input,f),'utf8'))).filter(r=>r.rate_guarded&&r.score_inputs);
 let count=0;
 for(const [index,row] of rows.entries()){
  const id=`sample-${String(index+1).padStart(3,'0')}`;
  const now=new Date(row.score_inputs.now);
  let scoreInputs:Parameters<NonNullable<CollectOptions['recordScoreInputs']>>[0]|undefined;
  const startMissing=missingCount;
  try{
   const before=await oldCollect(row.username,{now,deadlineMs:60_000});
   const after=await collect(row.username,{now,deadlineMs:60_000,recordScoreInputs:inputs=>{scoreInputs=inputs;}});
   if(missingCount!==startMissing)throw Error('Incomplete frozen evidence');
   writeFileSync(resolve(output,`${row.username.toLowerCase()}.json`),JSON.stringify({id,rate_guarded:true,candidate_hash:candidateHash,source_ref:baseline,username:row.username,score_inputs:scoreInputs,before:oldScore(before.metrics),after:score(after.metrics),before_metrics:before.metrics,after_metrics:after.metrics,recent_prs:after.recent_prs,top_repos:after.top_repos}));
   count++;
   console.log(id,'complete',count);
  }catch{console.log(id,'incomplete frozen evidence');}
 }
 if(process.env.V16_MISSING_INPUTS)writeFileSync(process.env.V16_MISSING_INPUTS,JSON.stringify([...missing.values()]));
 console.log(JSON.stringify({completed:count,missing_response_count:missing.size,missing_optional_layouts:missingLayouts.size,candidate_hash:candidateHash}));
 if(count<200)process.exitCode=1;
}finally{unlinkSync(scorePath);unlinkSync(githubPath);}
