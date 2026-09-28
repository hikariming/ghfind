"""Local scoring: offline unit tests + a token-gated live integration test.

The bit-exact score parity lives in test_score_parity.py (offline). Here we cover
the local module's own surface and a real end-to-end crawl when a token is present.
"""

import os

import pytest

from ghfind._github import compute_impact_from_contrib_map
from ghfind.local import collect_and_score, score_metrics, GitHubAuthRequiredError


def _empty_metrics(**over):
    m = {
        "username": "test", "profile_url": None, "avatar_url": None, "name": None,
        "bio": None, "company": None, "account_age_years": 0, "created_at": None,
        "followers": 0, "following": 0, "public_repos": 0, "fetched_repo_count": 0,
        "original_repo_count": 0, "nonempty_original_repo_count": 0, "fork_repo_count": 0,
        "empty_original_repo_count": 0, "total_stars": 0, "max_stars": 0,
        "merged_pr_count": 0, "total_pr_count": 0, "issues_created": 0,
        "last_year_contributions": 0, "activity_type_count": 0, "contribution_years_active": 0,
        "days_since_last_activity": None, "recent_merged_pr_sample": 0, "recent_trivial_pr_count": 0,
        "external_trivial_pr_count": 0, "max_impact_repo_stars": 0, "impact_pr_count": 0,
        "impact_depth_raw": 0, "star_inflation_suspect": False, "closed_unmerged_pr_count": 0,
        "pr_rejection_rate": 0, "recent_pr_sample": 0, "top_repo_pr_target": None,
        "top_repo_pr_share": 0, "templated_pr_ratio": 0, "pr_flood_suspect": False,
    }
    m.update(over)
    return m


def test_score_metrics_full_scoring():
    s = score_metrics(_empty_metrics())
    assert "final_score" in s and "tier" in s and "sub_scores" in s
    assert 0 <= s["final_score"] <= 100
    assert "contribution_quality" in s["sub_scores"]


def test_score_metrics_deterministic():
    m = _empty_metrics(followers=500, total_stars=3000, merged_pr_count=40)
    assert score_metrics(m)["final_score"] == score_metrics(m)["final_score"]


def test_collect_and_score_requires_token():
    prev = os.environ.pop("GITHUB_TOKEN", None)
    try:
        with pytest.raises(GitHubAuthRequiredError):
            collect_and_score("torvalds")
    finally:
        if prev is not None:
            os.environ["GITHUB_TOKEN"] = prev


def test_git_git_single_default_branch_commit_counts_as_ecosystem_impact():
    base = {
        "stars": 61828,
        "is_private": False,
        "is_fork": False,
        "commits": 1,
        "prs": 0,
        "active_years": 1,
    }
    impact = compute_impact_from_contrib_map(
        [
            {**base, "repo": "git/git", "owner_login": "git"},
            {
                **base,
                "repo": "foundation/drive-by",
                "owner_login": "foundation",
            },
        ],
        "contributor",
    )

    assert impact["impact_repos"] == [
        {"repo": "git/git", "stars": 61828, "commits": 1, "prs": 0},
    ]
    assert impact["impact_repo_count"] == 1
    assert impact["impact_commit_count"] == 1
    assert impact["impact_pr_count"] == 0


@pytest.mark.skipif(not os.environ.get("GITHUB_TOKEN"), reason="needs GITHUB_TOKEN for a live crawl")
def test_collect_and_score_live():
    scan = collect_and_score("torvalds")
    assert scan["metrics"]["username"].lower() == "torvalds"
    s = scan["scoring"]
    assert 85 <= s["final_score"] <= 100  # a stable, very high account
    assert s["tier"] in ("夯", "顶级")
    assert set(s["sub_scores"]) == {
        "account_maturity", "original_project_quality", "contribution_quality",
        "ecosystem_impact", "community_influence", "activity_authenticity",
    }


@pytest.mark.parametrize("fail", [False, True])
def test_token_override_preserves_environment(monkeypatch, fail):
    import ghfind.local as local
    from ghfind._github import _auth_headers
    monkeypatch.setenv("GITHUB_TOKEN", "default-token")

    def collect_override(username):
        assert _auth_headers()["Authorization"] == "Bearer override-token"
        if fail:
            raise RuntimeError("fixture failure")
        return {"metrics": _empty_metrics()}

    monkeypatch.setattr(local, "collect", collect_override)
    if fail:
        with pytest.raises(RuntimeError, match="fixture failure"):
            collect_and_score("fixture", token="override-token")
    else:
        collect_and_score("fixture", token="override-token")
    assert os.environ["GITHUB_TOKEN"] == "default-token"
    assert _auth_headers()["Authorization"] == "Bearer default-token"

    def collect_default(username):
        assert _auth_headers()["Authorization"] == "Bearer default-token"
        return {"metrics": _empty_metrics()}

    monkeypatch.setattr(local, "collect", collect_default)
    collect_and_score("fixture")


def test_token_override_does_not_create_environment(monkeypatch):
    import ghfind.local as local
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setattr(local, "collect", lambda _: {"metrics": _empty_metrics()})
    collect_and_score("fixture", token="override-token")
    assert "GITHUB_TOKEN" not in os.environ
    with pytest.raises(GitHubAuthRequiredError):
        collect_and_score("fixture")


def test_concurrent_token_overrides(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    import ghfind.local as local
    from ghfind._github import _auth_headers
    monkeypatch.setenv("GITHUB_TOKEN", "default-token")
    barrier = Barrier(2, timeout=5)

    def collect_fixture(username):
        assert _auth_headers()["Authorization"] == f"Bearer {username}-token"
        barrier.wait()
        assert _auth_headers()["Authorization"] == f"Bearer {username}-token"
        return {"metrics": _empty_metrics()}

    monkeypatch.setattr(local, "collect", collect_fixture)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(collect_and_score, "first", token="first-token")
        second = pool.submit(collect_and_score, "second", token="second-token")
        first.result(timeout=10)
        second.result(timeout=10)
    assert _auth_headers()["Authorization"] == "Bearer default-token"
