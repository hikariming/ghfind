import json
from pathlib import Path
import pytest
from ghfind._co_creator import co_creator_share, budget_co_creator_shares
from ghfind._github import compute_org_repo_attribution
CASES=json.loads((Path(__file__).resolve().parents[3]/'src/lib/__tests__/co-creator-fixtures.json').read_text())
@pytest.mark.parametrize('case',CASES,ids=lambda c:c['name'])
def test_co_creator_evidence(case):
    assert co_creator_share(case['facts'])==pytest.approx(case['share'],abs=1e-12)
    repo=dict(repo=case.get('repo','person/project'),owner_login=case.get('owner','person'),is_fork=case.get('fork',False),is_private=case.get('private',False),topics=case.get('topics',[]),commits=583,prs=148,active_years=2)
    f=case['facts']
    result=compute_org_repo_attribution(repo,[],['person/project'],f.get('release_author',False),f.get('maintainer_file',False),'maker',None,f)
    if not case['eligible'] or not case['share']:
        assert result is None
    else:
        assert result['share']==pytest.approx(case['share'],abs=1e-12)

def test_co_creator_budget():
    assert sum(r['attribution_share'] for r in budget_co_creator_shares([dict(attribution_share=1)]*8))<2
    assert budget_co_creator_shares([dict(attribution_share=.99,co_creator_facts=dict(first_author=True))])[0]['attribution_share']==.99

from ghfind._score import low_prestige_bulk_contribution_cap
CAP_CASES=json.loads((Path(__file__).resolve().parents[3]/'src/lib/__tests__/contribution-cap-fixtures.json').read_text())
@pytest.mark.parametrize('case',CAP_CASES,ids=lambda c:c['name'])
def test_shared_cap_boundaries(case):
    assert low_prestige_bulk_contribution_cap(case['metrics']) == pytest.approx(case['expected'],abs=1e-10)
