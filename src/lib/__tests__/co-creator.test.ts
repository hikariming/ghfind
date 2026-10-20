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
 const result=computeOrgRepoAttribution({repo,organizations:[],scoredLogin:'maker',facts:c.facts,releaseOrTagAuthorHit:(c.facts as CoCreatorFacts).release_author,maintainerFileHit:(c.facts as CoCreatorFacts).maintainer_file,pinnedRepos:['person/project']});
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
 const impact=(share:number, stars=520)=>computeImpactFromContribMap([{...base,stars,attribution_share:share}], 'yifanxuaaa');
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
