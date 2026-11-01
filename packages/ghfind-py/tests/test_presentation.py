import json
from pathlib import Path
import pytest
from ghfind._presentation import presentation_signals, presentation_discount
CASES=json.loads((Path(__file__).resolve().parents[3]/'src/lib/__tests__/presentation-fixtures.json').read_text())
@pytest.mark.parametrize('case',CASES,ids=lambda c:c['name'])
def test_presentation_parity(case):
    signals=presentation_signals(case['prs'],'fixture-account-045',case['own_repos'])
    assert signals == pytest.approx(case['expected'],abs=1e-12)
    assert presentation_discount(signals) == pytest.approx(case['discount'],abs=1e-12)

from ghfind._score import score
SCORES=json.loads((Path(__file__).resolve().parents[3]/'src/lib/__tests__/presentation-score-fixtures.json').read_text())
@pytest.mark.parametrize('case',SCORES,ids=lambda c:c['name'])
def test_full_score_parity(case):
    result=score(case['metrics'])
    assert result['final_score'] == case['expected']['final_score']
    assert result['sub_scores'] == case['expected']['sub_scores']

from ghfind._github import impact_code_sample
def test_fractional_repository_credit():
    assert impact_code_sample(CASES[0]['prs']) == pytest.approx(dict(pr_sample=1,code_pr_sample=.9))

def test_legacy_ui_styles_remain_core():
    assert impact_code_sample([dict(title='fix styling',repo='patternfly/patternfly',files=['src/button.scss'])]) == dict(pr_sample=1,code_pr_sample=1)
