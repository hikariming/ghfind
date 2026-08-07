"""Typed shapes for the ghfind API contract.

Keys are snake_case to mirror the canonical scoring output (identical to the
open-source ``github-account-value`` skill and the website's ``src/lib/types.ts``),
so the JSON is byte-for-byte compatible across the site, SDKs, and CLIs.

Methods return plain ``dict`` payloads; these ``TypedDict``s document their shape
for editors and type checkers. Source of truth:
https://github.com/hikariming/ghfind (src/lib/types.ts).
"""

from __future__ import annotations

from typing import Dict, List, Literal, Optional, TypedDict

Tier = Literal["夯", "顶级", "人上人", "NPC", "拉完了"]
TierKey = Literal["god", "elite", "solid", "npc", "trash"]

TIER_KEY: Dict[str, str] = {
    "夯": "god",
    "顶级": "elite",
    "人上人": "solid",
    "NPC": "npc",
    "拉完了": "trash",
}

SubScoreKey = Literal[
    "account_maturity",
    "original_project_quality",
    "contribution_quality",
    "ecosystem_impact",
    "community_influence",
    "activity_authenticity",
]

SubScores = Dict[str, float]

LeaderboardView = Literal["trending", "score", "heat", "progress"]
LeaderboardWindow = Literal["all", "24h", "7d", "30d"]
DeveloperFacet = Literal["language", "org", "repo"]


class RedFlag(TypedDict):
    flag: str
    penalty: float
    detail: str


class Scoring(TypedDict):
    sub_scores: SubScores
    base_score: float
    red_flags: List[RedFlag]
    total_penalty: float
    final_score: float
    tier: str
    tier_label: str


class ScanResult(TypedDict, total=False):
    metrics: dict
    top_repos: List[dict]
    recent_prs: List[dict]
    flood_pr_titles: List[str]
    impact_repos: List[dict]
    scoring: Scoring


class Percentile(TypedDict):
    beat: Optional[float]
    total: int
    rank: Optional[int]


class Tags(TypedDict):
    zh: List[str]
    en: List[str]


class RoastLine(TypedDict):
    zh: str
    en: str


class ScorePayload(TypedDict, total=False):
    source: str  # "indexed", "quick", or "legacy_v5_v5_v3"
    coverage: str  # "quick" for current Go collection, "legacy" for fallback
    stale: bool  # true only for compatible legacy fallback scores
    cached: bool  # quick path only
    username: str
    display_name: Optional[str]
    avatar_url: Optional[str]
    profile_url: str
    final_score: float
    tier: str
    tier_key: str
    sub_scores: SubScores
    red_flags: List[RedFlag]  # quick path only
    base_score: float  # quick path only
    total_penalty: float  # quick path only
    tags: Optional[Tags]  # null on the quick path
    roast_line: Optional[RoastLine]  # null on the quick path
    percentile: Optional[Percentile]
    scanned_at: int  # indexed path only
    profile: str


class RoastResult(TypedDict):
    meta: Optional[dict]
    report: str
    progress: List[str]


class ByoKey(TypedDict):
    baseURL: str
    apiKey: str
    model: str
