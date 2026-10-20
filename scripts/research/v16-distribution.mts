/** Offline paired v15/v16 replay. Identity-bearing inputs stay outside git;
 * public output contains stable anonymous IDs only. No network or DB writes. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {score,originalProjectQuality} from '../../src/lib/score';
import {weightedOriginalStars,contentSkillSignals,contentSkillShare,computeImpactFromContribMap,ownPrCommunityShare,bestOriginalRepoQuality,topStarredOriginalRepoQuality,type ContribRepoAgg} from '../../src/lib/github';
import type {RawMetrics,TopRepo} from '../../src/lib/types';
const directory=process.env.V16_SAMPLE_DIR;
if(!directory)throw Error('V16_SAMPLE_DIR required');
const baseline=process.env.V16_BASELINE_REF;
if(!baseline)throw Error('V16_BASELINE_REF must identify the v15 baseline');
const paired=process.env.V16_PAIRED==='1';
const candidateHash=createHash('sha256').update(['src/lib/github.ts','src/lib/score.ts','src/lib/presentation-concentration.ts','src/lib/co-creator.ts'].map(p=>readFileSync(p,'utf8')).join('\n')).digest('hex');
const temp=resolve(`src/lib/.v16-baseline-${process.pid}.ts`);
writeFileSync(temp,execFileSync('git',['show',`${baseline}:src/lib/score.ts`]));
try {
 const {score:oldScore}=await import(pathToFileURL(temp).href);
 const controls=new Set((process.env.V16_CONTROL_ACCOUNTS??'').toLowerCase().split(',').filter(Boolean));
 const patterns=new Set((process.env.V16_PATTERN_ACCOUNTS??'').toLowerCase().split(',').filter(Boolean));
 const rows=[];
 for(const file of readdirSync(directory).filter(f=>f.endsWith('.json')&&!f.includes('.pre-')).sort()){
  const row=JSON.parse(readFileSync(resolve(directory,file),'utf8'));
  if(!row.rate_guarded||!row.score_inputs?.star_repos)continue;
  const input=row.score_inputs, original:RawMetrics=row.after_metrics, now=new Date(input.now);
  const repos:TopRepo[]=input.star_repos;
  const personal=repos.filter(r=>!r.attributed_original);
  const m={...original,...weightedOriginalStars(repos,now),...contentSkillSignals(repos)};
  m.personal_original_project_quality_score=originalProjectQuality({...original,
   ...weightedOriginalStars(personal,now),...contentSkillSignals(personal),
   nonempty_original_repo_count:personal.filter(r=>r.size>0).length,
   total_stars:personal.reduce((n,r)=>n+r.stars,0),max_stars:Math.max(0,...personal.map(r=>r.stars)),
   best_original_repo_quality_score:bestOriginalRepoQuality(personal.slice(0,10),original.username.toLowerCase(),now).score,
   top_starred_original_repo_quality_score:topStarredOriginalRepoQuality(personal,original.username.toLowerCase(),now).score,
  });
  const impactRepos=input.contrib_repos.map((r: ContribRepoAgg)=>{
   const repo=repos.find(p=>(p.name_with_owner??`${p.owner_login}/${p.name}`).toLowerCase()===r.repo.toLowerCase());
   const share=repo?contentSkillShare(repo):0;
   return {...r,content_skill_share:share,community:r.community==null?undefined:r.community*(1-.75*share*share*(3-2*share))};
  });
  Object.assign(m,computeImpactFromContribMap(impactRepos,original.username.toLowerCase()));
  if(original.external_merged_pr_count != null) m.own_pr_community=ownPrCommunityShare(impactRepos,original.username.toLowerCase(),original.merged_pr_count-original.external_merged_pr_count);
  if(paired && row.candidate_hash!==candidateHash)throw Error('Paired replay does not match current source');
  const before=paired?row.before:oldScore(original),after=score(paired?row.after_metrics:m);
  rows.push({id:row.id??`sample-${String(rows.length+1).padStart(3,'0')}`,control:controls.has(original.username.toLowerCase()),pattern:patterns.has(original.username.toLowerCase()),before:before.final_score,after:after.final_score,delta:Math.round((after.final_score-before.final_score)*10)/10,original_before:before.sub_scores.original_project_quality,original_after:after.sub_scores.original_project_quality,share:(paired?row.after_metrics:m).content_skill_star_share});
 }
 const deltas=rows.map(r=>r.delta).sort((a,b)=>a-b);
 const median=deltas[Math.floor(deltas.length/2)];
 const controlRows=rows.filter(r=>r.control), patternRows=rows.filter(r=>r.pattern);
 const unexpected=rows.filter(r=>!r.pattern&&Math.abs(r.delta)>=2.5);
 const result={mode:paired?"paired-collector":"exploratory-metrics",count:rows.length,median,gate:paired&&rows.length>=200&&Math.abs(median)<=1&&controlRows.length>0&&patternRows.length>0&&controlRows.every(r=>Math.abs(r.delta)<=1.5)&&patternRows.every(r=>r.after>=46&&r.after<=50)&&unexpected.length===0,unexpected,controls:rows.filter(r=>r.control),patterns:rows.filter(r=>r.pattern),risers:[...rows].sort((a,b)=>b.delta-a.delta).slice(0,10),decliners:[...rows].sort((a,b)=>a.delta-b.delta).slice(0,10),rows};
 writeFileSync(process.env.V16_OUTPUT??'/tmp/v16-distribution.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({...result,rows:undefined},null,2));
} finally {unlinkSync(temp)}
