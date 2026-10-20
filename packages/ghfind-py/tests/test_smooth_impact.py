import json
from pathlib import Path
import pytest
from ghfind._github import compute_impact_from_contrib_map
from ghfind._community import attributed_creator_weight, impact_evidence_weight, impact_star_discount, own_star_weight

FIXTURES = json.loads((Path(__file__).resolve().parents[3] / 'src/lib/__tests__/smooth-impact-fixtures.json').read_text())

@pytest.mark.parametrize('f', FIXTURES, ids=lambda f: f['name'])
def test_shared_curve(f):
    r, e = f['repo'], f['expected']
    assert attributed_creator_weight(r, 'fixture-account-045') == pytest.approx(e['weight'], abs=1e-12)
    assert impact_evidence_weight(r) == pytest.approx(e['evidence'], abs=1e-12)
    assert impact_star_discount(r) == pytest.approx(e['discount'], abs=1e-12)
    assert own_star_weight(r['stars']) == pytest.approx(e['star_weight'], abs=1e-12)
    actual = compute_impact_from_contrib_map([r], 'fixture-account-045')
    for k in ['impact_prestige_score', 'impact_depth_raw', 'impact_repo_count']:
        assert actual[k] == e[k]

def test_monotonicity_continuity_and_diminishing_evidence():
    base = FIXTURES[0]['repo']
    for field in ['forks', 'outside_merged_prs']:
        prev = dict(impact_prestige_score=0, impact_depth_raw=0)
        last_weight, last_gain = 0, 1
        for n in range(1001):
            r = dict(base, forks=n if field == 'forks' else 0,
                     community_facts=dict(base['community_facts'], **{field:n}))
            cur = compute_impact_from_contrib_map([r], 'fixture-account-045')
            assert cur['impact_prestige_score'] >= prev['impact_prestige_score']
            assert cur['impact_depth_raw'] >= prev['impact_depth_raw']
            weight = impact_evidence_weight(r)
            gain = weight - last_weight
            if n: assert gain <= last_gain + 1e-12
            last_gain, last_weight, prev = gain if n else 1, weight, cur
    for field, gate in [('outside_merged_prs', 1), ('forks', 10)]:
        values = [attributed_creator_weight(dict(base, forks=n if field == 'forks' else 0,
                  community_facts=dict(base['community_facts'], **{field:n})), 'fixture-account-045') for n in [gate-.001,gate+.001]]
        assert abs(values[1]-values[0]) < .002
    for gate in [200,1000]:
        a,b = [compute_impact_from_contrib_map([dict(base, stars=gate+d, forks=33)], 'fixture-account-045') for d in [-1,1]]
        assert abs(a['impact_prestige_score']-b['impact_prestige_score']) < .002
        assert abs(a['impact_depth_raw']-b['impact_depth_raw']) < .02

def test_diminishing_star_farming():
    from ghfind._score import log_ratio
    for severity in [0, .9]:
        rows = [f['repo'] for f in FIXTURES if f['name'].startswith('farm-stars-') and f['repo']['star_inflation_severity'] == severity]
        values = [attributed_creator_weight(r, 'fixture-account-045') * log_ratio(r['stars'], 100000) for r in rows]
        assert values[2]-values[1] < values[1]-values[0]
        assert values[3]-values[2] < values[2]-values[1]
        if severity: assert values[3] < .002
