from ghfind._score import score


def _base(**over):
    metrics = {
        "username": "risk-test", "profile_url": None, "avatar_url": None, "name": "Risk Test",
        "bio": "developer", "company": None, "account_age_years": 5, "created_at": "2021-01-01T00:00:00Z",
        "followers": 50, "following": 30, "public_repos": 20, "fetched_repo_count": 20,
        "original_repo_count": 10, "nonempty_original_repo_count": 5, "fork_repo_count": 2,
        "empty_original_repo_count": 0, "total_stars": 100, "max_stars": 50,
        "merged_pr_count": 30, "total_pr_count": 35, "issues_created": 10,
        "last_year_contributions": 500, "activity_type_count": 3, "contribution_years_active": 3,
        "days_since_last_activity": 30, "recent_merged_pr_sample": 20, "recent_trivial_pr_count": 2,
        "external_trivial_pr_count": 0, "max_impact_repo_stars": 0, "impact_pr_count": 0,
        "impact_depth_raw": 0, "star_inflation_suspect": False, "closed_unmerged_pr_count": 2,
        "pr_rejection_rate": 0.06, "recent_pr_sample": 20, "top_repo_pr_target": "someone/project",
        "top_repo_pr_share": 0.3, "templated_pr_ratio": 0.2, "pr_flood_suspect": False,
    }
    metrics.update(over)
    return metrics


def _flags(scoring):
    return {signal["flag"]: signal for signal in scoring["risk_assessment"]["signals"]}


def test_footprint_is_note_only():
    scoring = score(_base(
        account_age_years=0.5, public_repos=40, fetched_repo_count=40,
        original_repo_count=5, nonempty_original_repo_count=0, fork_repo_count=5,
        empty_original_repo_count=5, bio=None, followers=0, following=0,
        total_stars=0, max_stars=0, merged_pr_count=0, total_pr_count=0,
        last_year_contributions=0, activity_type_count=0, contribution_years_active=0,
        days_since_last_activity=None, recent_merged_pr_sample=0, recent_pr_sample=0,
    ))
    assert scoring["total_penalty"] == 0
    assert scoring["red_flags"] == []
    assert _flags(scoring)["no_original_work"]["disposition"] == "note"


def test_self_repository_flooding_is_ignored():
    scoring = score(_base(
        recent_merged_pr_sample=30, recent_pr_sample=30,
        top_repo_pr_share=1, templated_pr_ratio=1, pr_flood_suspect=False,
    ))
    assert scoring["total_penalty"] == 0
    assert scoring["red_flags"] == []
    assert "templated_pr_flooding" not in _flags(scoring)


def test_small_trivial_sample_is_note_only():
    scoring = score(_base(recent_merged_pr_sample=19, external_trivial_pr_count=15))
    assert scoring["total_penalty"] == 0
    assert _flags(scoring)["trivial_pr_farming"]["disposition"] == "note"


def test_template_requires_corroboration():
    template_only = score(_base(
        recent_pr_sample=30, top_repo_pr_share=1, templated_pr_ratio=1, pr_flood_suspect=True,
    ))
    assert template_only["total_penalty"] == 0
    assert _flags(template_only)["templated_pr_flooding"]["disposition"] == "note"

    corroborated = score(_base(
        recent_merged_pr_sample=30, external_trivial_pr_count=30,
        recent_pr_sample=30, top_repo_pr_share=1, templated_pr_ratio=1, pr_flood_suspect=True,
    ))
    assert corroborated["total_penalty"] > 0
    assert [flag["flag"] for flag in corroborated["red_flags"]] == [
        "trivial_pr_farming", "templated_pr_flooding",
    ]


def test_social_evidence_is_conjunctive_and_capped():
    single = score(_base(following=2000, followers=100))
    assert single["total_penalty"] == 0
    assert _flags(single)["follow_farming"]["disposition"] == "note"

    paired = score(_base(
        following=10_000, followers=0, star_inflation_suspect=True,
        max_stars=10_000, top_repo_engagement_ratio=0,
    ))
    assert 0 < paired["total_penalty"] <= 9


def test_missing_optional_metrics_never_penalize():
    scoring = score(_base(star_inflation_suspect=True, max_stars=2000))
    assert scoring["total_penalty"] == 0
    assert _flags(scoring)["possible_star_inflation"]["disposition"] == "note"


def test_all_families_remain_capped():
    scoring = score(_base(
        merged_pr_count=40, maintainer_closed_unmerged_pr_count=40,
        recent_merged_pr_sample=40, external_trivial_pr_count=40,
        recent_pr_sample=40, top_repo_pr_share=1, templated_pr_ratio=1, pr_flood_suspect=True,
        following=10_000, followers=0, star_inflation_suspect=True,
        max_stars=10_000, top_repo_engagement_ratio=0,
    ))
    assert scoring["total_penalty"] == 25
    assert scoring["risk_assessment"]["risk_score"] == 100
    assert scoring["risk_assessment"]["level"] == "high"
    assert sum(flag["penalty"] for flag in scoring["red_flags"]) == 25
