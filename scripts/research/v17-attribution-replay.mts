/** Offline v16 → v17 attribution replay over frozen v16 paired-collector records.
 * Recomputes co-creator shares from stored facts (new recent/review facts are
 * absent there, so maintenance evidence is neutral), the share budget, credited
 * stars, top-starred quality and ecosystem allocation. Identity-bearing inputs
 * stay outside git; output carries stable anonymous IDs only. No network/DB. */
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {score} from '../../src/lib/score';
import {coCreatorShare,budgetCoCreatorShares,projectShare,type CoCreatorFacts} from '../../src/lib/co-creator';
import {weightedOriginalStars,contentSkillSignals,contentSkillShare,computeImpactFromContribMap,ownPrCommunityShare,topStarredOriginalRepoQuality,originalRepoQualityScore,type ContribRepoAgg} from '../../src/lib/github';
import type {RawMetrics,TopRepo} from '../../src/lib/types';
const directory=process.env.V17_SAMPLE_DIR;
if(!directory)throw Error('V17_SAMPLE_DIR required');
const salt=process.env.V17_ID_SALT??'v17';
const controls=new Set((process.env.V17_CONTROL_ACCOUNTS??'').toLowerCase().split(',').filter(Boolean));
const anon=(login:string)=>'sample-'+createHash('sha256').update(salt+login.toLowerCase()).digest('hex').slice(0,8);
const key=(r:{name_with_owner?:string|null;owner_login?:string|null;name?:string;repo?:string})=>(r.repo??r.name_with_owner??`${r.owner_login}/${r.name}`).toLowerCase();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- frozen replay JSON rows
function metricsFor(row:any, repos:TopRepo[], v16Quality:boolean): RawMetrics {
 const input=row.score_inputs, original:RawMetrics=row.after_metrics, now=new Date(input.now), login=original.username.toLowerCase();
 const shares=new Map(repos.filter(r=>r.attributed_original).map(r=>[key(r),r.attribution_share]));
 let top=topStarredOriginalRepoQuality(repos,login,now).score;
 if(v16Quality){
  const t=repos.filter(r=>r.stars>0).sort((a,b)=>b.stars*projectShare(b)-a.stars*projectShare(a))[0];
  top=t?originalRepoQualityScore(t,login,now)*projectShare(t):0;
 }
 const m={...original,...weightedOriginalStars(repos,now),...contentSkillSignals(repos),top_starred_original_repo_quality_score:top};
 const impactRepos=input.contrib_repos.map((r: ContribRepoAgg)=>{
  const repo=repos.find(p=>key(p)===r.repo.toLowerCase());
  const share=repo?contentSkillShare(repo):0;
  return {...r,attribution_share:shares.has(r.repo.toLowerCase())?shares.get(r.repo.toLowerCase()):r.attribution_share,content_skill_share:share,
   community:r.community==null?undefined:r.community*(1-.75*share*share*(3-2*share))};
 });
 Object.assign(m,computeImpactFromContribMap(impactRepos,login));
 if(original.external_merged_pr_count != null) m.own_pr_community=ownPrCommunityShare(impactRepos,login,original.merged_pr_count-original.external_merged_pr_count);
 return m;
}
const rows=[];
for(const file of readdirSync(directory).filter(f=>f.endsWith('.json')&&!f.includes('.pre-')).sort()){
 const row=JSON.parse(readFileSync(resolve(directory,file),'utf8'));
 if(!row.rate_guarded||!row.score_inputs?.star_repos)continue;
 const repos:TopRepo[]=row.score_inputs.star_repos;
 const attributed=repos.filter(r=>r.attributed_original&&r.co_creator_facts);
 const rescored=budgetCoCreatorShares(attributed.map(r=>({...r,attribution_share:coCreatorShare(r.co_creator_facts as CoCreatorFacts)})));
 const next=repos.map(r=>rescored.find(x=>key(x)===key(r))??r);
 const before=score(metricsFor(row,repos,true)), after=score(metricsFor(row,next,false));
 const login=row.after_metrics.username;
 rows.push({id:anon(login),control:controls.has(login.toLowerCase()),attributed:attributed.length,
  v16_paired:row.after.final_score,before:before.final_score,after:after.final_score,
  delta:Math.round((after.final_score-before.final_score)*10)/10,
  original_before:before.sub_scores.original_project_quality,original_after:after.sub_scores.original_project_quality,
  ecosystem_before:before.sub_scores.ecosystem_impact,ecosystem_after:after.sub_scores.ecosystem_impact,
  share_before:attributed.map(r=>Math.round((r.attribution_share??0)*1000)/1000),share_after:rescored.map(r=>Math.round((r.attribution_share??0)*1000)/1000)});
}
const abs=(x:number)=>Math.abs(x), med=(xs:number[])=>{const s=[...xs].sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]:0;};
const attributedRows=rows.filter(r=>r.attributed>0);
const result={count:rows.length,attributed:attributedRows.length,
 pipeline_noise_max:Math.max(0,...rows.map(r=>abs(Math.round((r.before-r.v16_paired)*10)/10))),
 median_delta:med(rows.map(r=>r.delta)),median_abs_delta:med(rows.map(r=>abs(r.delta))),
 median_delta_attributed:med(attributedRows.map(r=>r.delta)),
 increased:rows.filter(r=>r.delta>0).length,decreased:rows.filter(r=>r.delta<0).length,unchanged:rows.filter(r=>r.delta===0).length,
 large:rows.filter(r=>abs(r.delta)>=2.5).length,
 controls:rows.filter(r=>r.control).map(r=>({id:r.id,delta:r.delta})),
 risers:[...rows].sort((a,b)=>b.delta-a.delta).slice(0,10),decliners:[...rows].sort((a,b)=>a.delta-b.delta).slice(0,5)};
writeFileSync(process.env.V17_OUTPUT??'/tmp/v17-attribution-replay.json',JSON.stringify({...result,rows},null,2)+'\n');
console.log(JSON.stringify(result,null,1));
