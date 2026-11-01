"""Shared fictitious v18 score/cap goldens and adoption invariants; offline only."""
import json
from pathlib import Path

import pytest

from ghfind._score import low_prestige_bulk_contribution_cap, score

FIXTURES = json.loads((Path(__file__).resolve().parents[3] / "src/lib/__tests__/contribution-quality-fixtures.json").read_text())


@pytest.mark.parametrize("case", FIXTURES, ids=[c["metrics"]["username"] for c in FIXTURES])
def test_shared_contribution_golden(case):
    got, want = score(case["metrics"]), case["expected"]
    for key in ["sub_scores", "base_score", "final_score", "total_penalty", "tier", "red_flags"]:
        assert got[key] == want[key]
    assert low_prestige_bulk_contribution_cap(case["metrics"]) == pytest.approx(case["cap"], abs=1e-12)


def test_stars_cannot_bypass_and_unknown_is_not_zero():
    base = FIXTURES[0]["metrics"]
    for stars in [0, 950, 1000, 1050, 2507, 1000000]:
        quality = score(dict(base, max_stars=stars))["sub_scores"]["contribution_quality"]
        assert 19 <= quality <= 20
    unknown = dict(base)
    unknown.pop("external_merged_pr_count")
    assert low_prestige_bulk_contribution_cap(dict(base, external_merged_pr_count=None)) == low_prestige_bulk_contribution_cap(unknown)
    assert low_prestige_bulk_contribution_cap(unknown) == pytest.approx(21.944)
    for n in [0, 1, 22, 10000]:
        assert score(dict(base, self_closed_external_pr_count=n, self_closed_own_repo_pr_count=n)) == score(base)


def test_adoption_cap_is_monotone_and_diminishing():
    base = dict(FIXTURES[0]["metrics"], merged_pr_count=1000, impact_prestige_score=1)
    caps = [low_prestige_bulk_contribution_cap(dict(base, external_merged_pr_count=n)) for n in [0, 80, 160, 320, 600, 1000]]
    assert caps == sorted(caps)
    assert caps[2]-caps[1] < caps[1]-caps[0]
    assert caps[0] == 20
    assert caps[-1] <= 27
