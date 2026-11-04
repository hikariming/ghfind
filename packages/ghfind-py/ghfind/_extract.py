"""Pure GitHub evidence -> RawMetrics derivation (Python port).

Mirrors the public ``@ghfind/scoring`` ``extract`` module: impact attribution,
community, star weighting, content-skill and quality signals computed from
evidence that has already been collected. It performs no network, token or
environment access — collection is done by the ghfind service, and the SDK only
verifies the published scores (see ``ghfind.local``).
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from ._co_creator import co_creator_share, project_share, RECENT_MAINTENANCE_DAYS
from ._presentation import pr_presentation_share, UI_LIBRARY
from ._score import log_ratio

README_PROMPT_SUMMARY_LIMIT = 1500

IMPACT_COMMIT_MIN = 2
PRESTIGE_COMMIT_FULL_AT = 10
PRESTIGE_MERGED_PR_FULL_AT = 3
# ``commitContributionsByRepository`` only reports commits after they land on
# the upstream default branch (or gh-pages). This is sufficient landing evidence
# for canonical projects whose official flow does not mark a GitHub PR MERGED.
SINGLE_DEFAULT_BRANCH_COMMIT_IMPACT_REPOS = {"git/git"}
ORG_ATTRIBUTED_MIN_SCORE = 5
ORG_ATTRIBUTED_COMMIT_MIN = 50
ORG_ATTRIBUTED_MIXED_COMMIT_MIN = 20
ORG_ATTRIBUTED_MIXED_PR_MIN = 10
ORG_ATTRIBUTED_ACTIVE_YEAR_MIN = 2


def _math_round(x: float) -> int:
    return math.floor(x + 0.5)


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


# A "notes"/"learning" keyword is weak evidence once a substantive repo has real
# organic traction (many stars backed by a healthy fork share); mirrors
# hasOrganicProjectTraction in src/lib/github.ts.
PLACEHOLDER_TRACTION_MIN_STARS = 500
PLACEHOLDER_TRACTION_MIN_FORK_RATIO = 0.03
PLACEHOLDER_TRACTION_MULTIPLIER = 0.75


def _has_organic_project_traction(repo: Dict[str, Any]) -> bool:
    stars = repo.get("stars") or 0
    forks = repo.get("forks") or 0
    return stars >= PLACEHOLDER_TRACTION_MIN_STARS and forks >= stars * PLACEHOLDER_TRACTION_MIN_FORK_RATIO


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
        if readme_len >= 600 and repo["size"] >= 200:
            s *= PLACEHOLDER_TRACTION_MULTIPLIER if _has_organic_project_traction(repo) else 0.55
        else:
            s *= 0.25

    return _math_round(max(0.0, min(s, 1)) * 100) / 100


def best_original_repo_quality(repos: List[Dict[str, Any]], login_lower: str, now: datetime) -> Dict[str, Any]:
    best = {"score": 0, "repo": None}
    for repo in repos:
        sc = original_repo_quality_score(repo, login_lower, now)*project_share(repo)
        if sc > best["score"]:
            best = {"score": sc, "repo": _repo_display_name(repo)}
    return best


_CONTENT_NAME = re.compile(r"(^|[-_.])(datasets?|awesome|papers?|books?|cheat-?sheets?|prompts?|skills?|handbooks?|playbooks?)([-_.]|$)", re.I)
_CONTENT_TOPIC = re.compile(r"^(datasets?|awesome|awesome-lists?|books?|courses?|tutorials?|notes|docs|documentation|papers?|cheatsheets?|prompts?|skills?|agent-skills?|handbooks?|playbooks?)$", re.I)
_NON_CODE = {"asciidoc", "html", "markdown", "mdx", "restructuredtext", "rst", "plain text", "rich text format", "roff", "tex", "text"}


def content_skill_share(repo):
    named = bool(_CONTENT_NAME.search(repo["name"]) or any(_CONTENT_TOPIC.search(t) for t in repo.get("topics", [])))
    languages = repo.get("languages") or []
    total = sum(max(0, l["size"]) for l in languages)
    non_code = sum(max(0, l["size"]) for l in languages if l["name"].lower() in _NON_CODE)
    prose = non_code / total if total > 0 else 0
    naming = 0.55 * (0.2 + 0.8 * prose if total > 0 else 1) if named else 0
    paths = [p.lower() for p in repo.get("root_paths") or []]
    if not paths:
        return 1 - (1-prose)*(1-naming)
    markdown = max(0,sum(bool(re.search(r"\.(md|mdx|rst|adoc|txt)$", p)) for p in paths)-1)/len(paths)
    skill = any(p in {"skill.md", "skills", "prompts", ".claude"} for p in paths)
    layout = 1-(1-.75*markdown)*(1-(.65 if skill else 0))
    application = any(p in {"src", "app", "lib", "cmd", "crates", "packages", "backend", "frontend", "server", "client", "api", "core", "include", "sources"} or re.search(r"\.(go|rs|py|ts|tsx|js|jsx|java|kt|cs|cpp|cc|c|swift)$",p) for p in paths)
    protection = 1-.85*(1-prose) if application and total > 0 else 1
    return (1-(1-prose)*(1-(.55 if named else 0))*(1-layout))*protection


def content_skill_signals(repos):
    stars = content = evidence = 0
    for repo in repos:
        weight = max(0, repo["stars"]) * project_share(repo)
        stars += weight
        content += weight * content_skill_share(repo)
        evidence += weight * (1 if repo.get("root_paths") or any(l["size"] > 0 for l in repo.get("languages") or []) else 0.5)
    return dict(content_skill_star_share=content/stars if stars else 0, content_skill_confidence=evidence/stars if stars else 0)


def original_repo_star_weight(repo, now):
    pushed = _parse_ts(repo.get("pushed_at"))
    months = max(0, (_ms(now)-_ms(pushed))/((365.25/12)*24*60*60*1000)) if pushed else 0
    liveness = 1 - 0.5 * min(max((months-12)/24, 0), 1)
    share = content_skill_share(repo)
    return liveness * (1 - 0.75*share*share*(3-2*share))


def weighted_original_stars(repos, now):
    weights = [max(0,r["stars"])*project_share(r)*original_repo_star_weight(r,now) for r in repos]
    return dict(weighted_total_stars=math.floor(sum(weights)*100+0.5)/100, weighted_max_stars=math.floor(max(weights,default=0)*100+0.5)/100)


def top_starred_original_repo_quality(repos: List[Dict[str, Any]], login_lower: str, now: datetime) -> Dict[str, Any]:
    starred = [r for r in repos if r["stars"] > 0]
    if not starred:
        return {"score": 0, "repo": None}
    top = sorted(starred, key=lambda r: r["stars"]*project_share(r), reverse=True)[0]
    # Stars are already weighted by share; multiplying quality by the share
    # again double-counts attribution (mirrors TS/Go).
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


def _maintainer_text_matches_user(text: str, login_lower: str, profile_url: Optional[str]) -> bool:
    lower = text.lower()
    if re.search(r"(^|[^a-z0-9-])@?" + re.escape(login_lower) + r"([^a-z0-9-]|$)", lower):
        return True
    if profile_url and profile_url.lower() in lower:
        return True
    return f"github.com/{login_lower}" in lower


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
        **({"attribution_share":attribution["share"],"co_creator_facts":attribution["facts"]} if attribution and "share" in attribution else {}),
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


def is_ecosystem_impact_pr(pr: Dict[str, Any], login_lower: str, repos=None) -> bool:
    repo = pr.get("repo") or ""
    owner = repo.split("/")[0].lower() if "/" in repo else ""
    from ._community import is_own_impact_repo, has_attributed_creator_star_credit
    if not owner or owner == login_lower or pr['trivial']:
        return False
    for r in repos or []:
        if r['repo'].lower() == repo.lower() and is_own_impact_repo(r, login_lower):
            return has_attributed_creator_star_credit(r, login_lower) and _passes_impact_repo_gates(r, login_lower) and (r['stars'] >= 5000 or not _is_doc_or_resource_repo(r))
    return pr['repo_stars'] >= 200


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


def _is_core_code_path(path: str, ui_library=False) -> bool:
    p = path.lower()
    if _is_doc_like_path(p) or _is_presentation_only_path(p, ui_library):
        return False
    return bool((ui_library and re.search(r"\.(css|scss|sass|less|styl)$",p)) or re.search(r"\.(c|cc|cpp|cs|go|java|js|jsx|kt|m|mm|php|py|rb|rs|scala|swift|ts|tsx)$", p, re.I))


def _is_presentation_only_path(path: str, ui_library=False) -> bool:
    p = path.lower()
    if ui_library and re.search(r"\.(css|scss|sass|less|styl)$",p):
        return False
    return bool(
        re.search(r"\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp)$", p, re.I)
        or re.search(r"(^|/)(__snapshots__|demo|demos|examples?|templates?|storybook|screenshots?|assets?|public)(/|$)", p)
        or re.search(r"(^|/)(site|website|docs?|pages/home|components/homepage)(/|$)", p)
    )


def is_doc_like_impact_pr(pr: Dict[str, Any]) -> bool:
    share = pr_presentation_share(pr)
    if share is not None:
        return share >= .6
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
    ui_library = bool(UI_LIBRARY.search(pr.get("repo") or ""))
    doc_like = sum(1 for f in files if _is_doc_like_path(f) or _is_presentation_only_path(f, ui_library))
    core_code = sum(1 for f in files if _is_core_code_path(f, ui_library))
    return doc_like > 0 and (core_code == 0 or doc_like / len(files) >= 0.6)


def compute_impact_quality_signals(recent_prs: List[Dict[str, Any]], impact_pr_count: int, login_lower: str, repos=None) -> Dict[str, Any]:
    verified = [p for p in recent_prs if is_ecosystem_impact_pr(p, login_lower, repos)]
    doc_like_count = sum(1 for p in verified if is_doc_like_impact_pr(p))
    core_count = len(verified) - doc_like_count
    unverified = max(0, impact_pr_count - len(verified))
    repo_counts: Dict[str, int] = {}
    for pr in verified:
        repo = pr["repo"].lower()
        repo_counts[repo] = repo_counts.get(repo, 0) + 1
    representative = (
        len(verified) >= 10
        and len(repo_counts) >= 3
        and max(repo_counts.values(), default=0) <= len(verified) / 2
        and len(verified) >= impact_pr_count / 2
    )
    cap = _low_quality_impact_cap(len(verified), doc_like_count, core_count, impact_pr_count) if representative else None
    return {
        "verified_impact_pr_count": len(verified),
        "core_impact_pr_count": core_count,
        "doc_like_impact_pr_count": doc_like_count,
        "unverified_impact_pr_count": unverified,
        "impact_quality_cap": cap,
    }


def _low_quality_impact_cap(verified_count: int, doc_like_count: int, core_count: int, impact_pr_count: int) -> Optional[float]:
    if verified_count <= 0 or doc_like_count <= core_count:
        return None
    dominance = (doc_like_count - core_count) / verified_count
    confidence = math.sqrt(
        log_ratio(verified_count, 10)
        * log_ratio(max(impact_pr_count, verified_count), 10)
    )
    severity = max(0.0, min(1.0, dominance * confidence))
    cap = 20 - severity * 36
    return _math_round(max(4.0, min(20.0, cap)) * 10) / 10


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


def first_commit_history_after(tip_oid: str, total_count: int) -> Optional[str]:
    if total_count < 2 or not tip_oid:
        return None
    return f"{tip_oid} {total_count - 2}"


def parse_github_noreply_login(email: Optional[str]) -> Optional[str]:
    if not email:
        return None
    plus = re.match(r"^(\d+)\+([A-Za-z0-9-]+)@users\.noreply\.github\.com$", email, re.I)
    if plus:
        return plus.group(2)
    plain = re.match(r"^([A-Za-z0-9-]+)@users\.noreply\.github\.com$", email, re.I)
    return plain.group(1) if plain else None


def resolve_first_commit_github_login(
    author_login: Optional[str] = None,
    committer_login: Optional[str] = None,
    author_email: Optional[str] = None,
    committer_email: Optional[str] = None,
) -> Dict[str, Optional[str]]:
    author = (author_login or "").strip() or None
    if author:
        return {"login": author, "source": "author.user"}
    committer = (committer_login or "").strip() or None
    if committer:
        return {"login": committer, "source": "committer.user"}
    from_email = parse_github_noreply_login(author_email) or parse_github_noreply_login(committer_email)
    if from_email:
        return {"login": from_email, "source": "noreply-email"}
    return {"login": None, "source": "none"}


def _is_public_org_member(owner_login: str, organizations: List[str]) -> bool:
    owner = owner_login.lower()
    return any(organization.lower() == owner for organization in organizations)


def _is_org_owned_long_term_candidate(repo: Dict[str, Any], login_lower: str) -> bool:
    if repo["is_private"] or repo["is_fork"]:
        return False
    if repo["owner_login"].lower() == login_lower:
        return False
    if _is_doc_like_repo(repo["repo"]):
        return False
    return repo["commits"]+repo["prs"]>0


def compute_org_repo_attribution(
    repo: Dict[str, Any], organizations: List[str], pinned_repos: Optional[List[str]] = None,
    release_or_tag_author_hit: bool = False, maintainer_file_hit: bool = False,
    scored_login: Optional[str] = None, first_commit_login: Optional[str] = None, facts=None,
) -> Optional[Dict[str, Any]]:
    owner = repo["owner_login"].lower()
    orgs = {o.lower() for o in organizations}
    member = owner in orgs
    scored = (scored_login or "").strip().lower()
    first_login = (first_commit_login or "").strip().lower()
    first_commit_match = len(scored) > 0 and first_login == scored
    if facts is not None:
        if owner==scored or repo['is_private'] or repo['is_fork'] or _is_doc_or_resource_repo(repo):
            return None
        f={**facts,'first_author':first_commit_match,'release_author':release_or_tag_author_hit,'maintainer_file':maintainer_file_hit,'pinned':any(r.lower()==repo['repo'].lower() for r in (pinned_repos or []))}
        if not f.get('association') and member:
            f['association']='MEMBER'
        share=co_creator_share(f)
        if share<=0:
            return None
        evidence=[f"{f['user_commits']}/{f['total_commits']} commits; leader {f['leading_commits']}",f"{f['user_merged_prs']}/{f['total_merged_prs']} merged PRs; {f['active_years']} active years",f"{round(f['core_churn'])} core lines in {f['samples']} complete samples"]
        if f.get('recent_total_commits') is not None:
            evidence.append(f"{f.get('recent_user_commits') or 0}/{f['recent_total_commits']} commits in the last {RECENT_MAINTENANCE_DAYS} days")
        if f.get('recent_total_merged_prs') is not None:
            evidence.append(f"{f.get('recent_user_merged_prs') or 0}/{f['recent_total_merged_prs']} merged PRs in the last {RECENT_MAINTENANCE_DAYS} days")
        if f.get('reviewed_prs'):
            evidence.append(f"reviewed {f['reviewed_prs']} PRs by others")
        if first_commit_match: evidence.append(f'first commit author is {scored}')
        if release_or_tag_author_hit: evidence.append('release/tag author')
        if maintainer_file_hit: evidence.append('listed in maintainer/codeowner docs')
        if f.get('association'): evidence.append('author association '+f['association'])
        return dict(repo=repo['repo'],score=share,share=share,facts=f,evidence=evidence)
    if not member and not first_commit_match:
        return None
    if repo["is_private"] or repo["is_fork"]:
        return None
    if _is_doc_like_repo(repo["repo"]):
        return None
    if not _has_strong_long_term_org_contribution(repo):
        return None
    evidence = [
        f"org member of {repo['owner_login']}" if member else f"first commit author is {first_commit_login}",
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


def _is_doc_or_resource_repo(r):
    return _is_doc_like_repo(r['repo']) or any(re.match(r'^(awesome|awesome-lists?|courses?|tutorials?|notes|docs|documentation)$', t, re.I) for t in r.get('topics', []))


def _passes_impact_repo_gates(r, login):
    from ._community import is_own_impact_repo, impact_evidence_weight
    if r['is_private'] or r['is_fork']:
        return False
    if _is_low_signal_entry_repo(r['repo']) and r['commits'] <= 1 and r['prs'] <= 1:
        return False
    threshold = 0 if is_own_impact_repo(r, login) else 200
    if is_own_impact_repo(r, login) and (r['stars'] <= 0 or (r.get('community', 0) <= 0 and impact_evidence_weight(r) <= 0)):
        return False
    commit_min = 1 if r['repo'].strip().lower() in SINGLE_DEFAULT_BRANCH_COMMIT_IMPACT_REPOS else IMPACT_COMMIT_MIN
    return r['stars'] >= threshold and (r['commits'] >= commit_min or r['prs'] >= 1)


def compute_impact_from_contrib_map(repos: List[Dict[str, Any]], login_lower: str) -> Dict[str, Any]:
    from ._community import is_own_impact_repo, has_attributed_creator_star_credit, impact_evidence_weight, attributed_creator_weight, own_star_weight, impact_star_discount
    from ._score import star_engagement_multiplier
    qualifying = [r for r in repos if _passes_impact_repo_gates(r, login_lower) and
                  (r['stars'] >= 5000 or not _is_doc_or_resource_repo(r))]
    max_impact_repo_stars = max((r['stars'] for r in qualifying), default=0)
    prestige, depth_sum = 0.0, 0.0
    for r in qualifying:
        authored = max(0, r['commits'] - max(0, r.get('merge_commits', 0)))
        sample = r.get('pr_sample', 0)
        share = .7
        if sample > 0:
            observed = max(0, min(r.get('code_pr_sample', 0) / sample, 1))
            coverage = min(1, sample / min(10, max(r['prs'], authored, 1)))
            share = coverage * observed + (1 - coverage) * share
        months = len(r.get('months', []))
        doc_weight = .5 if _is_doc_or_resource_repo(r) else 1
        repo_weight = doc_weight * (.3 + .7 * share) * (.7 + .3 * min(months / 6, 1) if months else 1)
        own = is_own_impact_repo(r, login_lower)
        work_multiplier = prestige_work_multiplier(authored, r['prs'])
        base = (r.get('community', 0) if own else log_ratio(r['stars'], 100000)) * work_multiplier * repo_weight
        repo_prestige = base
        historical = has_attributed_creator_star_credit(r, login_lower)
        if historical:
            repo_prestige = base + attributed_creator_weight(r, login_lower) * max(0, log_ratio(r['stars'], 100000) * work_multiplier * doc_weight - base)
        attribution_share=project_share(r)
        prestige=max(prestige,attribution_share*repo_prestige+(1-attribution_share)*(log_ratio(r['stars'],100000)*work_multiplier*repo_weight if r['stars']>=200 else 0))
        work = authored + r['prs']
        weight = min(1 + math.log10(work), 2.5) if work > 0 else 0
        if own:
            star_depth = log_ratio(r['stars'], 5000) * weight * repo_weight * .3 * star_engagement_multiplier(r.get('engagement')) * own_star_weight(r['stars']) * impact_evidence_weight(r) * impact_star_discount(r)
            depth = star_depth + 2.5 * r.get('community', 0) * repo_weight
            if historical:
                depth += attributed_creator_weight(r, login_lower) * max(0, log_ratio(r['stars'], 5000) * weight * doc_weight - depth)
        else:
            depth = log_ratio(r['stars'], 5000) * weight * repo_weight
        depth_sum += attribution_share*depth+(1-attribution_share)*(log_ratio(r['stars'],5000)*weight*repo_weight if r['stars']>=200 else 0)
    impact_prestige_score = _math_round(prestige * 10000) / 10000
    impact_depth_raw = _math_round(depth_sum * 100) / 100

    by_stars = sorted(qualifying, key=lambda r: r["stars"], reverse=True)[:6]
    by_work = sorted(
        qualifying,
        key=lambda r: (r["prs"] * 4 + r["commits"], r["stars"]),
        reverse=True,
    )[:8]
    seen = set()
    impact_repos = []
    for r in by_stars + by_work:
        if r["repo"] in seen:
            continue
        seen.add(r["repo"])
        impact_repos.append(
            {"repo": r["repo"], "stars": r["stars"], "commits": r["commits"], "prs": r["prs"]}
        )
        if len(impact_repos) >= 12:
            break
    return {
        "max_impact_repo_stars": max_impact_repo_stars,
        "impact_prestige_score": impact_prestige_score,
        "impact_depth_raw": impact_depth_raw,
        "impact_repo_count": len(qualifying),
        "impact_commit_count": sum(r["commits"] for r in qualifying),
        "impact_pr_count": sum(r["prs"] for r in qualifying),
        "impact_repos": impact_repos,
    }


def prestige_work_multiplier(commits: int, prs: int) -> float:
    commit_signal = max(0, commits) / PRESTIGE_COMMIT_FULL_AT
    pr_signal = max(0, prs) / PRESTIGE_MERGED_PR_FULL_AT
    work_signal = max(commit_signal, pr_signal)
    if work_signal <= 0:
        return 0.0
    if work_signal >= 1:
        return 1.0
    return math.log10(1 + work_signal * 9) / math.log10(10)


# --- async-equivalent fetchers ---------------------------------------------


def _recent_pr_from_node(n):
    repo = n.get("repository")
    churn = (n.get("additions") or 0) + (n.get("deletions") or 0)
    files = ((n.get("files") or {}).get("nodes") or [])
    pr = {
        "title": n.get("title"),
        "repo": repo.get("nameWithOwner") if repo else None,
        "repo_stars": repo.get("stargazerCount") if repo else 0,
        "churn": churn,
        "changed_files": n.get("changedFiles") or 0,
        "trivial": churn <= 5,
        "files": [f["path"] for f in files if f.get("path")],
        "file_changes": [f for f in files if f.get("path") and f.get("additions") is not None and f.get("deletions") is not None],
    }
    share = pr_presentation_share(pr)
    if share is not None:
        pr["presentation_share"] = share
    return pr


def impact_code_sample(prs):
    sample = prs[:10]
    code = 0
    for pr in sample:
        share = pr_presentation_share(pr)
        code += 1-share if share is not None else int(not is_doc_like_impact_pr(pr))
    return dict(pr_sample=len(sample), code_pr_sample=code)

