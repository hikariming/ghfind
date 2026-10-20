import { expect, it } from "vitest";
import { presentationDiscount, presentationSignals, prPresentationShare, ecosystemPresentationDiscount } from "../presentation-concentration";
import { score } from "../score";
import { attributedCreatorWeight, type ContribRepoAgg } from "../github";
import type { RawMetrics, RecentPr } from "../types";
import fixture from "./attributed-impact-fixture.json";
import cases from "./presentation-fixtures.json";

it.each(cases)("continuous presentation parity: $name", c => {
  const signals = presentationSignals(c.prs as RecentPr[], "maker", c.own_repos);
  for (const [key,value] of Object.entries(c.expected)) expect(signals[key as keyof typeof signals]).toBeCloseTo(value,12);
  expect(presentationDiscount(signals as RawMetrics)).toBeCloseTo(c.discount,12);
});
it("has continuous thresholds, bounded influence and core/sample protection",()=>{
 const base={presentation_churn_share:.8,presentation_repo_concentration:1,presentation_pr_sample:50,presentation_core_pr_count:0} as RawMetrics;
 expect(presentationDiscount({...base,presentation_churn_share:.4})).toBe(1);
 expect(presentationDiscount({...base,presentation_churn_share:.400001})).toBeCloseTo(1,9);
 expect(presentationDiscount(base)).toBeGreaterThanOrEqual(.3);
 expect(presentationDiscount({...base,presentation_pr_sample:1})).toBeGreaterThan(presentationDiscount(base));
 expect(presentationDiscount({...base,presentation_core_pr_count:20})).toBeGreaterThan(.94);
 expect(ecosystemPresentationDiscount({...base,merged_pr_count:100,external_merged_pr_count:0})).toBe(1);
});
it("keeps author self-closure neutral at every volume",()=>{
 const m={...fixture.metrics,external_merged_pr_count:29,maintainer_closed_unmerged_pr_count:2,presentation_churn_share:.9,presentation_repo_concentration:1,presentation_pr_sample:50,presentation_core_pr_count:0} as RawMetrics;
 for(const n of [0,1,20,10000]) expect(score({...m,self_closed_external_pr_count:n,self_closed_own_repo_pr_count:n})).toEqual(score({...m,self_closed_external_pr_count:0,self_closed_own_repo_pr_count:0}));
});
it("uses changed lines, not a documentation title or file count",()=>{
 const pr={title:'docs: change website',repo:'org/engine',changed_files:2,file_changes:[{path:'src/main.ts',additions:900,deletions:0},{path:'README.md',additions:100,deletions:0}]} as RecentPr;
 expect(prPresentationShare(pr)).toBe(.1);
});
it("one external merge is stronger than ten forks across star scales",()=>{
 for(const stars of [100,520,1000,10000]) {
 const base={...fixture.repo,repo:'org/tool',owner_login:'org',stars,attributed_original:true,attribution_evidence:['first commit author is maker','release/tag author']} as ContribRepoAgg;
 const weight=(prs:number,forks:number)=>attributedCreatorWeight({...base,forks,community_facts:{outside_merged_prs:prs,forks} as ContribRepoAgg['community_facts']},'maker');
 expect(weight(1,0)).toBeGreaterThan(weight(0,10));
 expect(weight(1,0)).toBeGreaterThan(.72);
 expect(weight(1,0)).toBeLessThan(.79);
 }
});

import scoreFixtures from "./presentation-score-fixtures.json";
it.each(scoreFixtures)("full v15 scoring parity: $name", ({metrics, expected}) => {
  expect(score(metrics as unknown as RawMetrics)).toMatchObject(expected);
});

import { impactCodeSample } from "../github";
it("uses fractional core credit inside repository aggregation", () => {
  expect(impactCodeSample(cases[0].prs as RecentPr[])).toEqual({pr_sample: 1, code_pr_sample: .9});
});

it("keeps UI product styles core in legacy path-only samples too", () => {
  const pr = {title: "fix styling", repo: "patternfly/patternfly", files: ["src/button.scss"]} as RecentPr;
  expect(impactCodeSample([pr])).toEqual({pr_sample: 1, code_pr_sample: 1});
});
