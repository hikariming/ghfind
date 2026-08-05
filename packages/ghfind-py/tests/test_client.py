import base64
import json

import pytest

from ghfind import GhFind, GhFindError


def b64(s: str) -> str:
    return base64.b64encode(s.encode("utf-8")).decode("ascii")


class Recorder:
    """Injectable transport that records calls and returns scripted responses."""

    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append({"method": method, "url": url, "headers": headers, "body": body})
        return self.handler(method, url, headers, body)


def test_host_normalization():
    gh = GhFind("https://x.dev/", transport=lambda *a: (200, "{}", {}))
    assert gh.host == "https://x.dev"


def test_get_score():
    rec = Recorder(lambda *a: (200, json.dumps({"final_score": 99, "tier": "夯"}), {}))
    gh = GhFind("https://ghfind.com", transport=rec)
    r = gh.get_score("torvalds")
    assert r["final_score"] == 99
    assert rec.calls[0]["url"] == "https://ghfind.com/api/score/torvalds"
    assert rec.calls[0]["method"] == "GET"


def test_scan_posts_username_and_turnstile():
    rec = Recorder(lambda *a: (200, json.dumps({"scoring": {"final_score": 42}}), {}))
    gh = GhFind("https://ghfind.com", turnstile_token="tok", transport=rec)
    gh.scan("octocat")
    body = json.loads(rec.calls[0]["body"].decode())
    assert body == {"username": "octocat", "turnstileToken": "tok"}


def test_scan_follows_accepted_job_location():
    def handler(method, url, headers, body):
        if url.endswith("/api/scan"):
            return (202, json.dumps({"id": "job_aaaaaaaaaaaaaaaa", "state": "queued"}),
                    {"location": "/api/scan/jobs/job_aaaaaaaaaaaaaaaa"})
        return (200, json.dumps({
            "status": {"state": "completed"},
            "result": {"metrics": {"username": "octocat"}, "scoring": {"final_score": 42}},
        }), {})

    rec = Recorder(handler)
    gh = GhFind("https://ghfind.com", transport=rec)
    result = gh.scan("octocat")

    assert result["scoring"]["final_score"] == 42
    assert [c["url"] for c in rec.calls] == [
        "https://ghfind.com/api/scan",
        "https://ghfind.com/api/scan/jobs/job_aaaaaaaaaaaaaaaa",
    ]


def test_score_returns_scoring_block():
    rec = Recorder(lambda *a: (200, json.dumps({"scoring": {"final_score": 42, "tier": "NPC"}}), {}))
    gh = GhFind(transport=rec)
    assert gh.score("x") == {"final_score": 42, "tier": "NPC"}


def test_api_key_bearer_header():
    rec = Recorder(lambda *a: (200, "{}", {}))
    gh = GhFind(api_key="secret", transport=rec)
    gh.scan("x")
    assert rec.calls[0]["headers"]["authorization"] == "Bearer secret"


def test_error_raises_with_code():
    rec = Recorder(lambda *a: (404, json.dumps({"error": "account_not_found"}), {}))
    gh = GhFind(transport=rec)
    with pytest.raises(GhFindError) as ei:
        gh.get_score("nope")
    assert ei.value.status == 404
    assert ei.value.code == "account_not_found"


def test_roast_parses_stream_and_header_meta():
    meta = {"final_score": 88, "tier": "顶级", "delta": -2}
    stream = "\n".join(["# Report", "line two", "\x1fTprogress...", "more"])

    def handler(method, url, headers, body):
        if url.endswith("/api/scan"):
            return (200, json.dumps({"scoring": {}, "metrics": {}}), {})
        return (200, stream, {"x-roast-meta": b64(json.dumps(meta))})

    rec = Recorder(handler)
    gh = GhFind(transport=rec)
    r = gh.roast("torvalds")
    assert r["meta"]["final_score"] == 88
    assert r["progress"] == ["progress..."]
    assert r["report"] == "# Report\nline two\nmore"
    assert [c["url"] for c in rec.calls] == [
        "https://ghfind.com/api/scan",
        "https://ghfind.com/api/roast",
    ]


def test_roast_raises_on_error_frame():
    rec = Recorder(lambda *a: (200, '\x1fE{"error":"llm_quota"}', {}))
    gh = GhFind(transport=rec)
    with pytest.raises(GhFindError) as ei:
        gh.roast(scan={"scoring": {}})
    assert ei.value.code == "llm_quota"


def test_leaderboard_query_params():
    rec = Recorder(lambda *a: (200, json.dumps({"entries": []}), {}))
    gh = GhFind(transport=rec)
    gh.leaderboard(view="trending", window="7d")
    assert rec.calls[0]["url"] == "https://ghfind.com/api/leaderboard?view=trending&window=7d"


def test_get_github_user_null_and_profile():
    def handler(method, url, headers, body):
        if "/users/ghost" in url:
            return (404, "", {})
        return (200, json.dumps({"login": "torvalds", "id": 1024025}), {})

    rec = Recorder(handler)
    gh = GhFind(transport=rec)
    assert gh.get_github_user("ghost") is None
    assert gh.get_github_user("torvalds")["login"] == "torvalds"
    assert rec.calls[0]["url"] == "https://api.github.com/users/ghost"


def test_get_github_user_raises_on_rate_limit():
    rec = Recorder(lambda *a: (403, "", {}))
    gh = GhFind(transport=rec)
    with pytest.raises(GhFindError) as ei:
        gh.user_exists("x")
    assert ei.value.code == "github_rate_limited"


def test_github_token_bearer():
    rec = Recorder(lambda *a: (200, json.dumps({"login": "x", "id": 1}), {}))
    gh = GhFind(github_token="ghp_test", transport=rec)
    gh.get_github_user("x")
    assert rec.calls[0]["headers"]["authorization"] == "Bearer ghp_test"


def test_verify_exists_short_circuits_when_missing():
    def handler(method, url, headers, body):
        if "api.github.com" in url:
            return (404, "", {})
        return (200, "{}", {})

    rec = Recorder(handler)
    gh = GhFind(transport=rec)
    with pytest.raises(GhFindError) as ei:
        gh.get_score("ghost", verify_exists=True)
    assert ei.value.code == "github_user_not_found"
    assert len(rec.calls) == 1  # ghfind was never called
    assert "api.github.com" in rec.calls[0]["url"]


def test_verify_exists_proceeds_when_present():
    def handler(method, url, headers, body):
        if "api.github.com" in url:
            return (200, json.dumps({"login": "torvalds", "id": 1}), {})
        return (200, json.dumps({"source": "indexed", "final_score": 99}), {})

    rec = Recorder(handler)
    gh = GhFind(transport=rec)
    r = gh.get_score("torvalds", verify_exists=True)
    assert r["final_score"] == 99
    assert [c["url"] for c in rec.calls] == [
        "https://api.github.com/users/torvalds",
        "https://ghfind.com/api/score/torvalds",
    ]


def test_image_url_builders():
    gh = GhFind("https://ghfind.com", transport=lambda *a: (200, "{}", {}))
    assert gh.badge_url("torvalds", lang="zh") == "https://ghfind.com/api/badge/torvalds?lang=zh"
    assert gh.card_url("torvalds") == "https://ghfind.com/api/card/torvalds"
    assert gh.vs_card_url("a", "b") == "https://ghfind.com/api/card/vs/a/b"
