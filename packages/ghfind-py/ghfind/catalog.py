"""Machine-readable catalog of ghfind's atomic capabilities.

Mirrors the JS SDK catalog and /openapi.json so an agent can introspect what the
SDK does — including whether a capability is deterministic or uses an LLM.
"""

from __future__ import annotations

from typing import List, TypedDict

DEFAULT_HOST = "https://ghfind.com"


class Capability(TypedDict):
    method: str
    api: List[str]
    summary: str
    llm: bool
    response_semantics: str
    agent_guidance: str


CATALOG: List[Capability] = [
    {
        "method": "get_score",
        "api": ["GET /api/score/{username}"],
        "summary": "Fetch the deterministic score for any GitHub account.",
        "llm": False,
        "response_semantics": (
            "Factual score payload: final_score, tier, sub_scores, percentile. Never calls an "
            "LLM. Indexed accounts return stored data (source indexed); unseen accounts are "
            "admitted to the Go quick-scan worker path (source quick, coverage quick, includes "
            "red_flags). Compatible old stored scores may return source legacy_v5_v5_v3 with "
            "stale true. 404 only if the GitHub login does not exist."
        ),
        "agent_guidance": "Preferred first call — works even for accounts never seen before. Use scan() when you also need full metrics.",
    },
    {
        "method": "get_github_user / user_exists",
        "api": ["GET https://api.github.com/users/{username}"],
        "summary": "Confirm a GitHub account exists (client-side, via GitHub's own API).",
        "llm": False,
        "response_semantics": (
            "Basic public GitHub profile, or None if the login does not exist. Runs on the "
            "caller's IP/quota, NOT ghfind's. No token needed (optional token raises the anon limit)."
        ),
        "agent_guidance": (
            "Validate a handle before spending a scoring call. Pass verify_exists=True to "
            "scan()/get_score() to do this automatically and fail fast on typos."
        ),
    },
    {
        "method": "scan",
        "api": ["POST /api/scan"],
        "summary": "Crawl GitHub and compute the full deterministic scan + score.",
        "llm": False,
        "response_semantics": "Authoritative factual payload: metrics, signals, sub_scores, red_flags, final_score.",
        "agent_guidance": "Use for full evidence or your own analysis. Source of truth for scoring facts.",
    },
    {
        "method": "score",
        "api": ["POST /api/scan"],
        "summary": "Compact scoring block derived from scan().",
        "llm": False,
        "response_semantics": "Just the scoring object (numeric score, tier, sub_scores, red_flags).",
        "agent_guidance": "Use when you only need the numbers.",
    },
    {
        "method": "roast",
        "api": ["POST /api/scan", "POST /api/roast"],
        "summary": "Generate the human-facing roast report + AI-adjusted score.",
        "llm": True,
        "response_semantics": "Presentation report: markdown, tags, roast_line, meta. LLM may adjust score by ±10.",
        "agent_guidance": "Only for the human-facing report. Use scan/score/get_score for facts. Pass byo_key for your own model.",
    },
    {
        "method": "vs",
        "api": ["POST /api/vs-verdict"],
        "summary": "Head-to-head verdict for two scored accounts.",
        "llm": True,
        "response_semantics": "Winner + bucket are deterministic; verdict/advice prose is LLM and may be null.",
        "agent_guidance": "Both accounts must already be scored. Winner is reliable even when prose is null.",
    },
    {
        "method": "leaderboard",
        "api": ["GET /api/leaderboard"],
        "summary": "Ranked public profiles (Hall of Fame / trending / heat / progress).",
        "llm": False,
        "response_semantics": "Cached ranking/discovery entries.",
        "agent_guidance": "Use to discover candidates. For a specific user, call scan/score/get_score.",
    },
    {
        "method": "developers",
        "api": ["GET /api/developers"],
        "summary": "Discover developers by language, organization, or contributed repo.",
        "llm": False,
        "response_semantics": "Cached discovery categories or entries for a facet.",
        "agent_guidance": "Use to find candidates by facet. Verify a specific account afterward.",
    },
    {
        "method": "search_users",
        "api": ["GET /api/search-users"],
        "summary": "Prefix autocomplete over scored accounts.",
        "llm": False,
        "response_semantics": "Up to 6 matching scored users.",
        "agent_guidance": "Use to resolve a partial handle.",
    },
    {
        "method": "stats",
        "api": ["GET /api/stats"],
        "summary": "Platform totals (number of scored accounts).",
        "llm": False,
        "response_semantics": "Aggregate metadata, not a per-user source.",
        "agent_guidance": "Platform overview only.",
    },
    {
        "method": "badge_url / card_url / vs_card_url",
        "api": ["GET /api/badge/{username}", "GET /api/card/{username}", "GET /api/card/vs/{a}/{b}"],
        "summary": "Build image URLs (SVG badge, OG PNG cards). Pure — no request.",
        "llm": False,
        "response_semantics": "Returns a URL string.",
        "agent_guidance": "Embed a badge in a README or a card in a share preview.",
    },
]


def find_capability(method: str) -> "Capability | None":
    for c in CATALOG:
        if c["method"] == method:
            return c
    return None
