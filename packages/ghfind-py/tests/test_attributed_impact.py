import json
from pathlib import Path
import pytest
from ghfind._github import compute_impact_from_contrib_map, is_ecosystem_impact_pr
from ghfind._community import compute_own_repo_community_facts, own_repo_community, own_pr_community_share
from ghfind._score import score

FIXTURES = Path(__file__).resolve().parents[3] / 'src/lib/__tests__'


def test_community_shared_fixtures():
    for f in json.loads((FIXTURES / 'community-fixtures.json').read_text()):
        facts = compute_own_repo_community_facts(f['raw'], f['context'])
        assert facts == f['expected_facts']
        assert own_repo_community(facts) == f['expected_community']


def test_yifan_oct18_replay():
    f = json.loads((FIXTURES / 'attributed-impact-fixture.json').read_text())
    facts = compute_own_repo_community_facts(f['raw'], f['context'])
    assert facts == f['expected_facts']
    r = dict(f['repo'], community_facts=facts, community=own_repo_community(facts))
    impact = compute_impact_from_contrib_map([r], 'fixture-account-070')
    assert impact['impact_prestige_score'] == .5417
    assert impact['impact_depth_raw'] == 1.83
    assert impact['impact_repos'][0]['repo'] == r['repo']
    before = score(f['metrics'])['final_score']
    assert before == 67.6
    metrics = dict(f['metrics'], **impact)
    metrics.update(impact_depth_raw=impact['impact_depth_raw'] + f['metrics']['impact_depth_raw'],
                   external_merged_pr_count=29, own_pr_community=own_pr_community_share([r], 'fixture-account-070', 79))
    after = score(metrics)
    assert after['final_score'] > before
    assert 2 < after['sub_scores']['ecosystem_impact'] <= 8.3


@pytest.mark.parametrize('overrides', [dict(forks=0)])
def test_no_empty_org_star_credit(overrides):
    f = json.loads((FIXTURES / 'attributed-impact-fixture.json').read_text())
    r = dict(f['repo'], **overrides)
    assert compute_impact_from_contrib_map([r], 'fixture-account-070')['impact_repo_count'] == 0
    assert not is_ecosystem_impact_pr(dict(repo=r['repo'], repo_stars=520, trivial=False), 'fixture-account-070', [r])
