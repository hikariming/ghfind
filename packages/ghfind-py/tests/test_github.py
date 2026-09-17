"""Offline tests for GitHub contribution classification."""

from ghfind._github import (
    compute_impact_from_contrib_map,
    compute_org_repo_attribution,
    first_commit_history_after,
    is_doc_like_impact_pr,
    parse_github_noreply_login,
    resolve_first_commit_github_login,
)


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


def test_first_commit_history_cursor():
    assert first_commit_history_after("abc", 1) is None
    assert first_commit_history_after("abc", 2) == "abc 0"
    assert first_commit_history_after("abc", 2706) == "abc 2704"


def test_github_noreply_login_parsing():
    assert parse_github_noreply_login("48499089+yifanxuaaa@users.noreply.github.com") == "yifanxuaaa"
    assert parse_github_noreply_login("samzong@users.noreply.github.com") == "samzong"
    assert parse_github_noreply_login("person@example.com") is None


def test_first_commit_login_resolution_order():
    assert resolve_first_commit_github_login(
        author_login="alice",
        committer_login="bot",
        author_email="1+other@users.noreply.github.com",
    ) == {"login": "alice", "source": "author.user"}
    assert resolve_first_commit_github_login(committer_login="bob") == {
        "login": "bob",
        "source": "committer.user",
    }
    assert resolve_first_commit_github_login(
        author_email="12+carol@users.noreply.github.com",
    ) == {"login": "carol", "source": "noreply-email"}
    assert resolve_first_commit_github_login(author_email="carol@example.com") == {
        "login": None,
        "source": "none",
    }


def test_first_commit_can_substitute_public_membership():
    attribution = compute_org_repo_attribution(
        _repo(repo="lab/layerfs", owner_login="lab", commits=200, prs=20, active_years=1),
        [],
        scored_login="alice",
        first_commit_login="alice",
    )
    assert attribution["repo"] == "lab/layerfs"
    assert attribution["score"] >= 5
    assert "first commit author is alice" in " ".join(attribution["evidence"])


def test_first_commit_does_not_skip_long_term_gate():
    assert compute_org_repo_attribution(
        _repo(repo="lab/plugins", owner_login="lab", commits=54, prs=12, active_years=1),
        [],
        scored_login="alice",
        first_commit_login="alice",
    ) is None


def test_foreign_first_commit_is_not_attributed():
    assert compute_org_repo_attribution(
        _repo(repo="lab/sandbox", owner_login="lab", commits=2000, prs=40, active_years=1),
        [],
        scored_login="alice",
        first_commit_login="other-dev",
    ) is None


def test_membership_evidence_wins_when_both_gates_match():
    attribution = compute_org_repo_attribution(
        _repo(repo="org/main-engine", owner_login="org", commits=90, prs=8, active_years=4),
        ["org"],
        scored_login="alice",
        first_commit_login="alice",
    )
    evidence = " ".join(attribution["evidence"])
    assert "org member of org" in evidence
    assert "first commit author" not in evidence


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
