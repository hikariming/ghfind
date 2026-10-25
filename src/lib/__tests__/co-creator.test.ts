import {expect,it} from 'vitest';
import cases from './co-creator-fixtures.json';
import {coCreatorShare,budgetCoCreatorShares,type CoCreatorFacts} from '../co-creator';
import {computeOrgRepoAttribution,computeImpactFromContribMap,type ContribRepoAgg} from '../github';
import {lowPrestigeBulkContributionCap} from '../score';
import fixture from './attributed-impact-fixture.json';
import type {RawMetrics} from '../types';
it.each(cases)('continuous co-creator evidence: $name',c=>{
 expect(coCreatorShare(c.facts)).toBeCloseTo(c.share,12);
 const row=c as typeof c & {owner?:string;repo?:string;fork?:boolean;private?:boolean;topics?:string[]};
 const repo={...fixture.repo,repo:row.repo??'person/project',owner_login:row.owner??'person',is_fork:row.fork??false,is_private:row.private??false,topics:row.topics??[]} as ContribRepoAgg;
 const result=computeOrgRepoAttribution({repo,organizations:[],scoredLogin:'fixture-account-045',facts:c.facts,releaseOrTagAuthorHit:(c.facts as CoCreatorFacts).release_author,maintainerFileHit:(c.facts as CoCreatorFacts).maintainer_file,pinnedRepos:['person/project']});
 if(!c.eligible||c.share===0)expect(result).toBeNull();else expect(result?.share).toBeCloseTo(c.share,12);
});
it('bounds combined co-built shares while retaining founding provenance',()=>{
 const co=budgetCoCreatorShares(Array.from({length:8},()=>({attribution_share:1})));
 expect(co.reduce((s,r)=>s+(r.attribution_share??0),0)).toBeLessThan(2);
 expect(budgetCoCreatorShares([{attribution_share:.99,co_creator_facts:{first_author:true} as CoCreatorFacts}])[0].attribution_share).toBe(.99);
});
it('smooths prestige, PR-volume and project-star cap boundaries',()=>{
 const m={...fixture.metrics,merged_pr_count:100,max_stars:1,impact_prestige_score:.55,core_impact_pr_count:88} as RawMetrics;
 expect(lowPrestigeBulkContributionCap({...m,merged_pr_count:255})).toBeCloseTo(23.74,8);
 for(const [key,points] of [['merged_pr_count',[40,80,120]],['max_stars',[950,1000,1050]],['impact_prestige_score',[.3,.65,.8]]] as const){
  for(const point of points){const a=lowPrestigeBulkContributionCap({...m,[key]:point-1e-5})!;const b=lowPrestigeBulkContributionCap({...m,[key]:point+1e-5})!;expect(Math.abs(a-b)).toBeLessThan(.001);}
 }
});
it('substantial founding code survives a recent documentation-heavy sample',()=>{
 const facts={...cases[0].facts,first_author:true,core_churn:1240,sampled_churn:10672,substantive_samples:4,samples:6};
 expect(coCreatorShare(facts)).toBeGreaterThan(.99);
 expect(coCreatorShare({...facts,core_churn:0,substantive_samples:0})).toBe(0);
});

it('allocates ecosystem credit between own and external channels without double counting', () => {
 const base={...fixture.repo,community:.2,attributed_original:true} as ContribRepoAgg;
 const impact=(share:number, stars=520)=>computeImpactFromContribMap([{...base,stars,attribution_share:share}], 'fixture-account-070');
 const own=impact(1), external=impact(0), half=impact(.5);
 expect(half.impact_prestige_score).toBeCloseTo((own.impact_prestige_score+external.impact_prestige_score)/2,3);
 expect(half.impact_depth_raw).toBeCloseTo((own.impact_depth_raw+external.impact_depth_raw)/2,1);
 expect(half.impact_depth_raw).toBeLessThan(own.impact_depth_raw+external.impact_depth_raw);
 const lowOwn=impact(1,100),lowHalf=impact(.5,100);
 expect(lowHalf.impact_depth_raw).toBeCloseTo(lowOwn.impact_depth_raw/2,1);
});

import capCases from './contribution-cap-fixtures.json';
it.each(capCases)('shared continuous cap: $name', ({metrics, expected}) => {
 expect(lowPrestigeBulkContributionCap(metrics as RawMetrics)).toBeCloseTo(expected, 10);
});
it('keeps the cap bounded and nondecreasing with prestige across core levels', () => {
 for(const core of [0,40,70,100]){
  let previous=0;
  for(let i=0;i<=100;i++){
   const cap=lowPrestigeBulkContributionCap({...fixture.metrics,merged_pr_count:150,max_stars:0,impact_prestige_score:i/100,core_impact_pr_count:core})!;
   expect(cap).toBeGreaterThanOrEqual(20);
   expect(cap).toBeLessThanOrEqual(27);
   expect(cap).toBeGreaterThanOrEqual(previous);
   previous=cap;
  }
 }
});

import contentFx from './contribution-content-fixtures.json';
import {weightedCoreChurn,summarizeContributors} from '../co-creator';
it.each(contentFx.churn)('content-weighted core churn: $name',c=>{
 expect(weightedCoreChurn(c.files,c.repo)).toEqual(c.expected);
});
it.each(contentFx.contributors)('bot-free contributor totals: $name',c=>{
 expect(summarizeContributors(c.rows,c.login,{truncated:c.truncated,historyTotal:c.history_total,fallbackUserCommits:c.fallback_user_commits})).toEqual(c.expected);
});
it('credits maintenance, content and co-maintenance roles without hardcoding anyone',()=>{
 const share=(name:string)=>coCreatorShare(cases.find(c=>c.name===name)!.facts as CoCreatorFacts);
 // Current primary maintainer with a low lifetime share gets lead-level credit.
 expect(share('current-primary-maintainer-low-lifetime-share')).toBeGreaterThan(.5);
 expect(share('current-primary-maintainer-low-lifetime-share')).toBeGreaterThan(3*share('same-low-lifetime-share-without-recent-maintenance'));
 // Few commits with large core PRs earn major credit; lockfile/format diffs earn none.
 expect(share('few-commits-large-core-feature-prs')).toBeGreaterThan(.1);
 expect(share('few-commits-lockfile-format-only-diffs')).toBe(0);
 expect(share('co-maintainer-product-repo')).toBeGreaterThan(.3);
 // Incidental PRs into a large repository stay ecosystem impact, not lead credit.
 expect(share('incidental-prs-into-large-repo')).toBeLessThan(.01);
 // Star-farm discount stays strong.
 expect(share('inflated-stars-continuous-discount')).toBeLessThan(.01);
});
it('has no cliff around the role fade threshold',()=>{
 const base=cases.find(c=>c.name==='co-maintainer-product-repo')!.facts as CoCreatorFacts;
 let previous=-1;
 for(let commits=1;commits<=600;commits++){
  const value=coCreatorShare({...base,user_commits:commits});
  expect(value).toBeGreaterThanOrEqual(previous-1e-12);
  if(previous>=0)expect(value-previous).toBeLessThan(.02);
  previous=value;
 }
});

import {topStarredOriginalRepoQuality} from '../github';
import type {TopRepo} from '../types';
it('keeps dotfiles, profile README and awesome-list guards while not double-counting co-built shares',()=>{
 const now=new Date('2026-10-01T00:00:00Z');
 const repo=(over:Partial<TopRepo>)=>({name:'app-y',owner_login:'user-a',name_with_owner:'user-a/app-y',stars:800,forks:2,open_issues:0,size:40,language:null,description:'',pushed_at:'2026-09-01T00:00:00Z',topics:[],...over}) as TopRepo;
 for(const guard of [
  repo({name:'dotfiles',name_with_owner:'user-a/dotfiles',description:'my config files'}),
  repo({name:'user-a',name_with_owner:'user-a/user-a',readme_excerpt:'Hi there, profile README with badges.'}),
  repo({name:'awesome-tools',name_with_owner:'user-a/awesome-tools',topics:['awesome','list'],language:null}),
 ]) expect(topStarredOriginalRepoQuality([guard],'user-a',now).score).toBeLessThan(.5);
 const product=repo({name:'app-y',owner_login:'org-x',name_with_owner:'org-x/app-y',size:9000,language:'TypeScript',description:'Production scheduling service with API and dashboard',stars:3000,forks:300,open_issues:40,attributed_original:true});
 const full=topStarredOriginalRepoQuality([{...product,attribution_share:1}],'user-a',now).score;
 expect(full).toBeGreaterThan(.5);
 expect(topStarredOriginalRepoQuality([{...product,attribution_share:.3}],'user-a',now).score).toBe(full);
});
