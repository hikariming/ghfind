"""``ghfind bot`` — manage the ghfind Review GitHub App on repositories you
administer, from a terminal or an agent.

Talks to the bot's JSON API (https://bot.ghfind.com/api/v1), authenticated with
the same personal API token format as ``scan`` (GHFIND_API_KEY), with the bot
permission explicitly selected when creating the token. The bot checks your
current GitHub repository permission on every request: reading needs write
access, every change needs admin.

Destructive cleanup is two-step: ``bot cleanup`` only previews and returns a
confirm token valid for 10 minutes; ``bot cleanup confirm`` executes it.

Mirrors ``packages/ghfind-js/src/bot.ts`` and ``internal/agentcli/bot.go``.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Callable, Dict, List, Optional

from .client import GhFindError, Transport, _urllib_transport

DEFAULT_BOT_HOST = "https://bot.ghfind.com"
POLL_SECONDS = 2.0
PLAN_WAIT_SECONDS = 120.0
RUN_WAIT_SECONDS = 600.0

_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_CLEANUP_ID = re.compile(r"^[0-9a-f-]{36}$")
_CONFIRM = re.compile(r"^([0-9a-f-]{36})\.")

PERSONAL_TOKEN_MESSAGE = (
    'bot commands need a personal API token with the bot permission: create a new token with "Manage the ghfind Review bot" at '
    "https://ghfind.com/integrations and set GHFIND_API_KEY"
)


class BotUsageError(ValueError):
    """Local validation failure (bad repo, flag value, usage). No request was made."""


def repo_arg(value: Optional[str]) -> str:
    if not value or not _REPO.match(value):
        raise BotUsageError("Expected a repository as owner/name")
    return value


def toggle(value: Optional[str], name: str) -> Optional[bool]:
    if value is None:
        return None
    if value in ("on", "true"):
        return True
    if value in ("off", "false"):
        return False
    raise BotUsageError(f"{name} expects on or off")


def bot_host(raw: str) -> str:
    """The token goes to this host, so only HTTPS, or plain HTTP on localhost."""
    from urllib.parse import urlsplit

    parts = urlsplit((raw or DEFAULT_BOT_HOST).strip())
    if not parts.netloc:
        raise BotUsageError(f"Invalid bot host: {raw}")
    local = parts.hostname in ("localhost", "127.0.0.1", "::1")
    if parts.scheme != "https" and not (parts.scheme == "http" and local):
        raise BotUsageError("Bot host must use https (plain http only for localhost)")
    return f"{parts.scheme}://{parts.netloc}{parts.path}".rstrip("/")


class BotClient:
    def __init__(
        self,
        host: str = DEFAULT_BOT_HOST,
        api_key: Optional[str] = None,
        *,
        transport: Optional[Transport] = None,
        sleep: Optional[Callable[[float], None]] = None,
        clock: Optional[Callable[[], float]] = None,
    ) -> None:
        self.host = bot_host(host)
        self._api_key = api_key
        self._transport = transport or _urllib_transport
        self._sleep = sleep or time.sleep
        self._clock = clock or time.monotonic

    def request(self, method: str, path: str, body: Any = None) -> Dict[str, Any]:
        key = self._api_key
        if not key or not key.startswith("ghf_"):
            raise GhFindError(PERSONAL_TOKEN_MESSAGE, code="personal_token_required")
        headers = {"Accept": "application/json", "Authorization": f"Bearer {key}"}
        data: Optional[bytes] = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        status, text, _ = self._transport(method, f"{self.host}/api/v1{path}", headers, data)
        try:
            parsed: Any = json.loads(text) if text else None
        except ValueError:
            parsed = None
        if not 200 <= status < 300:
            code = parsed.get("error") if isinstance(parsed, dict) else None
            raise GhFindError(
                PERSONAL_TOKEN_MESSAGE if code == "token_scope_required" else f"bot API request failed with HTTP {status}",
                status=status,
                code=code if isinstance(code, str) else None,
                body=parsed,
            )
        return parsed if isinstance(parsed, dict) else {}

    def wait_cleanup(self, repo: str, cleanup_id: str, states: List[str], limit: float) -> Dict[str, Any]:
        """Polls a cleanup until it leaves one of ``states`` or ``limit`` seconds pass."""
        started = self._clock()
        last: Optional[Dict[str, Any]] = None
        while True:
            try:
                view = self.request("GET", f"/repos/{repo}/cleanups/{cleanup_id}")
            except GhFindError as e:
                # The cleanup keeps running on the server; a busy GitHub quota or
                # our own rate limit only means "ask again later".
                if e.status not in (503, 429):
                    raise
                if self._clock() - started >= limit:
                    if last is not None:
                        return last
                    raise
                self._sleep(POLL_SECONDS * 5)
                continue
            last = view
            cleanup = view.get("cleanup") if isinstance(view.get("cleanup"), dict) else {}
            if str(cleanup.get("state")) not in states or self._clock() - started >= limit:
                return view
            self._sleep(POLL_SECONDS)


def _v(value: Any) -> str:
    """Render a JSON value the way the JS/Go CLIs print it."""
    if value is None:
        return "undefined"
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def summarize(print_: Callable[[str], None], payload: Dict[str, Any]) -> None:
    c = payload.get("cleanup") if isinstance(payload.get("cleanup"), dict) else payload
    s = c.get("summary") if isinstance(c.get("summary"), dict) else {}

    def num(key: str) -> str:
        value = s.get(key)
        return _v(0 if value is None else value)

    print_(f"cleanup {_v(c.get('id'))}: {_v(c.get('state'))}")
    truncated = " (truncated: run again afterwards)" if s.get("truncated") else ""
    print_(
        f"  review: labels {num('review_labels')}, intent labels {num('triage_labels')}, "
        f"comments {num('comments')}, label definitions {num('label_definitions')}{truncated}"
    )
    if c.get("state") in ("running", "done"):
        print_(
            f"  progress: {_v(c.get('done'))} removed, {_v(c.get('skipped'))} skipped (preserved or already absent), "
            f"of {_v(c.get('total'))}"
        )
    if s.get("bot_active"):
        print_("  warning: score labels are still on; run `ghfind bot pause` first or new items get labelled again")
    if c.get("result"):
        print_(f"  result: {c['result']}")


def _on_off(value: Any) -> str:
    return "on" if value else "off"


def run_bot(
    bot: BotClient,
    command: str,
    opts: Dict[str, Any],
    *,
    json_output: bool,
    print_: Callable[[str], None],
) -> None:
    """Run one ``ghfind bot`` command. ``opts`` holds the parsed argparse values."""

    def emit(value: Any) -> None:
        print_(json.dumps(value, ensure_ascii=False, indent=2))

    if command == "whoami":
        return emit(bot.request("GET", "/whoami"))

    if command == "status":
        repo = repo_arg(opts.get("repo"))
        status = bot.request("GET", f"/repos/{repo}")
        if json_output:
            return emit(status)
        s = status.get("settings") or {}
        jobs = status.get("jobs") or {}
        viewer = status.get("viewer") or {}
        print_(f"{repo} (you: {_v(viewer.get('login'))}, {'admin' if viewer.get('admin') else 'read only'})")
        llm = "" if status.get("llm_configured") else " (LLM not configured)"
        print_(
            f"  issues {_on_off(s.get('issues_enabled'))}, PRs {_on_off(s.get('prs_enabled'))}, "
            f"comments {_on_off(s.get('comments_enabled'))}, intent labels {_on_off(s.get('triage_enabled'))}{llm}"
        )
        print_(f"  failed jobs: {_v(jobs.get('failed'))}")
        if isinstance(status.get("cleanup"), dict):
            summarize(print_, status["cleanup"])
        return None

    if command == "settings":
        action = opts.get("action")
        repo = repo_arg(opts.get("repo"))
        if action == "get":
            return emit(bot.request("GET", f"/repos/{repo}/settings"))
        if action != "set":
            raise BotUsageError("Usage: ghfind bot settings get|set <owner/repo>")
        patch: Dict[str, Any] = {}
        for flag, attr, key in (
            ("--issues", "issues", "issues_enabled"),
            ("--prs", "prs", "prs_enabled"),
            ("--comments-enabled", "comments_enabled", "comments_enabled"),
            ("--triage", "triage", "triage_enabled"),
        ):
            value = toggle(opts.get(attr), flag)
            if value is not None:
                patch[key] = value
        if opts.get("prompt") is not None:
            patch["comment_prompt"] = opts["prompt"]
        if opts.get("allowed_labels") is not None:
            patch["allowed_labels"] = [x.strip() for x in opts["allowed_labels"].split(",") if x.strip()]
        if not patch:
            raise BotUsageError('Nothing to set. See: ghfind commands show "bot settings set"')
        return emit(bot.request("PATCH", f"/repos/{repo}/settings", patch))

    if command in ("pause", "resume"):
        return emit(bot.request("POST", f"/repos/{repo_arg(opts.get('repo'))}/{command}"))

    if command == "backfill":
        repo = repo_arg(opts.get("repo"))
        raw = opts.get("limit")
        if raw is None:
            limit = 25
        else:
            try:
                limit = int(str(raw), 10)
            except ValueError:
                limit = 0
            if limit < 1 or limit > 100:
                raise BotUsageError("--limit must be 1-100")
        return emit(bot.request("POST", f"/repos/{repo}/backfill", {"limit": limit}))

    if command == "retry":
        repo = repo_arg(opts.get("repo"))
        job_id = opts.get("job_id")
        return emit(bot.request("POST", f"/repos/{repo}/retry", {"job_id": job_id} if job_id else {}))

    if command == "cleanup":
        return _run_cleanup(bot, list(opts.get("target") or []), opts, json_output, print_, emit)

    raise BotUsageError("Unknown bot command. Try: ghfind bot --help")


def _run_cleanup(
    bot: BotClient,
    rest: List[str],
    opts: Dict[str, Any],
    json_output: bool,
    print_: Callable[[str], None],
    emit: Callable[[Any], None],
) -> None:
    def show(view: Dict[str, Any]) -> None:
        if json_output:
            emit(view)
        else:
            summarize(print_, view)

    sub = rest[0] if rest else None
    if sub == "confirm":
        repo = repo_arg(rest[1] if len(rest) > 1 else None)
        token = rest[2] if len(rest) > 2 else ""
        m = _CONFIRM.match(token)
        if not m:
            raise BotUsageError("Usage: ghfind bot cleanup confirm <owner/repo> <confirm-token>")
        cleanup_id = m.group(1)
        view = bot.request("POST", f"/repos/{repo}/cleanups/{cleanup_id}/confirm", {"token": token})
        if opts.get("wait"):
            view = bot.wait_cleanup(repo, cleanup_id, ["running"], RUN_WAIT_SECONDS)
        return show(view)

    if sub in ("status", "cancel"):
        repo = repo_arg(rest[1] if len(rest) > 1 else None)
        cleanup_id = rest[2] if len(rest) > 2 else ""
        if not _CLEANUP_ID.match(cleanup_id):
            raise BotUsageError(f"Usage: ghfind bot cleanup {sub} <owner/repo> <cleanup-id>")
        path = f"/repos/{repo}/cleanups/{cleanup_id}"
        view = bot.request("GET", path) if sub == "status" else bot.request("POST", f"{path}/cancel")
        return show(view)

    repo = repo_arg(sub)
    created = bot.request(
        "POST",
        f"/repos/{repo}/cleanups",
        {
            "labels": opts.get("labels") or "none",
            "comments": bool(opts.get("comments")),
            "delete_label_definitions": bool(opts.get("delete_label_definitions")),
        },
    )
    token = str(created.get("confirm_token"))
    cleanup = created.get("cleanup") if isinstance(created.get("cleanup"), dict) else {}
    cleanup_id = str(cleanup.get("id"))
    view = created if opts.get("no_wait") else bot.wait_cleanup(repo, cleanup_id, ["planning"], PLAN_WAIT_SECONDS)
    result = {**view, "confirm_token": token, "next": f"ghfind bot cleanup confirm {repo} {token}"}
    if json_output:
        return emit(result)
    summarize(print_, view)
    state = str((view.get("cleanup") if isinstance(view.get("cleanup"), dict) else view).get("state"))
    if state == "planned":
        print_("Nothing has been changed. To execute this plan within 10 minutes, run:")
        print_(f"  {result['next']}")
    elif state == "planning":
        print_(f"Still previewing. Check with: ghfind bot cleanup status {repo} {cleanup_id}")
    else:
        print_("Nothing has been changed.")
    return None
