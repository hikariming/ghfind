/** Public evidence only. Missing evidence contributes zero, never an inferred role. */
export interface CoCreatorFacts {
  user_commits: number;
  total_commits: number;
  leading_commits: number;
  user_merged_prs: number;
  total_merged_prs: number;
  active_years: number;
  core_churn: number;
  sampled_churn: number;
  substantive_samples: number;
  samples: number;
  association?: string;
  first_author?: boolean;
  release_author?: boolean;
  maintainer_file?: boolean;
  pinned?: boolean;
  inflation_severity?: number;
}

export const unit = (x: number) => Math.max(0, Math.min(1, x));
export function smoothUnit(x: number): number { x = unit(x); return x*x*(3-2*x); }

/** Count alone cannot establish leadership: meaningful implementation is required. */
export function coCreatorShare(f: CoCreatorFacts): number {
  const commitShare = unit(f.user_commits / Math.max(1, f.total_commits));
  const rank = unit(f.user_commits / Math.max(1, f.leading_commits));
  const prShare = unit(f.user_merged_prs / Math.max(1, f.total_merged_prs));
  const role = /^(OWNER|MEMBER|COLLABORATOR)$/.test(f.association ?? "") ? 1 : 0;
  const dominance = .5 * Math.sqrt(commitShare) + .2 * rank + .3 * Math.sqrt(prShare);
  const identity = f.first_author ? 1 : .35 + .2*role + .2*Number(Boolean(f.release_author))
    + .2*Number(Boolean(f.maintainer_file)) + .05*Number(Boolean(f.pinned));
  const work = 1 - Math.exp(-Math.log1p(Math.max(0, f.user_commits) + 3*Math.max(0, f.user_merged_prs))/2);
  const tenure = .6 + .4*(1-Math.exp(-Math.max(0, f.active_years)/2));
  const substance = (1-Math.exp(-Math.max(0, f.core_churn)/200)) *
    smoothUnit(f.substantive_samples/3);
  const inflation = Math.exp(-3*unit(f.inflation_severity ?? 0));
  // Founding authorship is a distinct provenance fact. Recent documentation
  // does not revoke it; meaningful code and sustained work still gate credit.
  if (f.first_author) return substance * smoothUnit(
    Math.log1p(Math.max(0,f.user_commits)+3*Math.max(0,f.user_merged_prs))/Math.log(101),
  ) * inflation;
  const confidence = Math.max(0, f.samples)/(Math.max(0, f.samples)+2);
  return smoothUnit(dominance*identity*work*tenure*substance*confidence *
    inflation);
}

/** Legacy attributed snapshots retain their historical full-share interpretation. */
export function projectShare(repo: { attribution_share?: number }): number {
  return unit(repo.attribution_share ?? 1);
}

/** Eight candidates maximum, with a smooth total-share budget below two projects. */
export function budgetCoCreatorShares<T extends { attribution_share?: number; co_creator_facts?: CoCreatorFacts }>(repos: T[]): T[] {
  const total = repos.reduce((sum, repo) => sum + (repo.co_creator_facts?.first_author ? 0 : projectShare(repo)), 0);
  const multiplier = total > 0 ? 2*Math.tanh(total/2)/total : 1;
  return repos.map(repo => ({...repo, attribution_share: projectShare(repo)*(repo.co_creator_facts?.first_author ? 1 : multiplier)}));
}
