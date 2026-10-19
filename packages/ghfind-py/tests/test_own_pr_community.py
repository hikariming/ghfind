"""v13 own-project community credit: 6·A·logRatio(own, 200) on top of v10."""

from __future__ import annotations

import json
from pathlib import Path

from ghfind._score import log_ratio, own_pr_community_credit, score

SCORE_FIXTURES = (
    Path(__file__).resolve().parents[3] / "src" / "lib" / "__tests__" / "score-fixtures.json"
)


def _neutral(**overrides):
    metrics = {
        "username": "x",
        "profile_url": None,
        "avatar_url": None,
        "name": "X",
        "bio": "dev",
        "company": None,
        "account_age_years": 5,
        "created_at": "2019-01-01T00:00:00Z",
        "followers": 50,
        "following": 30,
        "public_repos": 20,
        "fetched_repo_count": 20,
        "original_repo_count": 10,
        "nonempty_original_repo_count": 5,
        "fork_repo_count": 2,
        "empty_original_repo_count": 0,
        "total_stars": 100,
        "max_stars": 50,
        "merged_pr_count": 30,
        "total_pr_count": 35,
        "issues_created": 10,
        "last_year_contributions": 500,
        "activity_type_count": 3,
        "contribution_years_active": 3,
        "days_since_last_activity": 30,
        "recent_merged_pr_sample": 20,
        "recent_trivial_pr_count": 2,
        "external_trivial_pr_count": 0,
        "max_impact_repo_stars": 0,
        "impact_pr_count": 0,
        "impact_depth_raw": 0,
        "star_inflation_suspect": False,
        "closed_unmerged_pr_count": 2,
        "pr_rejection_rate": 0.06,
        "recent_pr_sample": 20,
        "top_repo_pr_target": "a/b",
        "top_repo_pr_share": 0.3,
        "templated_pr_ratio": 0.2,
        "pr_flood_suspect": False,
    }
    metrics.update(overrides)
    return metrics


def test_missing_external_count_keeps_v10():
    m = _neutral(own_pr_community=1, merged_pr_count=200)
    assert own_pr_community_credit(m) == 0
    assert score(m)["final_score"] == score(_neutral(merged_pr_count=200))["final_score"]


def test_zero_community_adds_nothing():
    m = _neutral(merged_pr_count=200, external_merged_pr_count=0, own_pr_community=0)
    assert own_pr_community_credit(m) == 0


def test_full_community_adds_six_and_never_decreases():
    assert (
        own_pr_community_credit(
            _neutral(merged_pr_count=200, external_merged_pr_count=0, own_pr_community=1)
        )
        == 6
    )
    base = _neutral(merged_pr_count=50, total_pr_count=55, external_merged_pr_count=0)
    with_community = {**base, "own_pr_community": 1}
    assert abs(own_pr_community_credit(with_community) - log_ratio(50, 200) * 6) < 1e-9
    v10 = score(base)
    v13 = score(with_community)
    assert v13["sub_scores"]["contribution_quality"] > v10["sub_scores"]["contribution_quality"]
    assert v13["final_score"] > v10["final_score"]
    assert v13["final_score"] - v10["final_score"] <= 6
    capped = _neutral(merged_pr_count=200, total_pr_count=210, external_merged_pr_count=0)
    assert score({**capped, "own_pr_community": 1})["final_score"] >= score(capped)["final_score"]


def test_scales_with_a_and_own_volume():
    half = own_pr_community_credit(
        _neutral(merged_pr_count=400, external_merged_pr_count=0, own_pr_community=0.5)
    )
    assert half == 3
    partial = own_pr_community_credit(
        _neutral(merged_pr_count=50, external_merged_pr_count=40, own_pr_community=1)
    )
    assert abs(partial - log_ratio(10, 200) * 6) < 1e-9


def test_score_fixtures_own_project_community():
    fixtures = json.loads(SCORE_FIXTURES.read_text(encoding="utf-8"))
    case = fixtures["own_project_community"]
    got = score(case["input"])
    assert got["sub_scores"] == case["expected"]["sub_scores"]
    assert got["base_score"] == case["expected"]["base_score"]
    assert got["final_score"] == case["expected"]["final_score"]
