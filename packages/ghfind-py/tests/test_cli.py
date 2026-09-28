"""CLI tests — offline command output + a fake-transport network command.

Network commands are exercised through GhFind's injectable ``transport`` so no
real HTTP happens. The bit-exact scoring math is covered elsewhere
(test_score_parity.py); here we cover the CLI's argument wiring and formatting.
"""

import json

import pytest

from ghfind import _cli
from ghfind.client import GhFind


class _ReconfigurableStream:
    def __init__(self):
        self.calls = []

    def reconfigure(self, **kwargs):
        self.calls.append(kwargs)


def test_windows_stdio_is_reconfigured_for_unicode(monkeypatch):
    stdout = _ReconfigurableStream()
    stderr = _ReconfigurableStream()
    monkeypatch.setattr(_cli.sys, "platform", "win32")
    monkeypatch.setattr(_cli.sys, "stdout", stdout)
    monkeypatch.setattr(_cli.sys, "stderr", stderr)

    _cli._configure_windows_stdio()

    expected = [{"encoding": "utf-8", "errors": "replace"}]
    assert stdout.calls == expected
    assert stderr.calls == expected


def test_version(capsys):
    with pytest.raises(SystemExit) as e:
        _cli.main(["--version"])
    assert e.value.code == 0
    assert "ghfind 0.1.0" in capsys.readouterr().out


def test_badge_markdown(capsys):
    assert _cli.main(["badge", "torvalds", "--markdown", "--host", "https://ghfind.com"]) == 0
    out = capsys.readouterr().out.strip()
    assert out == "[![ghfind score](https://ghfind.com/api/badge/torvalds)](https://ghfind.com/u/torvalds)"


def test_card(capsys):
    assert _cli.main(["card", "torvalds", "--host", "https://ghfind.com"]) == 0
    assert capsys.readouterr().out.strip() == "https://ghfind.com/api/card/torvalds"


def test_commands_lists_get_score_first(capsys):
    assert _cli.main(["commands"]) == 0
    assert capsys.readouterr().out.splitlines()[0].startswith("get_score")


def test_commands_show_json(capsys):
    assert _cli.main(["commands", "show", "get_score"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["method"] == "get_score"
    assert payload["llm"] is False


def _fake_client(payload, headers=None):
    """A GhFind whose transport returns a scripted JSON response."""
    def transport(method, url, hdrs, body):
        return 200, json.dumps(payload), headers or {}

    return GhFind(host="https://ghfind.com", transport=transport)


def test_score_pretty_formatting(capsys, monkeypatch):
    payload = {
        "source": "indexed",
        "username": "torvalds",
        "final_score": 94.6,
        "tier": "夯",
        "tier_key": "god",
        "sub_scores": {
            "account_maturity": 10,
            "original_project_quality": 18,
            "contribution_quality": 22.7,
            "ecosystem_impact": 20,
            "community_influence": 8,
            "activity_authenticity": 15.9,
        },
        "percentile": {"beat": 98.4, "total": 18000, "rank": 3},
    }
    monkeypatch.setattr(_cli, "_client", lambda args: _fake_client(payload))
    assert _cli.main(["score", "torvalds"]) == 0
    out = capsys.readouterr().out
    assert "torvalds: 94.6/100 夯 (god)" in out
    # sub-scores print in the canonical order, not dict order
    assert out.index("account_maturity") < out.index("activity_authenticity")
    assert "beats 98.4% of 18000 scored accounts" in out
    assert "→ https://ghfind.com/u/torvalds" in out


def test_score_json(capsys, monkeypatch):
    payload = {"source": "indexed", "username": "x", "final_score": 42, "tier": "NPC", "tier_key": "npc"}
    monkeypatch.setattr(_cli, "_client", lambda args: _fake_client(payload))
    assert _cli.main(["score", "x", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["final_score"] == 42


def test_api_error_exit_code(capsys, monkeypatch):
    def transport(method, url, hdrs, body):
        return 404, json.dumps({"error": "account_not_found"}), {}

    monkeypatch.setattr(_cli, "_client", lambda args: GhFind(host="https://ghfind.com", transport=transport))
    assert _cli.main(["score", "nope"]) == 1
    assert "account_not_found" in capsys.readouterr().err


def test_incomplete_byo_key_fails(capsys, monkeypatch):
    monkeypatch.delenv("GHFIND_BYO_BASE_URL", raising=False)
    monkeypatch.delenv("GHFIND_BYO_API_KEY", raising=False)
    monkeypatch.delenv("GHFIND_BYO_MODEL", raising=False)
    monkeypatch.setattr(_cli, "_client", lambda args: _fake_client({}))
    # only one of the three byo parts → hard fail before any request
    code = _cli.main(["roast", "x", "--byo-model", "gpt-4o"])
    assert code == 1
    assert "Incomplete BYO key" in capsys.readouterr().err
