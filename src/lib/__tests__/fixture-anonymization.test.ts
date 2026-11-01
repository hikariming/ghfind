import {describe,it,expect} from 'vitest';
import {anonymizeScoreFixture} from '../../../scripts/lib/anonymize-score-fixture';
import presentation from './presentation-score-fixtures.json';
import impact from './impact-regression-fixtures.json';
import attributed from './attributed-impact-fixture.json';
describe('anonymous score snapshots',()=>{
 it('stores only fixture identities for recorded accounts',()=>{
  for(const f of [...presentation,...Object.values(impact),attributed]){
   expect(f.metrics.username).toMatch(/^fixture-/);
   expect(f.metrics.avatar_url ?? '').not.toMatch(/avatars\.githubusercontent/);
   expect(f.metrics.profile_url ?? '').not.toMatch(/github\.com\/(?!fixture-)/);
  }
 });
 it('removes identities before recording while preserving relationships and metrics',()=>{
  const input={metrics:{username:'fixture-private-input',total_stars:5000,avatar_url:'https://example.com/private',profile_url:'https://example.com/private'},repo:{owner_login:'fixture-private-input',repo:'fixture-private-input/skills',name:'fixture-private-input-2026'},user:{login:'fixture-private-input',id:123},user_id:123};
  const out=anonymizeScoreFixture(input,'fixture-public-sample');
  expect(JSON.stringify(out)).not.toContain('fixture-private-input');
  expect(out.metrics.total_stars).toBe(5000);
  expect(out.repo.repo).toBe('fixture-public-sample/skills');
  expect(out.user_id).toBeNull();
  expect(out.user.id).toBeNull();
  expect(out.repo.name).toBe("fixture-public-sample-2026");
 });
});
