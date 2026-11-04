"""ghfind.local — verify ghfind scores locally (mirrors the JS ``ghfind/local``).

Runs the Python port of the public scoring module (``@ghfind/scoring``; parity is
pinned by the shared fixtures in ``scoring/fixtures``) so you can recompute any
score from its published evidence. It never calls GitHub or ghfind and needs no
token. No LLM is involved.

    from ghfind import GhFind
    from ghfind.local import verify_scan
    scan = GhFind(api_key=...).scan("torvalds")
    check = verify_scan(scan)
    print(check["verified"], check["differences"])

Collecting evidence from GitHub happens on the ghfind service (it is rate limited
and runs against a managed token pool), so local crawling was removed in 0.2.0.
Get a scan from the remote client and verify it here.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Mapping

from ._score import score

__all__ = ["score_metrics", "verify_scan"]

_COMPARED_FIELDS = ("final_score", "base_score", "total_penalty", "tier")
_NUMERIC_TOLERANCE = 1e-9


def score_metrics(metrics: Mapping[str, Any]) -> Dict[str, Any]:
    """Run the pure deterministic scorer over metrics you already have. No I/O."""
    return score(metrics)


def _same(a: Any, b: Any) -> bool:
    numeric = (int, float)
    if isinstance(a, numeric) and isinstance(b, numeric) and not isinstance(a, bool) and not isinstance(b, bool):
        return math.isclose(a, b, rel_tol=0, abs_tol=_NUMERIC_TOLERANCE)
    return a == b


def verify_scan(scan: Mapping[str, Any]) -> Dict[str, Any]:
    """Recompute ``scan["scoring"]`` from ``scan["metrics"]`` and compare.

    Returns ``{"verified": bool, "local": <Scoring>, "differences": [{"field",
    "server", "local"}]}``. A difference means the scan was altered or was scored
    by a different version of the scoring module than this SDK bundles (upgrade
    the SDK and retry). Raises ``TypeError`` for payloads without evidence.
    """
    metrics = scan.get("metrics") if isinstance(scan, Mapping) else None
    server = scan.get("scoring") if isinstance(scan, Mapping) else None
    if not isinstance(metrics, Mapping) or not isinstance(metrics.get("username"), str) \
            or not isinstance(server, Mapping) or not isinstance(server.get("sub_scores"), Mapping):
        raise TypeError("verify_scan needs a full scan with 'metrics' and 'scoring' (from GhFind.scan()).")
    try:
        local = score_metrics(metrics)
    except (KeyError, TypeError, ValueError) as e:
        raise TypeError(f"verify_scan: scan 'metrics' is incomplete or malformed ({type(e).__name__}: {e}).") from e
    differences: List[Dict[str, Any]] = []
    for field in _COMPARED_FIELDS:
        if not _same(server.get(field), local.get(field)):
            differences.append({"field": field, "server": server.get(field), "local": local.get(field)})
    server_subs = server.get("sub_scores") or {}
    local_subs = local.get("sub_scores") or {}
    for name in sorted(set(server_subs) | set(local_subs)):
        if not _same(server_subs.get(name), local_subs.get(name)):
            differences.append({"field": f"sub_scores.{name}", "server": server_subs.get(name), "local": local_subs.get(name)})
    return {"verified": not differences, "local": local, "differences": differences}
