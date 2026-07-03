"""GitHub public-signal collection — faithful Python port of the website's
``src/lib/github.ts`` ``collect()`` and its deterministic helpers.

Uses direct REST + GraphQL calls authenticated with a PAT (``GITHUB_TOKEN``).
Output mirrors ``collect()``'s ``metrics`` / ``top_repos`` / ``recent_prs`` shape
exactly so the scoring port (`_score.py`) consumes it unchanged.

Sync (stdlib ``urllib``) — where the TS uses ``Promise.all`` for concurrency, this
runs sequentially; the derived metrics are order-independent, so results match.
"""

from __future__ import annotations

import base64
import json
import math
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from ._score import log_ratio

GITHUB_API = "https://api.github.com"
README_FETCH_LIMIT = 1024 * 1024
README_PROMPT_SUMMARY_LIMIT = 1500

IMPACT_YEAR_CAP = 6
IMPACT_COMMIT_MIN = 2
ORG_ATTRIBUTED_MIN_SCORE = 5
ORG_ATTRIBUTED_COMMIT_MIN = 50
ORG_ATTRIBUTED_MIXED_COMMIT_MIN = 20
ORG_ATTRIBUTED_MIXED_PR_MIN = 10
ORG_ATTRIBUTED_ACTIVE_YEAR_MIN = 2


class AccountNotFoundError(Exception):
    pass


class GitHubRateLimitError(Exception):
    pass


class GitHubAuthRequiredError(Exception):
    pass


class GitHubDataUnavailableError(Exception):
    pass


def _math_round(x: float) -> int:
    return math.floor(x + 0.5)


def _auth_headers() -> Dict[str, str]:
    token = os.environ.get("GITHUB_TOKEN")
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ghfind",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _http(method: str, url: str, headers: Dict[str, str], body: Optional[bytes]) -> Tuple[int, Dict[str, str], bytes]:
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as e:
        data = e.read() if e.fp else b""
        return e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, data
    except urllib.error.URLError:
        return 0, {}, b""


def _rest_get(path: str) -> Any:
    """GET api.github.com/{path}. Raises on 404 / rate-limit (like TS restGet)."""
    status, headers, body = _http("GET", f"{GITHUB_API}/{path}", _auth_headers(), None)
    if status == 0:
        return None
    if status == 404:
        raise AccountNotFoundError()
    if status in (403, 429):
        if headers.get("x-ratelimit-remaining") == "0":
            raise GitHubRateLimitError()
        return None
    if not 200 <= status < 300:
        return None
    try:
        return json.loads(body)
    except ValueError:
        return None


def _rest_get_opt(path: str) -> Any:
    """restGet(...).catch(() => null) — swallow ALL errors to None."""
    try:
        return _rest_get(path)
    except Exception:
        return None


def _graphql(query: str, variables: Dict[str, Any]) -> Any:
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        raise GitHubAuthRequiredError("GITHUB_TOKEN is required.")
    headers = {**_auth_headers(), "Content-Type": "application/json"}
    payload = json.dumps({"query": query, "variables": variables}).encode("utf-8")
    status, _, body = _http("POST", f"{GITHUB_API}/graphql", headers, payload)
    if status == 0:
        raise GitHubDataUnavailableError("GitHub GraphQL request failed.")
    if status in (403, 429):
        raise GitHubRateLimitError()
    if not 200 <= status < 300:
        raise GitHubDataUnavailableError(f"GitHub GraphQL HTTP {status}.")
    try:
        j = json.loads(body)
    except ValueError:
        raise GitHubDataUnavailableError("GitHub GraphQL returned invalid JSON.")
    if j.get("errors"):
        message = (j["errors"][0] or {}).get("message") or "GitHub GraphQL error."
        if re.search(r"rate.?limit", message, re.I):
            raise GitHubRateLimitError(message)
        raise GitHubDataUnavailableError(message)
    if not j.get("data"):
        raise GitHubDataUnavailableError("GitHub GraphQL returned no data.")
    return j["data"]


def _read_text_with_limit(url: str, limit: int) -> Optional[Dict[str, Any]]:
    headers = {"User-Agent": "github-roast", "Range": f"bytes=0-{limit - 1}"}
    status, _, body = _http("GET", url, headers, None)
    if status == 0 or not 200 <= status < 300:
        return None
    truncated = len(body) >= limit
    data = body[:limit]
    return {"text": data.decode("utf-8", "replace"), "truncated": truncated}


# --- pure helpers -----------------------------------------------------------

def _parse_ts(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        s = value.strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        d = datetime.fromisoformat(s)
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d
    except Exception:
        return None


def _ms(dt: datetime) -> float:
    return dt.timestamp() * 1000.0


def bounded_contribution_years_active(
    contribution_years: List[int], created_at: Optional[str], now: datetime
) -> int:
    active_years = {y for y in contribution_years if isinstance(y, int)}
    if len(active_years) == 0:
        return 0
    created = _parse_ts(created_at)
    if not created:
        return len(active_years)
    created_year = created.astimezone(timezone.utc).year
    current_year = now.astimezone(timezone.utc).year
    if current_year < created_year:
        return 0
    return sum(1 for y in active_years if created_year <= y <= current_year)


def _meaningful_text(value: Optional[str]) -> str:
    text = value or ""
    text = re.sub(r"<[^>]*>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _repo_display_name(repo: Dict[str, Any]) -> str:
    return repo.get("name_with_owner") or repo["name"]


def _is_likely_placeholder_project(repo: Dict[str, Any], login_lower: str) -> bool:
    name = repo["name"].lower()
    if not repo.get("attributed_original") and name == login_lower:
        return True
    name_and_desc = f"{name} {repo.get('description') or ''}".lower()
    if re.search(
        r"\b(wip|todo|tmp|temp|scratch|playground|practice|learning|notes?|leetcode|algorithm|blog|profile)\b",
        name_and_desc,
    ):
        return True
    readme = (repo.get("readme_excerpt") or "").lower()
    placeholder = 0
    if repo.get("readme"):
        placeholder = repo["readme"]["features"].get("placeholder_score", 0)
    return placeholder >= 0.6 or bool(
        re.search(r"\b(wip|todo|scratch project|playground only|learning notes)\b", readme)
    )


def original_repo_quality_score(repo: Dict[str, Any], login_lower: str, now: datetime) -> float:
    if repo["size"] <= 0:
        return 0
    readme = repo["readme"]["features"] if repo.get("readme") else None
    readme_len = readme["length"] if readme else len(_meaningful_text(repo.get("readme_excerpt")))
    desc = _meaningful_text(repo.get("description"))
    pushed = _parse_ts(repo.get("pushed_at"))
    age_days = math.floor((_ms(now) - _ms(pushed)) / (1000 * 60 * 60 * 24)) if pushed else None

    s = 0.0
    if repo["size"] >= 1000:
        s += 0.25
    elif repo["size"] >= 200:
        s += 0.2
    elif repo["size"] >= 50:
        s += 0.15
    elif repo["size"] >= 10:
        s += 0.08

    if repo.get("language"):
        s += 0.15
    if len(desc) >= 20:
        s += 0.15

    if readme_len >= 800:
        s += 0.25
    elif readme_len >= 300:
        s += 0.2
    elif readme_len >= 120:
        s += 0.12

    if readme:
        signal = (
            readme["has_install"] or readme["has_usage"] or readme["has_api"] or readme["has_demo"]
            or readme["has_features"] or readme["has_deploy"] or readme["has_test"]
            or readme["has_architecture"] or readme["has_screenshot"]
        )
    else:
        signal = bool(
            re.search(
                r"\b(install|usage|quickstart|quick start|api|demo|features?|deploy|architecture|test|screenshot)\b",
                repo.get("readme_excerpt") or "", re.I,
            )
        )
    if signal:
        s += 0.1

    if age_days is not None:
        if age_days <= 180:
            s += 0.1
        elif age_days <= 365:
            s += 0.07
        elif age_days <= 730:
            s += 0.04

    if _is_likely_placeholder_project(repo, login_lower):
        s *= 0.55 if (readme_len >= 600 and repo["size"] >= 200) else 0.25

    return _math_round(max(0.0, min(s, 1)) * 100) / 100


def best_original_repo_quality(repos: List[Dict[str, Any]], login_lower: str, now: datetime) -> Dict[str, Any]:
    best = {"score": 0, "repo": None}
    for repo in repos:
        sc = original_repo_quality_score(repo, login_lower, now)
        if sc > best["score"]:
            best = {"score": sc, "repo": _repo_display_name(repo)}
    return best


def top_starred_original_repo_quality(repos: List[Dict[str, Any]], login_lower: str, now: datetime) -> Dict[str, Any]:
    starred = [r for r in repos if r["stars"] > 0]
    if not starred:
        return {"score": 0, "repo": None}
    top = sorted(starred, key=lambda r: r["stars"], reverse=True)[0]
    return {"score": original_repo_quality_score(top, login_lower, now), "repo": _repo_display_name(top)}


def _clean_readme_line(line: str) -> str:
    trimmed = line.strip()
    if not trimmed or re.match(r"^(\[!\[|!\[)", trimmed):
        return ""
    t = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", trimmed)
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)
    t = re.sub(r"[`*_>|#]", " ", t)
    t = re.sub(r"\s+", " ", t)
    return t.strip()


def _text_matches(text: str, words: List[str]) -> bool:
    return any(re.search(r"\b" + w + r"\b", text, re.I) for w in words)


def _clamp_text(text: str, limit: int) -> str:
    clean = re.sub(r"\s+", " ", text).strip()
    return (clean[: limit - 1] + "…") if len(clean) > limit else clean


def parse_readme_features(markdown: str) -> Dict[str, Any]:
    md = markdown.replace("\r\n", "\n").replace("\r", "\n")
    md = re.sub(r"<!--[\s\S]*?-->", "\n", md)
    lines = md.split("\n")
    headings: List[Dict[str, Any]] = []
    sections: List[Dict[str, str]] = []
    current_title = "intro"
    current_lines: List[str] = []
    in_code = False
    has_screenshot_image = False

    def push_section() -> None:
        nonlocal current_lines
        text = " ".join(x for x in (_clean_readme_line(l) for l in current_lines) if x)
        sections.append({"title": current_title, "text": text})
        current_lines = []

    for line in lines:
        if re.match(r"^\s*(```|~~~)", line):
            in_code = not in_code
            continue
        if in_code:
            continue
        image_text = " ".join(
            f"{m.group(1)} {m.group(2)}" for m in re.finditer(r"!\[([^\]]*)\]\(([^)]+)\)", line)
        )
        if image_text and _text_matches(
            f"{_clean_readme_line(line)} {image_text}",
            ["screenshot", "screenshots", "screen", "demo", "preview"],
        ):
            has_screenshot_image = True
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", line)
        if heading:
            push_section()
            current_title = _clean_readme_line(heading.group(2))
            headings.append({"level": len(heading.group(1)), "title": current_title})
            continue
        current_lines.append(line)
    push_section()

    useful_text = " ".join(f"{s['title']} {s['text']}" for s in sections)
    length = len(_meaningful_text(useful_text))
    signals = {
        "install": _text_matches(useful_text, ["install", "installation", "setup"]),
        "usage": _text_matches(useful_text, ["usage", "quickstart", "quick start", "examples?", "guide"]),
        "api": _text_matches(useful_text, ["api", "sdk", "reference"]),
        "demo": _text_matches(useful_text, ["demo", "preview", "playground"]),
        "features": _text_matches(useful_text, ["features?"]),
        "deploy": _text_matches(useful_text, ["deploy", "deployment"]),
        "test": _text_matches(useful_text, ["test", "testing", "tests"]),
        "architecture": _text_matches(useful_text, ["architecture", "design", "internals"]),
        "screenshot": has_screenshot_image or _text_matches(useful_text, ["screenshot", "screenshots", "screen"]),
    }
    placeholder_hits = sum(
        1
        for pat in [r"\bwip\b", r"\btodo\b", r"\bscratch\b", r"\bplayground only\b", r"\blearning notes?\b"]
        if re.search(pat, useful_text, re.I)
    )
    signal_count = sum(1 for v in signals.values() if v)
    placeholder_score = min(1, placeholder_hits * 0.35 + (0.3 if (length < 300 and placeholder_hits > 0) else 0))
    content_depth_score = min(
        1,
        (0.35 if length >= 800 else 0.2 if length >= 300 else 0.1 if length >= 120 else 0)
        + min(len(headings), 5) * 0.06
        + min(signal_count, 5) * 0.07,
    )
    title = next((h["title"] for h in headings if h["level"] == 1), headings[0]["title"] if headings else None)
    intro = next((s["text"] for s in sections if s["title"] == "intro" and s["text"]), None)
    if intro is None:
        intro = next((s["text"] for s in sections if s["text"]), "")
    picked = [
        s for s in sections
        if _text_matches(
            s["title"],
            ["install", "installation", "setup", "usage", "quickstart", "quick start", "api",
             "architecture", "design", "test", "demo", "features?", "deploy", "deployment"],
        )
    ][:4]
    prompt_parts = [
        p for p in [
            f"Title: {title}" if title else "",
            f"Intro: {_clamp_text(intro, 350)}" if intro else "",
            f"Sections: {', '.join(h['title'] for h in headings[:12])}" if headings else "",
            *[f"{s['title']}: {_clamp_text(s['text'], 220)}" for s in picked],
            (
                "Signals: " + ", ".join(name for name, present in signals.items() if present)
                if signal_count else ""
            ),
        ] if p
    ]

    return {
        "length": length,
        "heading_count": len(headings),
        "has_install": signals["install"],
        "has_usage": signals["usage"],
        "has_api": signals["api"],
        "has_demo": signals["demo"],
        "has_features": signals["features"],
        "has_deploy": signals["deploy"],
        "has_test": signals["test"],
        "has_architecture": signals["architecture"],
        "has_screenshot": signals["screenshot"],
        "placeholder_score": _math_round(placeholder_score * 100) / 100,
        "content_depth_score": _math_round(content_depth_score * 100) / 100,
        "prompt_summary": _clamp_text("\n".join(prompt_parts), README_PROMPT_SUMMARY_LIMIT),
    }


def _fetch_readme_document(owner: str, repo: str) -> Optional[Dict[str, Any]]:
    data = _rest_get_opt(f"repos/{owner}/{repo}/readme")
    if not data:
        return None
    markdown: Optional[str] = None
    size = data.get("size") or 0
    truncated = size > README_FETCH_LIMIT
    try:
        if data.get("content") and data.get("encoding") == "base64" and size <= README_FETCH_LIMIT:
            raw = re.sub(r"\s+", "", data["content"])
            markdown = base64.b64decode(raw).decode("utf-8", "replace")
        elif data.get("download_url"):
            got = _read_text_with_limit(data["download_url"], README_FETCH_LIMIT)
            markdown = got["text"] if got else None
            truncated = truncated or (got["truncated"] if got else False)
    except Exception:
        return None
    if markdown is None:
        return None
    features = parse_readme_features(markdown)
    return {
        "path": data.get("path") or "README",
        "sha": data.get("sha"),
        "size": data.get("size") if data.get("size") is not None else len(markdown),
        "html_url": data.get("html_url"),
        "truncated": truncated,
        "features": features,
    }


def _fetch_repo_languages(owner: str, repo: str) -> List[Dict[str, Any]]:
    data = _rest_get_opt(f"repos/{owner}/{repo}/languages")
    if not data:
        return []
    items = [{"name": name, "size": size or 0} for name, size in data.items()]
    return sorted(items, key=lambda x: x["size"], reverse=True)


def _fetch_repo_details(owner: str, repo: str) -> Optional[Dict[str, Any]]:
    return _rest_get_opt(f"repos/{owner}/{repo}")


def _has_release_or_tag_author(owner: str, repo: str, login_lower: str) -> bool:
    releases = _rest_get_opt(f"repos/{owner}/{repo}/releases?per_page=10")
    if releases and any(
        ((r.get("author") or {}).get("login") or "").lower() == login_lower for r in releases
    ):
        return True
    tags = _rest_get_opt(f"repos/{owner}/{repo}/tags?per_page=5")
    if not tags:
        return False
    shas = [t["commit"]["sha"] for t in tags if (t.get("commit") or {}).get("sha")][:5]
    for sha in shas:
        c = _rest_get_opt(f"repos/{owner}/{repo}/commits/{sha}")
        if not c:
            continue
        author = ((c.get("author") or {}).get("login") or "").lower()
        committer = ((c.get("committer") or {}).get("login") or "").lower()
        if author == login_lower or committer == login_lower:
            return True
    return False


_MAINTAINER_FILE_PATHS = [
    "MAINTAINERS", "MAINTAINERS.md", "CODEOWNERS", ".github/CODEOWNERS",
    "docs/MAINTAINERS.md", "docs/maintainers.md",
]


def _maintainer_text_matches_user(text: str, login_lower: str, profile_url: Optional[str]) -> bool:
    lower = text.lower()
    if re.search(r"(^|[^a-z0-9-])@?" + re.escape(login_lower) + r"([^a-z0-9-]|$)", lower):
        return True
    if profile_url and profile_url.lower() in lower:
        return True
    return f"github.com/{login_lower}" in lower


def _has_maintainer_file_hit(owner: str, repo: str, login_lower: str, profile_url: Optional[str]) -> bool:
    for path in _MAINTAINER_FILE_PATHS:
        encoded = urllib.parse.quote(path, safe="/")
        data = _rest_get_opt(f"repos/{owner}/{repo}/contents/{encoded}")
        if not data or not data.get("content") or data.get("encoding") != "base64":
            continue
        try:
            text = base64.b64decode(re.sub(r"\s+", "", data["content"])).decode("utf-8", "replace")
            if _maintainer_text_matches_user(text, login_lower, profile_url):
                return True
        except Exception:
            pass
    return False


def _repo_to_top_repo(repo: Dict[str, Any], fallback_owner: str, attribution: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    owner = (repo.get("owner") or {}).get("login") or (
        repo["full_name"].split("/")[0] if repo.get("full_name") else fallback_owner
    )
    return {
        "name": repo["name"],
        "owner_login": owner,
        "name_with_owner": repo.get("full_name") or f"{owner}/{repo['name']}",
        "stars": repo.get("stargazers_count") or 0,
        "forks": repo.get("forks_count") or 0,
        "open_issues": repo.get("open_issues_count") or 0,
        "size": repo.get("size") or 0,
        "language": repo.get("language"),
        "description": repo.get("description"),
        "pushed_at": repo.get("pushed_at"),
        "topics": repo.get("topics") or [],
        "attributed_original": attribution is not None,
        "attribution_evidence": attribution.get("evidence") if attribution else None,
    }


def _has_doc_like_topic(repo: Dict[str, Any]) -> bool:
    return any(
        re.match(r"^(docs?|documentation|website|blog|examples?|templates?|tutorials?|guides?|manual)$", t, re.I)
        for t in (repo.get("topics") or [])
    )


def compute_closed_pr_breakdown(nodes: List[Dict[str, Any]], total: int, login_lower: str) -> Dict[str, int]:
    maintainer_closed = 0
    self_closed_external = 0
    self_closed_own_repo = 0
    unknown_closed = max(0, total - len(nodes))
    for node in nodes:
        author = ((node.get("author") or {}).get("login") or login_lower).lower()
        repo_owner = ((node.get("repository") or {}).get("owner") or {}).get("login")
        repo_owner = (repo_owner or "").lower()
        tl = (node.get("timelineItems") or {}).get("nodes") or []
        actor = ""
        if tl and tl[0] and (tl[0].get("actor") or {}).get("login"):
            actor = tl[0]["actor"]["login"].lower()
        if not actor:
            unknown_closed += 1
        elif actor == author or actor == login_lower:
            if repo_owner == login_lower:
                self_closed_own_repo += 1
            else:
                self_closed_external += 1
        elif repo_owner == login_lower:
            unknown_closed += 1
        else:
            maintainer_closed += 1
    return {
        "closed_unmerged_pr_count": total,
        "maintainer_closed_unmerged_pr_count": maintainer_closed,
        "self_closed_external_pr_count": self_closed_external,
        "self_closed_own_repo_pr_count": self_closed_own_repo,
        "unknown_closed_unmerged_pr_count": unknown_closed,
    }


def compute_flood_signals(prs: List[Dict[str, str]], login_lower: str = "") -> Dict[str, Any]:
    sample = len(prs)
    if sample == 0:
        return {
            "recent_pr_sample": 0, "top_repo_pr_target": None, "top_repo_pr_share": 0,
            "templated_pr_ratio": 0, "pr_flood_suspect": False, "flood_pr_titles": [],
        }
    repo_counts: Dict[str, int] = {}
    for p in prs:
        repo_counts[p["repo"]] = repo_counts.get(p["repo"], 0) + 1
    top_repo = None
    top_repo_count = 0
    for repo, n in repo_counts.items():
        if n > top_repo_count:
            top_repo = repo
            top_repo_count = n
    top_repo_share = _math_round((top_repo_count / sample) * 100) / 100

    def prefix(t: str) -> str:
        return re.sub(r"\s+", " ", t.lower()).strip()[:18]

    clusters: Dict[str, List[str]] = {}
    for p in prs:
        clusters.setdefault(prefix(p["title"]), []).append(p["title"])
    biggest: List[str] = []
    for arr in clusters.values():
        if len(arr) > len(biggest):
            biggest = arr
    templated_ratio = _math_round((len(biggest) / sample) * 100) / 100

    top_owner = top_repo.split("/")[0].lower() if (top_repo and "/" in top_repo) else ""
    top_is_external = top_owner != "" and top_owner != login_lower
    suspect = sample >= 10 and top_is_external and top_repo_share >= 0.5 and templated_ratio >= 0.5
    return {
        "recent_pr_sample": sample,
        "top_repo_pr_target": top_repo,
        "top_repo_pr_share": top_repo_share,
        "templated_pr_ratio": templated_ratio,
        "pr_flood_suspect": suspect,
        "flood_pr_titles": biggest[:5],
    }


def is_ecosystem_impact_pr(pr: Dict[str, Any], login_lower: str) -> bool:
    repo = pr.get("repo") or ""
    owner = repo.split("/")[0].lower() if "/" in repo else ""
    if not owner or pr["trivial"]:
        return False
    threshold = 1000 if owner == login_lower else 200
    return pr["repo_stars"] >= threshold


def is_external_trivial_farm_pr(pr: Dict[str, Any], login_lower: str) -> bool:
    repo = pr.get("repo") or ""
    owner = repo.split("/")[0].lower() if "/" in repo else ""
    return owner != "" and owner != login_lower and pr["trivial"] and pr["repo_stars"] >= 200


def _repo_owner(name_with_owner: Optional[str]) -> str:
    repo = name_with_owner or ""
    return repo.split("/")[0].lower() if "/" in repo else ""


def _is_own_repo_name(name_with_owner: Optional[str], login_lower: str) -> bool:
    return _repo_owner(name_with_owner) == login_lower


def _is_doc_like_path(path: str) -> bool:
    p = path.lower()
    return bool(
        re.search(r"\.(md|mdx|rst|adoc|txt)$", p, re.I)
        or re.search(
            r"(^|/)(docs?|site|website|blog|content|articles|examples?|templates?|tutorials?|guides?|manual|i18n|locales?)(/|$)",
            p,
        )
        or re.search(r"(^|/)(readme|changelog|contributing|license)(\.[^/]*)?$", p, re.I)
    )


def _is_core_code_path(path: str) -> bool:
    p = path.lower()
    if _is_doc_like_path(p):
        return False
    return bool(re.search(r"\.(c|cc|cpp|cs|go|java|js|jsx|kt|m|mm|php|py|rb|rs|scala|swift|ts|tsx)$", p, re.I))


def is_doc_like_impact_pr(pr: Dict[str, Any]) -> bool:
    if _is_doc_like_repo(pr.get("repo")):
        return True
    title = pr.get("title") or ""
    if re.search(
        r"\b(docs?|readme|typo|translate|translation|i18n|website|site|blog|examples?|templates?|tutorial|guide)\b",
        title, re.I,
    ):
        return True
    files = pr.get("files") or []
    if len(files) == 0:
        return False
    doc_like = sum(1 for f in files if _is_doc_like_path(f))
    core_code = sum(1 for f in files if _is_core_code_path(f))
    return doc_like > 0 and (core_code == 0 or doc_like / len(files) >= 0.6)


def compute_impact_quality_signals(recent_prs: List[Dict[str, Any]], impact_pr_count: int, login_lower: str) -> Dict[str, Any]:
    verified = [p for p in recent_prs if is_ecosystem_impact_pr(p, login_lower)]
    doc_like_count = sum(1 for p in verified if is_doc_like_impact_pr(p))
    core_count = len(verified) - doc_like_count
    unverified = max(0, impact_pr_count - len(verified))
    cap = None
    if impact_pr_count >= 10 and core_count <= 2 and doc_like_count > core_count:
        cap = 4
    elif impact_pr_count >= 10 and doc_like_count > core_count:
        cap = 8
    return {
        "verified_impact_pr_count": len(verified),
        "core_impact_pr_count": core_count,
        "doc_like_impact_pr_count": doc_like_count,
        "unverified_impact_pr_count": unverified,
        "impact_quality_cap": cap,
    }


def _repo_name(name_with_owner: Optional[str]) -> str:
    repo = (name_with_owner or "").lower()
    return repo.split("/")[-1] if "/" in repo else repo


_LOW_SIGNAL_ENTRY_REPOS = {"is-a-dev/register", "tuna/blogroll"}


def _is_low_signal_entry_repo(name_with_owner: Optional[str]) -> bool:
    return (name_with_owner or "").strip().lower() in _LOW_SIGNAL_ENTRY_REPOS


def _is_doc_like_repo(name_with_owner: Optional[str]) -> bool:
    if _is_low_signal_entry_repo(name_with_owner):
        return True
    name = _repo_name(name_with_owner)
    return bool(
        re.search(
            r"(^|[-_.])(docs?|site|website|blog|examples?|templates?|profile|notebook|learning|tutorial|interview|guide|manual)([-_.]|$)",
            name,
        )
    ) or name.endswith(".github.io")


def _has_strong_long_term_org_contribution(repo: Dict[str, Any]) -> bool:
    if repo["active_years"] >= ORG_ATTRIBUTED_ACTIVE_YEAR_MIN:
        if repo["commits"] >= ORG_ATTRIBUTED_COMMIT_MIN:
            return True
        return repo["commits"] >= ORG_ATTRIBUTED_MIXED_COMMIT_MIN and repo["prs"] >= ORG_ATTRIBUTED_MIXED_PR_MIN
    return repo["commits"] >= ORG_ATTRIBUTED_COMMIT_MIN * 2


def compute_org_repo_attribution(
    repo: Dict[str, Any], organizations: List[str], pinned_repos: Optional[List[str]] = None,
    release_or_tag_author_hit: bool = False, maintainer_file_hit: bool = False,
) -> Optional[Dict[str, Any]]:
    owner = repo["owner_login"].lower()
    orgs = {o.lower() for o in organizations}
    if owner not in orgs:
        return None
    if repo["is_private"] or repo["is_fork"]:
        return None
    if _is_doc_like_repo(repo["repo"]):
        return None
    if not _has_strong_long_term_org_contribution(repo):
        return None
    evidence = [
        f"org member of {repo['owner_login']}",
        f"{repo['commits']} commits + {repo['prs']} PRs across {repo['active_years']} years",
    ]
    score = 1 + 4
    if any(r.lower() == repo["repo"].lower() for r in (pinned_repos or [])):
        score += 1
        evidence.append("pinned by user")
    if release_or_tag_author_hit:
        score += 3
        evidence.append("release/tag author")
    if maintainer_file_hit:
        score += 3
        evidence.append("listed in maintainer/codeowner docs")
    return {"repo": repo["repo"], "evidence": evidence, "score": score} if score >= ORG_ATTRIBUTED_MIN_SCORE else None


def compute_impact_from_contrib_map(repos: List[Dict[str, Any]], login_lower: str) -> Dict[str, Any]:
    qualifying = []
    for r in repos:
        if r["is_private"] or r["is_fork"]:
            continue
        # A single merged entry can surface as both one PR and one contribution-
        # graph commit. Exclude that shallow registry/directory entry without
        # discarding sustained maintenance work in the same repository.
        if _is_low_signal_entry_repo(r["repo"]) and r["commits"] <= 1 and r["prs"] <= 1:
            continue
        is_external = r["owner_login"].lower() != login_lower
        threshold = 200 if is_external else 1000
        if r["stars"] < threshold:
            continue
        if r["commits"] >= IMPACT_COMMIT_MIN or r["prs"] >= 1:
            qualifying.append(r)

    max_impact_repo_stars = max((r["stars"] for r in qualifying), default=0)
    depth_sum = 0.0
    for r in qualifying:
        weight = min(1 + math.log10(r["commits"] + r["prs"]), 2.5)
        depth_sum += log_ratio(r["stars"], 5000) * weight
    impact_depth_raw = _math_round(depth_sum * 100) / 100

    impact_repos = sorted(
        [{"repo": r["repo"], "stars": r["stars"], "commits": r["commits"], "prs": r["prs"]} for r in qualifying],
        key=lambda x: x["stars"], reverse=True,
    )[:8]
    return {
        "max_impact_repo_stars": max_impact_repo_stars,
        "impact_depth_raw": impact_depth_raw,
        "impact_repo_count": len(qualifying),
        "impact_commit_count": sum(r["commits"] for r in qualifying),
        "impact_pr_count": sum(r["prs"] for r in qualifying),
        "impact_repos": impact_repos,
    }


# --- async-equivalent fetchers ---------------------------------------------

def _fetch_organizations(username: str) -> List[str]:
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        return []
    query = ("query($login: String!) { user(login: $login) { "
             "organizations(first: 20) { nodes { login } } } }")
    headers = {**_auth_headers(), "Content-Type": "application/json"}
    payload = json.dumps({"query": query, "variables": {"login": username}}).encode("utf-8")
    status, hdrs, body = _http("POST", f"{GITHUB_API}/graphql", headers, payload)
    if status in (403, 429):
        if hdrs.get("x-ratelimit-remaining") == "0":
            raise GitHubRateLimitError()
        return []
    if status == 0 or not 200 <= status < 300:
        return []
    try:
        j = json.loads(body)
    except ValueError:
        return []
    if j.get("errors"):
        return []
    nodes = (((j.get("data") or {}).get("user") or {}).get("organizations") or {}).get("nodes") or []
    return [n["login"] for n in nodes if n and isinstance(n.get("login"), str)]


def _fetch_recent_prs(username: str, count: int = 50) -> List[Dict[str, Any]]:
    query = """query($login: String!, $count: Int!) {
      user(login: $login) {
        pullRequests(first: $count, states: MERGED, orderBy: {field: CREATED_AT, direction: DESC}) {
          nodes {
            title additions deletions changedFiles
            repository { nameWithOwner stargazerCount isPrivate }
            files(first: 50) { nodes { path } }
          }
        }
      }
    }"""
    data = _graphql(query, {"login": username, "count": count})
    if not data.get("user"):
        raise GitHubDataUnavailableError("GitHub GraphQL returned no PR data.")
    nodes = ((data["user"].get("pullRequests") or {}).get("nodes")) or []
    out = []
    for n in nodes:
        repo = n.get("repository")
        churn = (n.get("additions") or 0) + (n.get("deletions") or 0)
        files = [(f or {}).get("path") for f in ((n.get("files") or {}).get("nodes") or [])]
        out.append({
            "title": n.get("title"),
            "repo": repo.get("nameWithOwner") if repo else None,
            "repo_stars": repo.get("stargazerCount") if repo else 0,
            "churn": churn,
            "changed_files": n.get("changedFiles") or 0,
            "trivial": churn <= 5,
            "files": [p for p in files if p],
        })
    return out


def _fetch_recent_all_prs(username: str, count: int = 30) -> List[Dict[str, str]]:
    query = """query($login: String!, $count: Int!) {
      user(login: $login) {
        pullRequests(first: $count, orderBy: {field: CREATED_AT, direction: DESC}) {
          nodes { title repository { nameWithOwner } }
        }
      }
    }"""
    data = _graphql(query, {"login": username, "count": count})
    if not data.get("user"):
        raise GitHubDataUnavailableError("GitHub GraphQL returned no PR data.")
    nodes = ((data["user"].get("pullRequests") or {}).get("nodes")) or []
    return [
        {"title": n["title"], "repo": n["repository"]["nameWithOwner"]}
        for n in nodes if n.get("title") and n.get("repository")
    ]


def _fetch_contrib_repos_by_year(username: str, years: List[int]) -> Optional[List[Dict[str, Any]]]:
    capped = sorted(years, reverse=True)[:IMPACT_YEAR_CAP]
    if len(capped) == 0:
        return None
    fragment = """fragment RepoContribs on ContributionsCollection {
        commitContributionsByRepository(maxRepositories: 100) {
          contributions { totalCount }
          repository { nameWithOwner stargazerCount isPrivate isFork owner { login } }
        }
        pullRequestContributionsByRepository(maxRepositories: 100) {
          contributions { totalCount }
          repository { nameWithOwner stargazerCount isPrivate isFork owner { login } }
        }
      }"""
    var_decls = ", ".join(f"$from{i}: DateTime!, $to{i}: DateTime!" for i in range(len(capped)))
    aliases = "\n        ".join(
        f"y{i}: contributionsCollection(from: $from{i}, to: $to{i}) {{ ...RepoContribs }}"
        for i in range(len(capped))
    )
    query = f"query($login: String!, {var_decls}) {{\n      user(login: $login) {{\n        {aliases}\n      }}\n    }}\n    {fragment}"
    variables: Dict[str, Any] = {"login": username}
    for i, year in enumerate(capped):
        variables[f"from{i}"] = f"{year}-01-01T00:00:00Z"
        variables[f"to{i}"] = f"{year}-12-31T23:59:59Z"

    data = _graphql(query, variables)
    if not data.get("user"):
        raise GitHubDataUnavailableError("GitHub GraphQL returned no contribution data.")

    agg: Dict[str, Dict[str, Any]] = {}
    years_by_repo: Dict[str, set] = {}

    def ingest(node: Dict[str, Any], kind: str, year: int) -> None:
        repo = node.get("repository")
        if not repo:
            return
        key = repo["nameWithOwner"]
        entry = agg.get(key)
        if entry is None:
            entry = {
                "repo": key, "stars": 0, "is_private": repo["isPrivate"], "is_fork": repo["isFork"],
                "owner_login": (repo.get("owner") or {}).get("login") or key.split("/")[0],
                "commits": 0, "prs": 0, "active_years": 0,
            }
            agg[key] = entry
        entry["stars"] = max(entry["stars"], repo.get("stargazerCount") or 0)
        entry[kind] += (node.get("contributions") or {}).get("totalCount") or 0
        years_by_repo.setdefault(key, set()).add(year)

    user = data["user"]
    for i, year in enumerate(capped):
        yc = user.get(f"y{i}")
        if not yc:
            continue
        for n in yc.get("commitContributionsByRepository") or []:
            ingest(n, "commits", year)
        for n in yc.get("pullRequestContributionsByRepository") or []:
            ingest(n, "prs", year)

    result = []
    for key, value in agg.items():
        value = {**value, "active_years": len(years_by_repo.get(key, set()))}
        result.append(value)
    return result


def _collect_attributed_original_repos(
    contrib_repos: List[Dict[str, Any]], organizations: List[str],
    pinned_repos: List[str], login_lower: str, profile_url: Optional[str],
) -> List[Dict[str, Any]]:
    if len(organizations) == 0:
        return []
    candidates = [
        r for r in contrib_repos
        if compute_org_repo_attribution(r, organizations, pinned_repos)
    ]
    candidates.sort(key=lambda r: (r["stars"], r["commits"] + r["prs"]), reverse=True)
    candidates = candidates[:8]

    out = []
    for candidate in candidates:
        parts = candidate["repo"].split("/")
        if len(parts) < 2 or not parts[0] or not parts[1]:
            continue
        owner, name = parts[0], parts[1]
        detail = _fetch_repo_details(owner, name)
        if not detail or detail.get("private") or detail.get("fork"):
            continue
        if _is_doc_like_repo(candidate["repo"]) or _has_doc_like_topic(detail):
            continue
        release_hit = _has_release_or_tag_author(owner, name, login_lower)
        maintainer_hit = _has_maintainer_file_hit(owner, name, login_lower, profile_url)
        attribution = compute_org_repo_attribution(
            candidate, organizations, pinned_repos, release_hit, maintainer_hit
        )
        if not attribution:
            continue
        out.append(_repo_to_top_repo(detail, owner, attribution))
    return out


_CONTRIB_QUERY = """query($login: String!) {
  user(login: $login) {
    pinnedItems(first: 6, types: REPOSITORY) {
      nodes { ... on Repository { nameWithOwner } }
    }
    mergedPRs: pullRequests(states: MERGED) { totalCount }
    allPRs: pullRequests { totalCount }
    closedPRs: pullRequests(states: CLOSED, first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
      totalCount
      nodes {
        author { login }
        repository { owner { login } }
        timelineItems(last: 1, itemTypes: CLOSED_EVENT) {
          nodes { ... on ClosedEvent { actor { login } } }
        }
      }
    }
    issues { totalCount }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalPullRequestReviewContributions
      restrictedContributionsCount
      contributionCalendar { totalContributions }
    }
    contributionYears: contributionsCollection { contributionYears }
  }
}"""


def collect(username: str) -> Dict[str, Any]:
    if not os.environ.get("GITHUB_TOKEN"):
        raise GitHubAuthRequiredError("GITHUB_TOKEN is required for accurate scoring.")

    now = datetime.now(timezone.utc)

    user = _rest_get(f"users/{username}")
    if not user or user.get("id") is None:
        raise AccountNotFoundError()
    login = user.get("login") or username
    login_lower = login.lower()

    repos: List[Dict[str, Any]] = []
    for page in (1, 2):
        chunk = _rest_get(f"users/{username}/repos?per_page=100&sort=pushed&page={page}")
        if not chunk or len(chunk) == 0:
            break
        repos.extend(chunk)
        if len(chunk) < 100:
            break

    original = [r for r in repos if not r.get("fork")]
    forks = [r for r in repos if r.get("fork")]
    empty = [r for r in repos if (r.get("size") or 0) == 0 and not r.get("fork")]
    nonempty_original = [r for r in original if (r.get("size") or 0) > 0]

    contrib = _graphql(_CONTRIB_QUERY, {"login": username})
    if not contrib.get("user"):
        raise GitHubDataUnavailableError("GitHub GraphQL returned no contribution data.")
    cu = contrib["user"]
    cc = cu.get("contributionsCollection") or {}
    contribution_years = (cu.get("contributionYears") or {}).get("contributionYears") or []
    pinned_repos = [
        n["nameWithOwner"] for n in ((cu.get("pinnedItems") or {}).get("nodes") or [])
        if n and isinstance(n.get("nameWithOwner"), str)
    ]
    contrib_repos = _fetch_contrib_repos_by_year(login, contribution_years)
    organizations = _fetch_organizations(login)
    merged_pr_count = (cu.get("mergedPRs") or {}).get("totalCount") or 0
    total_pr_count = (cu.get("allPRs") or {}).get("totalCount") or 0
    closed_breakdown = compute_closed_pr_breakdown(
        (cu.get("closedPRs") or {}).get("nodes") or [],
        (cu.get("closedPRs") or {}).get("totalCount") or 0,
        login_lower,
    )
    issues_created = (cu.get("issues") or {}).get("totalCount") or 0
    decided_pr_count = merged_pr_count + closed_breakdown["maintainer_closed_unmerged_pr_count"]
    pr_rejection_rate = (
        _math_round((closed_breakdown["maintainer_closed_unmerged_pr_count"] / decided_pr_count) * 100) / 100
        if decided_pr_count > 0 else 0
    )

    created = _parse_ts(user.get("created_at"))
    day_ms = 1000 * 60 * 60 * 24
    account_age_years = (
        _math_round(((_ms(now) - _ms(created)) / day_ms / 365.25) * 100) / 100 if created else 0.0
    )

    last_push: Optional[datetime] = None
    for r in repos:
        ts = _parse_ts(r.get("pushed_at"))
        if ts and (last_push is None or ts > last_push):
            last_push = ts
    days_since_active = math.floor((_ms(now) - _ms(last_push)) / day_ms) if last_push else None

    followers = user.get("followers") or 0
    following = user.get("following") or 0

    last_year_contributions = (cc.get("contributionCalendar") or {}).get("totalContributions") or 0
    activity_types = sum(
        1 for k in (
            "totalCommitContributions", "totalPullRequestContributions",
            "totalIssueContributions", "totalPullRequestReviewContributions",
        ) if (cc.get(k) or 0) > 0
    ) if cc else 0

    personal_original_repos = [_repo_to_top_repo(r, login) for r in original]
    attributed_original_repos = (
        _collect_attributed_original_repos(contrib_repos, organizations, pinned_repos, login_lower, user.get("html_url"))
        if contrib_repos else []
    )
    dedup: Dict[str, Dict[str, Any]] = {}
    for repo in [*personal_original_repos, *attributed_original_repos]:
        key = repo.get("name_with_owner") or f"{repo.get('owner_login') or login}/{repo['name']}"
        dedup[key] = repo
    scored_original_repos = list(dedup.values())
    attributed_original_repo_names = [_repo_display_name(r) for r in attributed_original_repos]
    attributed_original_repo_stars = sum(r.get("stars") or 0 for r in attributed_original_repos)
    scored_nonempty_original_repos = [r for r in scored_original_repos if (r.get("size") or 0) > 0]

    top_repos = sorted(scored_original_repos, key=lambda r: r["stars"], reverse=True)[:10]

    for repo in top_repos[:6]:
        owner = repo.get("owner_login") or login
        readme = _fetch_readme_document(owner, repo["name"])
        languages = _fetch_repo_languages(owner, repo["name"])
        repo["readme"] = readme
        repo["readme_excerpt"] = readme["features"]["prompt_summary"] if readme else None
        repo["languages"] = languages

    best_original_quality = best_original_repo_quality(top_repos, login_lower, now)
    top_starred_original_quality = top_starred_original_repo_quality(top_repos, login_lower, now)

    recent_pr_window = _fetch_recent_prs(login, 100)
    recent_prs = recent_pr_window[:50]
    trivial_prs = sum(1 for p in recent_prs if p["trivial"])
    doc_like_pr_count = sum(1 for p in recent_prs if is_doc_like_impact_pr(p))
    doc_like_pr_ratio = _math_round((doc_like_pr_count / len(recent_prs)) * 100) / 100 if recent_prs else 0
    recent_external_prs = [p for p in recent_prs if not _is_own_repo_name(p.get("repo"), login_lower)]
    external_doc_like_pr_count = sum(1 for p in recent_external_prs if is_doc_like_impact_pr(p))
    external_doc_like_pr_ratio = (
        _math_round((external_doc_like_pr_count / len(recent_external_prs)) * 100) / 100
        if recent_external_prs else 0
    )

    flood = compute_flood_signals(_fetch_recent_all_prs(login), login_lower)

    if contrib_repos:
        impact = compute_impact_from_contrib_map(contrib_repos, login_lower)
    else:
        impact_prs = [p for p in recent_prs if is_ecosystem_impact_pr(p, login_lower)]
        impact = {
            "max_impact_repo_stars": max((p["repo_stars"] for p in impact_prs), default=0),
            "impact_depth_raw": _math_round(sum(log_ratio(p["repo_stars"], 5000) for p in impact_prs) * 100) / 100,
            "impact_repo_count": len(impact_prs),
            "impact_commit_count": 0,
            "impact_pr_count": len(impact_prs),
            "impact_repos": [],
        }
    impact_quality = compute_impact_quality_signals(recent_pr_window, impact["impact_pr_count"], login_lower)
    verified_impact_prs = [
        {**p, "title": (p["title"][:200] if p.get("title") else None), "files": (p.get("files") or [])[:20]}
        for p in recent_pr_window if is_ecosystem_impact_pr(p, login_lower)
    ][:12]
    impact = {**impact, **impact_quality}
    max_impact_repo_stars = impact["max_impact_repo_stars"]
    impact_depth_raw = impact["impact_depth_raw"]

    external_trivial_pr_count = sum(1 for p in recent_prs if is_external_trivial_farm_pr(p, login_lower))

    star_inflation_suspect = False
    if len(top_repos) > 0 and top_repos[0]["stars"] >= 100:
        top = top_repos[0]
        forks_per_100 = top["forks"] / (top["stars"] / 100)
        if forks_per_100 < 1.0 and top["open_issues"] <= 1:
            star_inflation_suspect = True

    metrics: Dict[str, Any] = {
        "username": login,
        "profile_url": user.get("html_url"),
        "avatar_url": user.get("avatar_url"),
        "name": user.get("name"),
        "bio": user.get("bio"),
        "company": user.get("company"),
        "account_age_years": account_age_years,
        "created_at": user.get("created_at"),
        "followers": followers,
        "following": following,
        "public_repos": user.get("public_repos") or 0,
        "fetched_repo_count": len(repos),
        "original_repo_count": len(original) + len(attributed_original_repos),
        "nonempty_original_repo_count": len(nonempty_original) + sum(1 for r in scored_nonempty_original_repos if r.get("attributed_original")),
        "fork_repo_count": len(forks),
        "empty_original_repo_count": len(empty),
        "total_stars": sum(r.get("stars") or 0 for r in scored_original_repos),
        "max_stars": max((r.get("stars") or 0 for r in scored_original_repos), default=0),
        "attributed_original_repo_count": len(attributed_original_repos),
        "attributed_original_repo_stars": attributed_original_repo_stars,
        "attributed_original_repos": attributed_original_repo_names,
        "best_original_repo_quality_score": best_original_quality["score"],
        "best_original_repo_quality_repo": best_original_quality["repo"],
        "top_starred_original_repo_quality_score": top_starred_original_quality["score"],
        "top_starred_original_repo_quality_repo": top_starred_original_quality["repo"],
        "merged_pr_count": merged_pr_count,
        "total_pr_count": total_pr_count,
        "issues_created": issues_created,
        "last_year_contributions": last_year_contributions,
        "activity_type_count": activity_types,
        "contribution_years_active": bounded_contribution_years_active(contribution_years, user.get("created_at"), now),
        "days_since_last_activity": days_since_active,
        "recent_merged_pr_sample": len(recent_prs),
        "recent_trivial_pr_count": trivial_prs,
        "recent_doc_like_pr_count": doc_like_pr_count,
        "recent_doc_like_pr_ratio": doc_like_pr_ratio,
        "recent_external_pr_sample": len(recent_external_prs),
        "recent_external_doc_like_pr_count": external_doc_like_pr_count,
        "recent_external_doc_like_pr_ratio": external_doc_like_pr_ratio,
        "max_impact_repo_stars": max_impact_repo_stars,
        "impact_pr_count": impact["impact_pr_count"],
        "impact_depth_raw": impact_depth_raw,
        "impact_quality_cap": impact["impact_quality_cap"],
        "verified_impact_pr_count": impact["verified_impact_pr_count"],
        "core_impact_pr_count": impact["core_impact_pr_count"],
        "doc_like_impact_pr_count": impact["doc_like_impact_pr_count"],
        "unverified_impact_pr_count": impact["unverified_impact_pr_count"],
        "impact_repo_count": impact["impact_repo_count"],
        "impact_commit_count": impact["impact_commit_count"],
        "external_trivial_pr_count": external_trivial_pr_count,
        "star_inflation_suspect": star_inflation_suspect,
        "closed_unmerged_pr_count": closed_breakdown["closed_unmerged_pr_count"],
        "maintainer_closed_unmerged_pr_count": closed_breakdown["maintainer_closed_unmerged_pr_count"],
        "self_closed_external_pr_count": closed_breakdown["self_closed_external_pr_count"],
        "self_closed_own_repo_pr_count": closed_breakdown["self_closed_own_repo_pr_count"],
        "unknown_closed_unmerged_pr_count": closed_breakdown["unknown_closed_unmerged_pr_count"],
        "pr_rejection_rate": pr_rejection_rate,
        "recent_pr_sample": flood["recent_pr_sample"],
        "top_repo_pr_target": flood["top_repo_pr_target"],
        "top_repo_pr_share": flood["top_repo_pr_share"],
        "templated_pr_ratio": flood["templated_pr_ratio"],
        "pr_flood_suspect": flood["pr_flood_suspect"],
    }

    return {
        "metrics": metrics,
        "top_repos": top_repos,
        "recent_prs": recent_prs,
        "flood_pr_titles": flood["flood_pr_titles"],
        "impact_repos": impact["impact_repos"],
        "verified_impact_prs": verified_impact_prs,
        "pinned_repos": pinned_repos,
        "organizations": organizations,
    }
