"""ghfind.local — LOCAL deterministic scoring (mirrors the JS ``ghfind/local``).

Runs the faithful Python port of the website's open-source scoring core
(`_github.collect` + `_score.score`) entirely on your machine and GitHub token —
no ghfind server, no LLM. Results match the website's deterministic score.

    from ghfind.local import collect_and_score
    scan = collect_and_score("torvalds", token=os.environ["GITHUB_TOKEN"])
    print(scan["scoring"]["final_score"], scan["scoring"]["red_flags"])

No token? Use the remote client instead: ``GhFind().get_score(username)`` — the
ghfind server does the crawl + deterministic scoring for you.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Mapping, Optional

from ._github import (
    AccountNotFoundError,
    GitHubAuthRequiredError,
    GitHubDataUnavailableError,
    GitHubRateLimitError,
    collect,
    _with_github_token,
)
from ._score import score

__all__ = [
    "collect_and_score",
    "score_metrics",
    "AccountNotFoundError",
    "GitHubAuthRequiredError",
    "GitHubDataUnavailableError",
    "GitHubRateLimitError",
]


def score_metrics(metrics: Mapping[str, Any]) -> Dict[str, Any]:
    """Run the pure deterministic scorer over metrics you already have. No I/O."""
    return score(metrics)


def collect_and_score(username: str, *, token: Optional[str] = None) -> Dict[str, Any]:
    """Crawl GitHub and compute the full deterministic scan + score locally.

    Identical shape to ``GhFind().scan()`` / ``POST /api/scan`` but runs on your
    machine and your GitHub token. ``token`` falls back to ``GITHUB_TOKEN``. Raises
    ``GitHubAuthRequiredError`` if neither is set (local scoring makes many
    authenticated GitHub API calls), and ``AccountNotFoundError`` for a login that
    does not exist.
    """
    resolved_token = token if token is not None else os.environ.get("GITHUB_TOKEN", "")
    if not resolved_token.strip():
        raise GitHubAuthRequiredError(
            "collect_and_score needs a GitHub token: pass token=... or set GITHUB_TOKEN. "
            "Local scoring makes many authenticated GitHub API calls."
        )
    with _with_github_token(resolved_token):
        data = collect(username)
        return {**data, "scoring": score(data["metrics"])}
