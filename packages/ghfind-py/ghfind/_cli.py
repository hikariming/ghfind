"""ghfind command-line interface — a thin wrapper over the :class:`GhFind` SDK.

Design goals (in priority order):
  1. Useful with zero setup: ``score`` hits the public GET /api/score endpoint,
     which needs no auth and is cached + rate-limited on the server.
  2. Kind to the ghfind server: ``--local`` moves the heavy GitHub crawl onto the
     caller's own token/machine (see :mod:`ghfind.local`); nothing touches ghfind.
  3. Drives traffic back: human-facing output ends with a profile link, and
     ``badge --markdown`` prints a README-ready snippet that links to ghfind.com.

No LLM is ever bundled. ``roast`` uses the server's model by default (protected by
caching + rate limits); pass ``--byo-*`` to run it through your own provider.

Installed as the ``ghfind`` console script (see ``[project.scripts]``).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

from . import __version__
from .catalog import CATALOG, DEFAULT_HOST
from .client import GhFind, GhFindError

_SUB_SCORE_ORDER = [
    "account_maturity",
    "original_project_quality",
    "contribution_quality",
    "ecosystem_impact",
    "community_influence",
    "activity_authenticity",
]


def _out(text: str = "") -> None:
    try:
        sys.stdout.write(f"{text}\n")
        sys.stdout.flush()
    except UnicodeEncodeError:
        # Fallback for Windows consoles or non-UTF-8 stdout environments
        sys.stdout.buffer.write(f"{text}\n".encode("utf-8", errors="replace"))
        sys.stdout.buffer.flush()


def _out_json(value: Any) -> None:
    _out(json.dumps(value, ensure_ascii=False, indent=2))


def _fail(message: str, code: int = 1) -> "NoReturn":  # type: ignore[name-defined]
    try:
        sys.stderr.write(f"{message}\n")
        sys.stderr.flush()
    except UnicodeEncodeError:
        sys.stderr.buffer.write(f"{message}\n".encode("utf-8", errors="replace"))
        sys.stderr.buffer.flush()
    raise SystemExit(code)


def _resolve_host(args: argparse.Namespace) -> str:
    raw = (
        getattr(args, "host", None)
        or os.environ.get("GHFIND_HOST")
        or os.environ.get("GITHUB_ROAST_HOST")
        or DEFAULT_HOST
    ).strip()
    return raw.rstrip("/")


def _github_token(args: argparse.Namespace) -> Optional[str]:
    return getattr(args, "github_token", None) or os.environ.get("GITHUB_TOKEN")


def _client(args: argparse.Namespace) -> GhFind:
    return GhFind(
        host=getattr(args, "host", None),
        api_key=getattr(args, "api_key", None)
        or os.environ.get("GHFIND_API_KEY")
        or os.environ.get("GITHUB_ROAST_API_KEY"),
        github_token=_github_token(args),
    )


def _byo_key(args: argparse.Namespace) -> Optional[Dict[str, str]]:
    base = getattr(args, "byo_base_url", None) or os.environ.get("GHFIND_BYO_BASE_URL")
    key = getattr(args, "byo_api_key", None) or os.environ.get("GHFIND_BYO_API_KEY")
    model = getattr(args, "byo_model", None) or os.environ.get("GHFIND_BYO_MODEL")
    if base and key and model:
        return {"baseURL": base, "apiKey": key, "model": model}
    if base or key or model:
        _fail("Incomplete BYO key: need --byo-base-url, --byo-api-key and --byo-model together.")
    return None


def _output_mode(args: argparse.Namespace, fallback: str = "pretty") -> str:
    if getattr(args, "json", False):
        return "json"
    mode = getattr(args, "output", None) or fallback
    if mode not in ("json", "pretty", "markdown"):
        _fail(f"Invalid output format: {mode}")
    return mode


def _profile_link(host: str, username: str) -> str:
    return f"\n→ {host}/u/{username}"


def _print_sub_scores(sub_scores: Optional[Dict[str, Any]]) -> None:
    if not sub_scores:
        return
    for key in _SUB_SCORE_ORDER:
        if key in sub_scores:
            _out(f"- {key}: {sub_scores[key]}")


def _print_risk(scoring: Dict[str, Any]) -> None:
    assessment = scoring.get("risk_assessment")
    if assessment:
        _out(
            f'risk: {assessment.get("level")}, confidence {assessment.get("confidence", 0)}%, '
            f'penalty -{assessment.get("applied_penalty", 0)}'
        )
    for note in scoring.get("risk_notes") or []:
        _out(f'{note.get("flag")}: {note.get("detail", "")}')


def _local_scan(args: argparse.Namespace, username: str) -> Dict[str, Any]:
    token = _github_token(args)
    if not token:
        _fail(
            "--local needs a GitHub token: pass --github-token or set GITHUB_TOKEN.\n"
            "Local scoring crawls GitHub on your own machine and quota (ghfind is never called)."
        )
    # Imported lazily so the common remote path never pays for the scoring engine.
    from .local import collect_and_score

    return collect_and_score(username, token=token)


# ---- commands --------------------------------------------------------------


def _cmd_score(args: argparse.Namespace) -> None:
    host = _resolve_host(args)
    mode = _output_mode(args)

    if args.local:
        scan = _local_scan(args, args.username)
        s = scan["scoring"]
        if mode == "json":
            _out_json({"source": "local", "username": scan["metrics"]["username"], **s})
            return
        _out(f'{scan["metrics"]["username"]}: {s["final_score"]}/100 {s["tier"]} ({s["tier_label"]})')
        _print_sub_scores(s.get("sub_scores"))
        _print_risk(s)
        for f in s.get("red_flags") or []:
            _out(f'- {f["flag"]}: -{f["penalty"]} {f["detail"]}')
        _out(_profile_link(host, scan["metrics"]["username"]))
        return

    payload = _client(args).get_score(args.username, verify_exists=args.verify_exists)
    if mode == "json":
        _out_json(payload)
        return
    _out(f'{payload["username"]}: {payload["final_score"]}/100 {payload["tier"]} ({payload.get("tier_key")})')
    _print_sub_scores(payload.get("sub_scores"))
    _print_risk(payload)
    for f in payload.get("red_flags") or []:
        _out(f'- {f["flag"]}: -{f["penalty"]} {f["detail"]}')
    pct = payload.get("percentile")
    if pct and pct.get("beat") is not None:
        _out(f'beats {pct["beat"]}% of {pct["total"]} scored accounts')
    _out(_profile_link(host, payload["username"]))


def _cmd_scan(args: argparse.Namespace) -> None:
    if args.local:
        scan = _local_scan(args, args.username)
    else:
        scan = _client(args).scan(args.username, verify_exists=args.verify_exists)
    _out_json(scan)


def _cmd_roast(args: argparse.Namespace) -> None:
    host = _resolve_host(args)
    lang = args.lang
    mode = _output_mode(args, "markdown")
    gh = _client(args)
    # --local crawls + scores on the caller's machine, then sends only the scan to
    # the server for the prose (which still needs a model — the server's or BYO).
    scan = _local_scan(args, args.username) if args.local else None
    roast = gh.roast(
        username=None if scan else args.username,
        scan=scan,
        lang=lang,
        byo_key=_byo_key(args),
    )
    if mode == "json":
        body: Dict[str, Any] = {
            "username": args.username,
            "lang": lang,
            "meta": roast.get("meta"),
            "report": roast.get("report"),
        }
        if args.include_scan and scan:
            body["scan"] = scan
        _out_json(body)
        return
    meta = roast.get("meta") or {}
    if mode == "markdown":
        _out(roast.get("report", ""))
        _out(_profile_link(host, args.username))
        return
    _out(f'{args.username}: {meta.get("final_score")}/100 {meta.get("tier")} ({meta.get("tier_label")})')
    line = (meta.get("roast_line") or {}).get(lang) or (meta.get("roast_line") or {}).get("zh")
    if line:
        _out(line)
    _out("")
    _out(roast.get("report", ""))
    _out(_profile_link(host, args.username))


def _cmd_vs(args: argparse.Namespace) -> None:
    host = _resolve_host(args)
    result = _client(args).vs(args.a, args.b)
    if _output_mode(args) == "json":
        _out_json(result)
        return
    winner = result.get("winner")
    if winner:
        bucket = f' ({result["bucket"]})' if result.get("bucket") else ""
        _out(f"winner: {winner}{bucket}")
    else:
        reason = f' ({result["reason"]})' if result.get("reason") else ""
        _out(f"result: tie{reason}")
    verdict = (result.get("verdict") or {})
    line = verdict.get("en") if args.lang == "en" else verdict.get("zh")
    if line:
        _out(line)
    _out(f"\n→ {host}/vs/{args.a}/{args.b}")


def _cmd_exists(args: argparse.Namespace) -> None:
    user = _client(args).get_github_user(args.username, token=_github_token(args))
    if _output_mode(args) == "json":
        _out_json({"username": args.username, "exists": user is not None, "user": user})
        return
    _out(f"{args.username}: {'exists' if user else 'does not exist'}")


def _cmd_search(args: argparse.Namespace) -> None:
    result = _client(args).search_users(args.query)
    if _output_mode(args) == "json":
        _out_json(result)
        return
    for u in result.get("users", []):
        _out(f'{u["username"]}\t{u["final_score"]}/100 {u["tier"]}')


def _cmd_leaderboard(args: argparse.Namespace) -> None:
    _out_json(_client(args).leaderboard(view=args.view, window=args.window))


def _cmd_developers(args: argparse.Namespace) -> None:
    _out_json(_client(args).developers(type=args.type, value=args.value))


def _cmd_stats(args: argparse.Namespace) -> None:
    _out_json(_client(args).stats())


def _cmd_badge(args: argparse.Namespace) -> None:
    gh = _client(args)
    badge = gh.badge_url(args.username, lang="en" if args.lang == "en" else None)
    profile = f"{_resolve_host(args)}/u/{args.username}"
    if args.markdown:
        _out(f"[![ghfind score]({badge})]({profile})")
        return
    if _output_mode(args) == "json":
        _out_json({"badge_url": badge, "card_url": gh.card_url(args.username), "profile": profile})
        return
    _out(badge)


def _cmd_card(args: argparse.Namespace) -> None:
    _out(_client(args).card_url(args.username))


def _cmd_commands(args: argparse.Namespace) -> None:
    rest: List[str] = args.rest or []
    if rest and rest[0] == "show":
        name = " ".join(rest[1:])
        cap = next(
            (c for c in CATALOG if c["method"] == name or name in c["method"].split(" / ")),
            None,
        )
        if not cap:
            _fail(f"Unknown capability: {name}")
        _out_json(cap)
        return
    if getattr(args, "json", False):
        _out_json({"default_host": DEFAULT_HOST, "capabilities": CATALOG})
        return
    for c in CATALOG:
        _out(f'{c["method"]}\t{c["summary"]}')


def _cmd_auth_status(args: argparse.Namespace) -> None:
    api_key = (
        getattr(args, "api_key", None)
        or os.environ.get("GHFIND_API_KEY")
        or os.environ.get("GITHUB_ROAST_API_KEY")
    )
    byo = bool(
        (os.environ.get("GHFIND_BYO_BASE_URL"))
        and os.environ.get("GHFIND_BYO_API_KEY")
        and os.environ.get("GHFIND_BYO_MODEL")
    )
    body = {
        "host": _resolve_host(args),
        "default_host": DEFAULT_HOST,
        "has_api_key": bool(api_key),
        "has_github_token": bool(_github_token(args)),
        "has_byo_key": byo,
        "env": {
            "primary": [
                "GHFIND_HOST",
                "GHFIND_API_KEY",
                "GITHUB_TOKEN",
                "GHFIND_BYO_BASE_URL",
                "GHFIND_BYO_API_KEY",
                "GHFIND_BYO_MODEL",
            ],
            "compatible": ["GITHUB_ROAST_HOST", "GITHUB_ROAST_API_KEY"],
        },
    }
    if _output_mode(args) == "json":
        _out_json(body)
        return
    _out(f'host: {body["host"]}')
    _out(f'api key: {"configured" if body["has_api_key"] else "missing"}')
    _out(f'github token (for --local / exists): {"configured" if body["has_github_token"] else "missing"}')
    _out(f'byo llm key (for roast): {"configured" if body["has_byo_key"] else "missing"}')


# ---- parser ----------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ghfind",
        description="Score any GitHub account 0-100 (deterministic, no LLM) + roasts, battles, leaderboards.",
    )
    parser.add_argument("--version", action="version", version=f"ghfind {__version__}")

    # Options shared by every network command.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--host")
    common.add_argument("--api-key")
    common.add_argument("--github-token")
    common.add_argument("--json", action="store_true", help="shorthand for -o json")
    common.add_argument("-o", "--output", choices=["json", "pretty", "markdown"])

    sub = parser.add_subparsers(dest="command", required=True)

    def add(name: str, func, parents=(common,), **kw):
        p = sub.add_parser(name, parents=list(parents), **kw)
        p.set_defaults(func=func)
        return p

    p = add("score", _cmd_score, help="Deterministic score via GET /api/score (no auth, cached).")
    p.add_argument("username")
    p.add_argument("--local", action="store_true", help="score offline with your GITHUB_TOKEN")
    p.add_argument("--verify-exists", action="store_true", help="confirm the login exists first")

    p = add("scan", _cmd_scan, help="Full evidence payload via POST /api/scan (heavy; needs --api-key in prod).")
    p.add_argument("username")
    p.add_argument("--local", action="store_true", help="crawl + score offline with your GITHUB_TOKEN")
    p.add_argument("--verify-exists", action="store_true")

    p = add("roast", _cmd_roast, help="Human-facing roast report (LLM). --byo-* to use your own model.")
    p.add_argument("username")
    p.add_argument("--lang", choices=["zh", "en"], default="zh")
    p.add_argument("--local", action="store_true", help="crawl the scan offline, then only send it for prose")
    p.add_argument("--byo-base-url")
    p.add_argument("--byo-api-key")
    p.add_argument("--byo-model")
    p.add_argument("--include-scan", action="store_true", help="embed the scan in --json output")

    p = add("vs", _cmd_vs, help="Head-to-head verdict (winner deterministic).")
    p.add_argument("a")
    p.add_argument("b")
    p.add_argument("--lang", choices=["zh", "en"], default="zh")

    p = add("exists", _cmd_exists, help="Check a GitHub login exists (client-side; never touches ghfind).")
    p.add_argument("username")

    p = add("search", _cmd_search, help="Prefix autocomplete over scored accounts.")
    p.add_argument("query")

    p = add("leaderboard", _cmd_leaderboard, help="Ranked public profiles.")
    p.add_argument("--view", choices=["trending", "score", "heat", "progress"])
    p.add_argument("--window", choices=["all", "24h", "7d", "30d"])

    p = add("developers", _cmd_developers, help="Discover developers by language|org|repo.")
    p.add_argument("--type", required=True, choices=["language", "org", "repo"])
    p.add_argument("--value")

    add("stats", _cmd_stats, help="Platform totals.")

    p = add("badge", _cmd_badge, help="Print the score badge URL. --markdown for a README snippet.")
    p.add_argument("username")
    p.add_argument("--markdown", "--md", action="store_true", dest="markdown")
    p.add_argument("--lang", choices=["zh", "en"], default="zh")

    p = add("card", _cmd_card, help="Print the OG share-card URL.")
    p.add_argument("username")

    p = add("commands", _cmd_commands, help="List agent-callable capabilities (self-describing).")
    p.add_argument("rest", nargs="*", help="'show <capability>' to detail one")

    auth = sub.add_parser("auth", help="Credential status.")
    auth_sub = auth.add_subparsers(dest="auth_command", required=True)
    ap = auth_sub.add_parser("status", parents=[common])
    ap.set_defaults(func=_cmd_auth_status)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        args.func(args)
    except GhFindError as e:
        suffix = f" ({e.code})" if e.code else ""
        sys.stderr.write(f"{e}{suffix}\n")
        return 2 if e.status == 429 else 1
    except SystemExit as e:  # _fail() raises this with a code
        return int(e.code or 0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
