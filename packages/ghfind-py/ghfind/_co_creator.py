"""Continuous leadership evidence; count alone never establishes authorship."""
import math

def unit(x):
    return max(0, min(1, x))

def smooth(x):
    x = unit(x)
    return x*x*(3-2*x)

def co_creator_share(f):
    commit_share = unit(f['user_commits']/max(1,f['total_commits']))
    rank = unit(f['user_commits']/max(1,f['leading_commits']))
    pr_share = unit(f['user_merged_prs']/max(1,f['total_merged_prs']))
    role = int(f.get('association') in ('OWNER','MEMBER','COLLABORATOR'))
    dominance = .5*math.sqrt(commit_share)+.2*rank+.3*math.sqrt(pr_share)
    identity = 1 if f.get('first_author') else .35+.2*role+.2*bool(f.get('release_author'))+.2*bool(f.get('maintainer_file'))+.05*bool(f.get('pinned'))
    work = 1-math.exp(-math.log1p(max(0,f['user_commits'])+3*max(0,f['user_merged_prs']))/2)
    tenure = .6+.4*(1-math.exp(-max(0,f['active_years'])/2))
    substance = (1-math.exp(-max(0,f['core_churn'])/200))*smooth(f['substantive_samples']/3)
    if f.get('first_author'):
        return substance*smooth(math.log1p(max(0,f['user_commits'])+3*max(0,f['user_merged_prs']))/math.log(101))*math.exp(-3*unit(f.get('inflation_severity',0)))
    confidence = max(0,f['samples'])/(max(0,f['samples'])+2)
    return smooth(dominance*identity*work*tenure*substance*confidence*math.exp(-3*unit(f.get('inflation_severity',0))))

def project_share(repo):
    return unit(repo.get('attribution_share',1))

def budget_co_creator_shares(repos):
    total = sum(project_share(r) for r in repos if not (r.get("co_creator_facts") or {}).get("first_author"))
    factor = 2*math.tanh(total/2)/total if total > 0 else 1
    return [{**r,'attribution_share':project_share(r)*(1 if (r.get('co_creator_facts') or {}).get('first_author') else factor)} for r in repos]
