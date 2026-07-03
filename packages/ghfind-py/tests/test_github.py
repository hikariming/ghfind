"""Offline tests for GitHub contribution classification."""

from ghfind._github import compute_impact_from_contrib_map, is_doc_like_impact_pr


def _repo(**over):
    repo = {
        "repo": "foundation/platform",
        "stars": 24000,
        "is_private": False,
        "is_fork": False,
        "owner_login": "foundation",
        "commits": 0,
        "prs": 0,
        "active_years": 1,
    }
    repo.update(over)
    return repo


def _pr(**over):
    pr = {
        "title": "add my entry",
        "repo": "owner/repo",
        "repo_stars": 0,
        "churn": 100,
        "changed_files": 1,
        "trivial": False,
    }
    pr.update(over)
    return pr


def test_registry_and_directory_prs_are_doc_like():
    assert is_doc_like_impact_pr(_pr(repo="is-a-dev/register", repo_stars=10600))
    assert is_doc_like_impact_pr(_pr(repo="tuna/blogroll", repo_stars=2200))


def test_one_off_registry_entries_do_not_count_as_ecosystem_impact():
    impact = compute_impact_from_contrib_map(
        [
            _repo(
                repo="is-a-dev/register",
                owner_login="is-a-dev",
                stars=10600,
                commits=1,
                prs=1,
            ),
            _repo(
                repo="tuna/blogroll",
                owner_login="tuna",
                stars=2200,
                commits=1,
                prs=1,
            ),
            _repo(repo="org/target", owner_login="org", stars=5000, prs=1),
        ],
        "contributor",
    )

    assert [repo["repo"] for repo in impact["impact_repos"]] == ["org/target"]
    assert impact["impact_repo_count"] == 1


def test_sustained_registry_maintenance_still_counts():
    impact = compute_impact_from_contrib_map(
        [
            _repo(
                repo="is-a-dev/register",
                owner_login="is-a-dev",
                stars=10600,
                commits=20,
                prs=10,
            ),
        ],
        "contributor",
    )

    assert impact["impact_repo_count"] == 1
    assert impact["impact_repos"][0]["repo"] == "is-a-dev/register"
