"""`ghfind bot` tests — a scripted bot API through the CLI's injectable transport.

Mirrors packages/ghfind-js/src/bot.test.ts and internal/agentcli/bot_test.go.
"""

import json

import pytest

from ghfind import _cli

TOKEN = "ghf_" + "a" * 43
CLEANUP_ID = "11111111-2222-3333-4444-555555555555"
CONFIRM = f"{CLEANUP_ID}.{'b' * 24}"


class Harness:
    """Each scripted reply answers one request, in order."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.seen = []

    def transport(self, method, url, headers, body):
        self.seen.append(
            {
                "method": method,
                "url": url,
                "auth": headers.get("Authorization"),
                "body": json.loads(body) if body is not None else None,
            }
        )
        if not self.replies:
            raise AssertionError(f"Unexpected {method} {url}")
        nxt = self.replies.pop(0)
        if nxt["method"] != method or not url.endswith(nxt["path"]):
            raise AssertionError(f"Unexpected {method} {url}")
        return nxt.get("status", 200), json.dumps(nxt["body"]), {}


@pytest.fixture
def harness(monkeypatch):
    monkeypatch.setenv("GHFIND_API_KEY", TOKEN)
    monkeypatch.setenv("GHFIND_BOT_HOST", "https://bot.test")
    monkeypatch.delenv("GITHUB_ROAST_API_KEY", raising=False)
    monkeypatch.setattr(_cli, "_bot_sleep", lambda seconds: None)

    def make(replies=()):
        h = Harness(replies)
        monkeypatch.setattr(_cli, "_bot_transport", h.transport)
        return h

    return make


def test_requires_personal_api_token(harness, monkeypatch, capsys):
    h = harness()
    monkeypatch.delenv("GHFIND_API_KEY")
    assert _cli.main(["bot", "status", "o/r", "--json"]) == 1
    err = capsys.readouterr().err
    assert "personal_token_required" in err
    assert "https://ghfind.com/integrations" in err
    assert _cli.main(["bot", "status", "o/r", "--api-key", "machine-key"]) == 1
    assert "personal_token_required" in capsys.readouterr().err
    assert h.seen == []


def test_surfaces_api_error_codes(harness, capsys):
    h = harness([{"method": "POST", "path": "/api/v1/repos/o/r/pause", "status": 403, "body": {"error": "admin_required"}}])
    assert _cli.main(["bot", "pause", "o/r"]) == 1
    assert "(admin_required)" in capsys.readouterr().err
    assert h.seen[0]["auth"] == f"Bearer {TOKEN}"
    assert h.seen[0]["url"] == "https://bot.test/api/v1/repos/o/r/pause"


def test_scan_only_token_explains_opt_in_without_retrying(harness, capsys):
    h = harness([{"method": "POST", "path": "/api/v1/repos/o/r/pause", "status": 403, "body": {"error": "token_scope_required"}}])
    assert _cli.main(["bot", "pause", "o/r"]) == 1
    err = capsys.readouterr().err
    assert "(token_scope_required)" in err
    assert 'create a new token with "Manage the ghfind Review bot" at https://ghfind.com/integrations' in err
    assert len(h.seen) == 1


def test_bot_host_flag_overrides_env(harness, capsys):
    h = harness([{"method": "GET", "path": "/api/v1/whoami", "body": {"login": "me"}}])
    assert _cli.main(["bot", "whoami", "--bot-host", "https://other.test/"]) == 0
    assert h.seen[0]["url"] == "https://other.test/api/v1/whoami"
    assert json.loads(capsys.readouterr().out) == {"login": "me"}


def test_settings_set_patches_only_given_fields(harness, capsys):
    h = harness([{"method": "PATCH", "path": "/api/v1/repos/o/r/settings", "body": {"settings": {}}}])
    code = _cli.main(
        [
            "bot", "settings", "set", "o/r",
            "--triage", "on",
            "--allowed-labels", "bug, feature",
            "--prompt", "Reply in Chinese",
        ]
    )
    assert code == 0
    assert h.seen[0]["body"] == {
        "triage_enabled": True,
        "allowed_labels": ["bug", "feature"],
        "comment_prompt": "Reply in Chinese",
    }
    capsys.readouterr()
    assert _cli.main(["bot", "settings", "set", "o/r", "--issues", "maybe"]) == 1
    assert "on or off" in capsys.readouterr().err
    assert _cli.main(["bot", "settings", "set", "o/r"]) == 1
    assert "Nothing to set" in capsys.readouterr().err
    assert len(h.seen) == 1


def test_cleanup_preview_polls_and_prints_confirm_command(harness, capsys):
    h = harness(
        [
            {
                "method": "POST",
                "path": "/api/v1/repos/o/r/cleanups",
                "status": 202,
                "body": {"cleanup": {"id": CLEANUP_ID, "state": "planning"}, "confirm_token": CONFIRM},
            },
            {"method": "GET", "path": f"/api/v1/repos/o/r/cleanups/{CLEANUP_ID}", "body": {"cleanup": {"id": CLEANUP_ID, "state": "planning"}}},
            {
                "method": "GET",
                "path": f"/api/v1/repos/o/r/cleanups/{CLEANUP_ID}",
                "body": {
                    "cleanup": {"id": CLEANUP_ID, "state": "planned", "summary": {"review_labels": 2, "bot_active": True}},
                    "items": [],
                },
            },
        ]
    )
    assert _cli.main(["bot", "cleanup", "o/r", "--labels", "review", "--comments", "-o", "pretty"]) == 0
    assert h.seen[0]["body"] == {"labels": "review", "comments": True, "delete_label_definitions": False}
    assert len(h.seen) == 3
    out = capsys.readouterr().out
    assert f"ghfind bot cleanup confirm o/r {CONFIRM}" in out
    assert "review: labels 2" in out
    assert "ghfind bot pause" in out
    assert "Nothing has been changed" in out


def test_cleanup_preview_json_includes_token_and_next(harness, capsys):
    harness(
        [
            {
                "method": "POST",
                "path": "/api/v1/repos/o/r/cleanups",
                "status": 202,
                "body": {"cleanup": {"id": CLEANUP_ID, "state": "planning"}, "confirm_token": CONFIRM},
            },
        ]
    )
    assert _cli.main(["bot", "cleanup", "o/r", "--no-wait", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["confirm_token"] == CONFIRM
    assert payload["next"] == f"ghfind bot cleanup confirm o/r {CONFIRM}"


def test_confirm_sends_token_and_can_wait(harness, capsys):
    h = harness(
        [
            {
                "method": "POST",
                "path": f"/api/v1/repos/o/r/cleanups/{CLEANUP_ID}/confirm",
                "status": 202,
                "body": {"cleanup": {"id": CLEANUP_ID, "state": "running"}},
            },
            {
                "method": "GET",
                "path": f"/api/v1/repos/o/r/cleanups/{CLEANUP_ID}",
                "body": {"cleanup": {"id": CLEANUP_ID, "state": "done", "done": 3, "skipped": 1, "total": 4}},
            },
        ]
    )
    assert _cli.main(["bot", "cleanup", "confirm", "o/r", CONFIRM, "--wait", "--json"]) == 0
    assert h.seen[0]["body"] == {"token": CONFIRM}
    payload = json.loads(capsys.readouterr().out)
    assert payload["cleanup"]["state"] == "done"
    assert payload["cleanup"]["done"] == 3
    assert _cli.main(["bot", "cleanup", "confirm", "o/r", "nope"]) == 1
    assert "Usage" in capsys.readouterr().err
    assert len(h.seen) == 2


def test_validates_repo_and_limit_locally(harness, capsys):
    h = harness()
    assert _cli.main(["bot", "status", "not-a-repo"]) == 1
    assert "owner/name" in capsys.readouterr().err
    assert _cli.main(["bot", "backfill", "o/r", "-n", "500"]) == 1
    assert "1-100" in capsys.readouterr().err
    assert _cli.main(["bot", "backfill", "o/r", "--limit", "abc"]) == 1
    assert "1-100" in capsys.readouterr().err
    assert _cli.main(["bot", "cleanup", "status", "o/r", "bad-id"]) == 1
    assert "Usage" in capsys.readouterr().err
    assert h.seen == []


def test_backfill_default_limit_and_retry_job(harness, capsys):
    h = harness(
        [
            {"method": "POST", "path": "/api/v1/repos/o/r/backfill", "status": 202, "body": {"ok": True}},
            {"method": "POST", "path": "/api/v1/repos/o/r/retry", "status": 202, "body": {"ok": True}},
        ]
    )
    assert _cli.main(["bot", "backfill", "o/r"]) == 0
    assert _cli.main(["bot", "retry", "o/r", "job-1"]) == 0
    assert h.seen[0]["body"] == {"limit": 25}
    assert h.seen[1]["body"] == {"job_id": "job-1"}


def test_status_pretty(harness, capsys):
    harness(
        [
            {
                "method": "GET",
                "path": "/api/v1/repos/o/r",
                "body": {
                    "viewer": {"login": "me", "admin": True},
                    "settings": {"issues_enabled": True, "prs_enabled": False, "comments_enabled": True, "triage_enabled": False},
                    "jobs": {"failed": 2},
                    "llm_configured": True,
                },
            }
        ]
    )
    assert _cli.main(["bot", "status", "o/r"]) == 0
    out = capsys.readouterr().out.splitlines()
    assert out[0] == "o/r (you: me, admin)"
    assert out[1] == "  issues on, PRs off, comments on, intent labels off"
    assert out[2] == "  failed jobs: 2"


def test_catalog_lists_bot_commands(capsys):
    assert _cli.main(["commands", "show", "bot settings set"]) == 0
    assert json.loads(capsys.readouterr().out)["method"] == "bot settings get / bot settings set"


def test_refuses_plain_http_bot_host(harness, capsys):
    h = harness()
    assert _cli.main(["bot", "status", "o/r", "--bot-host", "http://evil.example"]) == 1
    assert "https" in capsys.readouterr().err
    assert h.seen == []
    from ghfind.bot import bot_host

    assert bot_host("http://localhost:8787/") == "http://localhost:8787"


def test_wait_survives_quota_pause(harness, capsys):
    path = f"/api/v1/repos/o/r/cleanups/{CLEANUP_ID}"
    h = harness(
        [
            {"method": "POST", "path": path + "/confirm", "status": 202, "body": {"cleanup": {"id": CLEANUP_ID, "state": "running"}}},
            {"method": "GET", "path": path, "status": 503, "body": {"error": "github_rate_limited"}},
            {"method": "GET", "path": path, "status": 429, "body": {"error": "rate_limited"}},
            {"method": "GET", "path": path, "body": {"cleanup": {"id": CLEANUP_ID, "state": "done"}}},
        ]
    )
    assert _cli.main(["bot", "cleanup", "confirm", "o/r", CONFIRM, "--wait", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["cleanup"]["state"] == "done"
    assert len(h.seen) == 4


def test_no_confirm_hint_when_nothing_to_clean(harness, capsys):
    harness(
        [
            {
                "method": "POST",
                "path": "/api/v1/repos/o/r/cleanups",
                "status": 202,
                "body": {"cleanup": {"id": CLEANUP_ID, "state": "planning"}, "confirm_token": CONFIRM},
            },
            {
                "method": "GET",
                "path": f"/api/v1/repos/o/r/cleanups/{CLEANUP_ID}",
                "body": {"cleanup": {"id": CLEANUP_ID, "state": "done", "result": "Nothing to clean up"}},
            },
        ]
    )
    assert _cli.main(["bot", "cleanup", "o/r", "--labels", "triage", "-o", "pretty"]) == 0
    out = capsys.readouterr().out
    assert "cleanup confirm" not in out
    assert "Nothing has been changed." in out
