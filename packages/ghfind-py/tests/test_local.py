"""Local verification: offline unit tests for ``ghfind.local``.

The bit-exact score parity lives in test_score_parity.py (offline). Here we cover
the verify-only surface (``score_metrics`` / ``verify_scan``) and the CLI's
``verify`` / ``scan --verify`` paths.
"""

import json

import pytest

import ghfind
from ghfind._cli import main
from ghfind._extract import compute_impact_from_contrib_map
from ghfind.local import score_metrics, verify_scan


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


def test_local_no_longer_crawls():
    import ghfind.local as local
    assert not hasattr(local, "collect_and_score")
    with pytest.raises(ImportError):
        __import__("ghfind._github")


def test_verify_scan_accepts_untouched_scan():
    metrics = _empty_metrics(followers=1200, total_stars=9000, merged_pr_count=80, account_age_years=9)
    check = verify_scan({"metrics": metrics, "scoring": score_metrics(metrics)})
    assert check["verified"] is True
    assert check["differences"] == []


def test_verify_scan_lists_mismatched_fields():
    metrics = _empty_metrics(followers=1200, total_stars=9000, merged_pr_count=80)
    scoring = score_metrics(metrics)
    tampered = {
        **scoring,
        "final_score": scoring["final_score"] + 7,
        "sub_scores": {**scoring["sub_scores"], "community_influence": scoring["sub_scores"]["community_influence"] + 1},
    }
    check = verify_scan({"metrics": metrics, "scoring": tampered})
    assert check["verified"] is False
    assert [d["field"] for d in check["differences"]] == ["final_score", "sub_scores.community_influence"]
    assert check["differences"][0] == {"field": "final_score", "server": scoring["final_score"] + 7, "local": scoring["final_score"]}


def test_verify_scan_survives_json_round_trip():
    metrics = _empty_metrics(followers=300, total_stars=1500, merged_pr_count=12)
    scan = json.loads(json.dumps({"metrics": metrics, "scoring": score_metrics(metrics)}))
    assert verify_scan(scan)["verified"] is True


@pytest.mark.parametrize("payload", [{}, {"metrics": {}, "scoring": {}}, {"scoring": {"sub_scores": {}}}])
def test_verify_scan_rejects_payloads_without_evidence(payload):
    with pytest.raises(TypeError, match="metrics"):
        verify_scan(payload)


def test_verify_scan_reports_incomplete_metrics():
    with pytest.raises(TypeError, match="incomplete or malformed.*account_age_years"):
        verify_scan({"metrics": {"username": "x"}, "scoring": {"sub_scores": {}}})


def test_cli_verify_file(tmp_path, capsys):
    metrics = _empty_metrics(followers=800, total_stars=4000, merged_pr_count=30)
    scoring = score_metrics(metrics)
    good = tmp_path / "good.json"
    bad = tmp_path / "bad.json"
    good.write_text(json.dumps({"metrics": metrics, "scoring": scoring}))
    bad.write_text(json.dumps({"metrics": metrics, "scoring": {**scoring, "final_score": scoring["final_score"] + 5}}))

    assert main(["verify", str(good), "--json"]) == 0
    assert json.loads(capsys.readouterr().out) == {"username": "test", "verified": True, "differences": []}

    assert main(["verify", str(bad)]) == 3
    out = capsys.readouterr().out
    assert "NOT verified" in out and "- final_score: server" in out


def test_cli_local_flag_explains_removal(capsys):
    assert main(["score", "torvalds", "--local"]) == 1
    assert "--local was removed" in capsys.readouterr().err


def test_version_is_verify_only_release():
    assert ghfind.__version__ == "0.2.0"


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
