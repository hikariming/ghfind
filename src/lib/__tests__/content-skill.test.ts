import {describe,it,expect} from 'vitest';
import fixtures from './content-skill-fixtures.json';
import {contentSkillShare,contentSkillSignals,originalRepoStarWeight,weightedOriginalStars} from '../github';
import {originalProjectQuality} from '../score';
import type {RawMetrics} from '../types';
const now=new Date('2026-10-21T00:00:00Z');
describe('v16 continuous content evidence',()=>{
 for(const f of fixtures)it(f.name,()=>{
  expect(contentSkillShare(f.repo)).toBeCloseTo(f.share,12);
  expect(originalRepoStarWeight(f.repo,now)).toBeCloseTo(f.weight,12);
 });
 it('preserves substance and honors zero weighted stars',()=>{
  const m={nonempty_original_repo_count:1,total_stars:5000,max_stars:5000,best_original_repo_quality_score:1} as RawMetrics;
  expect(originalProjectQuality({...m,weighted_total_stars:0,weighted_max_stars:0})).toBe(6);
  const repo=fixtures[0].repo;
  expect(originalProjectQuality({...m,...weightedOriginalStars([repo],now),...contentSkillSignals([repo])})).toBeLessThan(originalProjectQuality(m)-5);
 });
 it('has no cliff at the historical 80 percent boundary',()=>{
  expect(Math.abs(fixtures[4].weight-fixtures[5].weight)).toBeLessThan(.003);
 });
});

import scoreFixtures from './content-skill-score-fixtures.json';
import {score} from '../score';
for(const f of scoreFixtures)it(`v16 score parity: ${f.name}`,()=>{
 const result=score(f.metrics as RawMetrics);
 expect(result.sub_scores).toEqual(f.expected.sub_scores);
 expect(result.final_score).toBe(f.expected.final_score);
 if(f.name==='fixture-skill-influencer')expect(result.final_score).toBeGreaterThanOrEqual(46);
 else expect(Math.abs(result.final_score-f.before_score)).toBeLessThanOrEqual(1.5);
});
