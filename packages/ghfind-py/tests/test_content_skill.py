import json
from pathlib import Path
from datetime import datetime, timezone
import pytest
from ghfind._github import content_skill_share, original_repo_star_weight
from ghfind._score import original_project_quality
CASES = json.loads((Path(__file__).resolve().parents[3] / 'src/lib/__tests__/content-skill-fixtures.json').read_text())
@pytest.mark.parametrize('case', CASES, ids=lambda c:c['name'])
def test_content_skill_parity(case):
    assert content_skill_share(case['repo']) == pytest.approx(case['share'],abs=1e-12)
    assert original_repo_star_weight(case['repo'],datetime(2026,10,21,tzinfo=timezone.utc)) == pytest.approx(case['weight'],abs=1e-12)
def test_zero_weighted_stars_preserve_substance():
    assert original_project_quality(dict(nonempty_original_repo_count=1,total_stars=5000,max_stars=5000,weighted_total_stars=0,weighted_max_stars=0,best_original_repo_quality_score=1)) == 6

from ghfind._score import score
SCORES = json.loads((Path(__file__).resolve().parents[3] / 'src/lib/__tests__/content-skill-score-fixtures.json').read_text())
@pytest.mark.parametrize('case', SCORES, ids=lambda c:c['name'])
def test_content_score_parity(case):
    result = score(case['metrics'])
    assert result['final_score'] == case['expected']['final_score']
    assert result['sub_scores'] == case['expected']['sub_scores']
